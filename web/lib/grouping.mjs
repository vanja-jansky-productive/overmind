// Smart grouping for the Board view. One host's server (config `grouping.host`, or the
// one with `web.grouping.enabled`) runs `overmind group` over the whole merged overmind on a
// schedule and serves the result as GET /api/groups; every other server proxies there.
//
// The CLI owns the logic and the state file (stable ids, incremental classification,
// hourly consolidation, repo fallback — docs/architecture.md → "Smart grouping"); this
// module only decides *when* to run it and feeds it the merged `/api/overmind` snapshot on
// stdin, so the grouping host needs no ssh to its peers. A run with nothing new costs no
// model call (the CLI checks), so the schedule can be frequent; on top of it a cheap
// check runs the pass early when live sessions show up that no group knows yet.

/** Keys `host/id` of every live session in a `/api/overmind` body (ok hosts only). */
export function liveKeys(overmind) {
  const keys = new Set();
  for (const h of overmind?.hosts ?? []) {
    if (h?.ok === false) continue;
    for (const s of h?.sessions ?? []) {
      const id = s?.session_id || (s?.pid != null ? String(s.pid) : null);
      if (id) keys.add(`${s.host || h.name}/${id}`);
    }
  }
  return keys;
}

/** Keys `host/id` of every member of a `overmind group --json` report. */
export function memberKeys(report) {
  const keys = new Set();
  for (const g of report?.groups ?? []) for (const m of g?.members ?? []) keys.add(`${m.host}/${m.id}`);
  return keys;
}

/** A report's groups, reduced to what the API serves. */
function publicGroups(report) {
  return (report?.groups ?? []).map((g) => ({
    id: String(g.id),
    label: String(g.label),
    description: g.description ?? null,
    source: g.source ?? 'llm',
    // `dormant: true` (only when true): the session is dormant on its host (a reboot left it).
    members: (g.members ?? []).map((m) => ({ host: String(m.host), id: String(m.id), ...(m.dormant === true ? { dormant: true } : {}) })),
  }));
}

export const DISABLED_GROUPS = Object.freeze({
  enabled: false,
  host: null,
  intervalMinutes: null,
  running: false,
  updatedAt: null,
  lastRun: null,
  groups: [],
});

/**
 * @param deps
 *   cli          lib/overmind-cli.mjs instance (`groupRun`, `groupCached`)
 *   getOvermind     () => Promise<overmind body> — a fresh merged overmind (`handleApi.buildOvermind`)
 *   peekOvermind    () => overmind body|null — the warm snapshot, if any (`handleApi.peekOvermind`); the
 *                change check uses only this, so it never causes discovery on its own
 *   self         this host's name (the `host` field of the response)
 *   intervalMs   scheduled run period; checkMs: the "new sessions?" check period
 *   minGapMs     no change-triggered run sooner than this after the last run
 */
export function createGrouper({
  cli,
  getOvermind,
  peekOvermind = () => null,
  self = 'local',
  intervalMs = 10 * 60 * 1000,
  initialDelayMs = 20 * 1000,
  checkMs = 60 * 1000,
  minGapMs = 2 * 60 * 1000,
  log = () => {},
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (!cli || typeof cli.groupRun !== 'function') throw new TypeError('cli.groupRun must be a function');
  if (typeof getOvermind !== 'function') throw new TypeError('getOvermind must be a function');
  let report = null;
  let lastRun = null;
  let inFlight = null;
  let editing = null; // the last board edit (resolves when done, never rejects)
  let timer = null;
  let checker = null;
  let stopped = false;

  async function loadCached() {
    if (typeof cli.groupCached !== 'function') return;
    try {
      const r = await cli.groupCached();
      if (!report) report = r;
      if (!lastRun && r?.lastRun) lastRun = { ...r.lastRun, reason: 'stored' };
    } catch (err) {
      log(`[grouping] no stored groups: ${err?.message ?? err}`);
    }
  }

  function runOnce(reason = 'manual', { refresh = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      if (editing) await editing; // the pass must start from the state an edit just wrote
      const at = now();
      try {
        const overmind = await getOvermind();
        const r = await cli.groupRun({ overmind, refresh });
        report = r;
        const s = r?.lastRun ?? {};
        lastRun = {
          at,
          ms: now() - at,
          ok: s.ok !== false,
          reason,
          mode: s.mode ?? 'noop',
          modelCalls: s.modelCalls ?? 0,
          classified: s.classified ?? 0,
          ...(s.note ? { note: s.note } : {}),
          ...(s.error ? { error: s.error } : {}),
        };
        log(
          `[grouping] ${reason}: ${lastRun.mode}, ${lastRun.classified} classified, ${lastRun.modelCalls} model call(s), ` +
            `${(r?.groups ?? []).length} groups${lastRun.error ? ` (${lastRun.error})` : ''}`,
        );
      } catch (err) {
        lastRun = { at, ms: now() - at, ok: false, reason, mode: 'error', modelCalls: 0, classified: 0, error: err?.message ?? String(err) };
        log(`[grouping] ${reason} failed: ${lastRun.error}`);
      } finally {
        inFlight = null;
      }
      return response();
    })();
    return inFlight;
  }

  /**
   * A change made on the board (`cli.groupEdit`: rename a group, move a session). Waits for a
   * running pass — which would otherwise save over the edit — and edits run one at a time.
   * Resolves the response; throws the CLI's error (`refused: true` = bad id/label).
   */
  function edit(op) {
    if (typeof cli.groupEdit !== 'function') return Promise.reject(new Error('group edits are not available'));
    const job = (async () => {
      await editing;
      await inFlight;
      report = await cli.groupEdit(op);
      log(`[grouping] edit: ${op.op}`);
      return response();
    })();
    editing = job.catch(() => {});
    return job;
  }

  /** Run early when live sessions exist that no group has seen (cheap: no CLI call, no discovery). */
  async function checkChanges() {
    if (inFlight || !report) return false;
    if (lastRun && now() - lastRun.at < minGapMs) return false;
    const overmind = await Promise.resolve(peekOvermind()).catch(() => null);
    if (!overmind) return false; // nobody is watching: the schedule will do
    const known = memberKeys(report);
    const unknown = [...liveKeys(overmind)].filter((k) => !known.has(k));
    if (unknown.length === 0) return false;
    await runOnce('changes');
    return true;
  }

  function schedule(delay) {
    if (stopped) return;
    clearTimer(timer);
    timer = setTimer(async () => {
      await runOnce('scheduled');
      schedule(intervalMs);
    }, delay);
    timer?.unref?.();
  }

  function scheduleCheck() {
    if (stopped || !checkMs) return;
    clearTimer(checker);
    checker = setTimer(async () => {
      await checkChanges().catch(() => {});
      scheduleCheck();
    }, checkMs);
    checker?.unref?.();
  }

  function response() {
    return {
      enabled: true,
      host: self,
      intervalMinutes: Math.round((intervalMs / 60000) * 100) / 100,
      running: Boolean(inFlight),
      updatedAt: report?.updatedAt ?? null,
      lastRun,
      groups: publicGroups(report),
    };
  }

  return {
    async start() {
      stopped = false;
      await loadCached();
      schedule(initialDelayMs);
      scheduleCheck();
    },
    stop() {
      stopped = true;
      clearTimer(timer);
      clearTimer(checker);
    },
    runOnce,
    edit,
    checkChanges,
    response,
    loadCached,
    get lastRun() {
      return lastRun;
    },
  };
}
