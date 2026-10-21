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
 * Local session discovery (via the `overmind` CLI, see lib/overmind-cli.mjs) with a short TTL
 * cache and in-flight de-duplication. Never throws: failures come back as { ok:false, error }.
 */
export function createOvermind({ cli, self = 'local', ttlMs = 2000, now = Date.now } = {}) {
  if (!cli || typeof cli.list !== 'function') throw new TypeError('cli.list must be a function');

  let cached = null; // { at, value }
  let inFlight = null;

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

  async function localHost({ force = false } = {}) {
    if (!force && cached && now() - cached.at < ttlMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = discover()
      .then((value) => {
        cached = { at: now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** Sessions of this host, or null if discovery failed. */
  async function localSessions(opts) {
    const host = await localHost(opts);
    return host.ok ? host.sessions : null;
  }

  function invalidate() {
    cached = null;
  }

  return { localHost, localSessions, invalidate };
}
