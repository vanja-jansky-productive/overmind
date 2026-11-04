import { sortSessions } from './util.mjs';

export const TITLE_MAX = 300;

/** Cap a session title for transport: the first prompt can run to 10 KB, the UI shows one line. */
export function trimTitle(title, max = TITLE_MAX) {
  if (typeof title !== 'string') return title ?? null;
  return title.length > max ? `${title.slice(0, max)}…` : title;
}

/**
 * Every route and view keys a session by `session_id`. A Codex session has none until its first
 * prompt (no transcript yet): it goes by `pid-<pid>` until then. Claude rows always carry one.
 */
export function placeholderId(s) {
  return Number.isInteger(s?.pid) ? `pid-${s.pid}` : null;
}

/**
 * Local session discovery (via the `overmind` CLI, see lib/overmind-cli.mjs). Never throws:
 * failures come back as { ok:false, error }. Concurrent callers share one run.
 *
 * Two ways to decide when the last list is still good:
 * - **TTL** (no watcher, or it is idle / degraded; `OVERMIND_WEB_WATCH=0`): reused for `ttlMs`.
 * - **Validated** (an armed, healthy `watcher` — lib/watch.mjs): reused while nothing changed
 *   and it is < `safetyMs` old. A file signal (`signal('fast'|'slow')`) marks it dirty: the next
 *   caller at or after `dueAt` (the last run's start + that class's gap) runs the CLI. The value
 *   comes back with `fetchedAt` = now (validated now), so a quiet host reads "checked just now".
 *
 * Every `localHost()` call counts as "someone asked": it starts the watcher, and `idleAfterMs`
 * with no call stops it again (an idle server watches nothing).
 *
 * A run that started before the last change (`markDirty`/`invalidate`) is never joined by `force`,
 * nor by any validated caller once that change is due: they chain a new run behind it, so a list
 * that takes longer than the gap cannot serve the change it was asked for.
 */
export function createOvermind({
  cli,
  self = 'local',
  ttlMs = 2000,
  watcher = null,
  safetyMs = 30_000,
  gaps = { fast: 1000, slow: 5000 },
  idleAfterMs = 90_000,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!cli || typeof cli.list !== 'function') throw new TypeError('cli.list must be a function');

  let cached = null; // { at (finished), startedAt, value }
  let inFlight = null; // { promise, gen }
  let gen = 0; // bumped by every change signal: a run started before it cannot clear `dirty`
  let dirty = true; // a watcher signal (or a mutation) since the last complete run
  let stale = false; // a mutation since then (invalidate): honoured in TTL mode too
  let staleGen = 0; // the gen of the last invalidate(): a run started at or after it clears `stale`
  let dueAt = 0;
  let lastRunStartedAt = -Infinity;
  let lastRunGen = -1; // the gen the last run started at
  let lastListAt = null;
  let listRuns = 0;
  let warm = false;
  let lastAsked = 0;
  let idleTimer = null;

  async function discover() {
    const fetchedAt = now();
    try {
      const raw = await cli.list();
      const sessions = sortSessions(raw).map((s) => ({ ...s, session_id: s.session_id ?? placeholderId(s), title: trimTitle(s.title), host: self }));
      return { name: self, ok: true, fetchedAt, sessions };
    } catch (err) {
      return { name: self, ok: false, error: String(err?.message ?? err), fetchedAt, sessions: [] };
    }
  }

  function checkIdle() {
    idleTimer = null;
    if (!warm) return;
    const left = lastAsked + idleAfterMs - now();
    if (left > 0) {
      idleTimer = setTimer(checkIdle, left);
      idleTimer?.unref?.();
      return;
    }
    warm = false;
    watcher?.stop();
  }

  /** A caller asked: watch (again) if we were idle. Events missed while idle → dirty. */
  function touch() {
    lastAsked = now();
    if (warm || !watcher) return;
    warm = true;
    watcher.start();
    markDirty();
    idleTimer = setTimer(checkIdle, idleAfterMs);
    idleTimer?.unref?.();
  }

  const validated = () => warm && watcher?.status().mode === 'watch';

  /**
   * Something changed: the next caller at or after the returned `dueAt` lists again. The gap counts
   * from the last run's start; a `dueAt` from before that run is spent (the run covers it), so it
   * never pins the schedule in the past — or a change during every run would list back to back.
   */
  function markDirty({ gapMs = 0 } = {}) {
    const next = lastRunStartedAt + gapMs;
    dueAt = dirty && gen > lastRunGen ? Math.min(dueAt, next) : next; // gen > lastRunGen: set since that run started
    gen += 1;
    dirty = true;
    return Math.max(dueAt, now());
  }

  function run() {
    watcher?.rearm?.(); // a root created since, or a watcher that errored
    const g = gen;
    const startedAt = now();
    lastRunStartedAt = startedAt;
    lastRunGen = g;
    listRuns += 1;
    const promise = discover()
      .then((value) => {
        cached = { at: now(), startedAt, value };
        lastListAt = startedAt;
        if (g === gen) dirty = false;
        if (g >= staleGen) stale = false;
        return value;
      })
      .finally(() => {
        if (inFlight?.promise === promise) inFlight = null;
      });
    inFlight = { promise, gen: g };
    return promise;
  }

  async function localHost({ force = false } = {}) {
    touch();
    if (!force && cached) {
      const t = now();
      // A failed list is never trusted past the TTL: the watcher says nothing about why it failed.
      if (validated() && cached.value.ok) {
        // Restamped only when known clean: a list known stale (not yet due) keeps its own time.
        if (!(dirty && t >= dueAt) && t - cached.startedAt < safetyMs) return dirty ? cached.value : { ...cached.value, fetchedAt: t };
      } else if (!stale && t - cached.at < ttlMs) {
        return cached.value;
      }
    }
    if (inFlight && inFlight.gen !== gen && (force || (validated() && dirty && now() >= dueAt))) {
      return inFlight.promise.then(() => localHost({ force }));
    }
    if (inFlight) return inFlight.promise;
    return run();
  }

  /** Sessions of this host, or null if discovery failed. */
  async function localSessions(opts) {
    const host = await localHost(opts);
    return host.ok ? host.sessions : null;
  }

  /** After a mutation: the next caller lists again. */
  function invalidate() {
    stale = true;
    markDirty();
    staleGen = gen;
  }

  /** A watcher signal of class `fast` | `slow` (lib/watch.mjs). Returns when a list is due. */
  function signal(cls) {
    return markDirty({ gapMs: gaps[cls] ?? 0 });
  }

  /** The last list's value without listing or warming (null before the first). */
  function peek() {
    return cached?.value ?? null;
  }

  /**
   * For /api/health: how this host's discovery is decided and how often it ran. Without a watcher
   * (`ttl`) only the fields that apply; with one, its age bound, gaps, events and roots too.
   */
  function status() {
    const base = { lastListAt, listRuns, ttlMs };
    if (!watcher) return { mode: 'ttl', ...base };
    const w = watcher.status();
    return { mode: w.mode, ...base, safetyMs, gaps, events: w.events, roots: w.roots };
  }

  function stop() {
    clearTimer(idleTimer);
    idleTimer = null;
    warm = false;
    watcher?.stop();
  }

  return { localHost, localSessions, invalidate, markDirty, signal, peek, status, stop };
}
