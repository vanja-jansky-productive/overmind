// Settings → Git repos: GET/PUT /api/hosts/:host/repos, POST …/repos/sync, POST …/repos/service.
// The CLI owns everything here (docs/cli.md → Repos): the list and each repo's state come from
// `overmind --local repos --json --all`, a save writes the `repos` config key through
// `overmind --local config set`, a sync is `overmind --local repos sync --json`, the timer is
// `overmind --local repos install-service [--uninstall]`. Each host has its own settings (its
// own roots and repos); the UI can write the same settings to every host.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const REPOS_LIMITS = Object.freeze({ maxRoots: 20, maxEntries: 300, maxPath: 1024, maxNames: 300 });
export const REPOS_DEFAULTS = Object.freeze({ roots: ['~/Code'], every: '24h' });
/** How often the launchd agent runs `sync --due` (crates/overmind/src/core/repos.rs TICK_SECS). */
export const REPOS_TICK_MINUTES = 10;
export const REPOS_LAUNCHD_LABEL = 'overmind.repos';

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SPAN_RE = /^(\d{1,5})([mhd])$/;
const UNIT = { m: 60, h: 3600, d: 86400 };

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `30m` / `12h` / `7d` → seconds, or null. Like the CLI: at least 1m, at most 3650d. */
export function spanSeconds(v) {
  const m = SPAN_RE.exec(typeof v === 'string' ? v.trim() : '');
  if (!m) return null;
  const s = Number(m[1]) * UNIT[m[2]];
  return s >= 60 && s <= 3650 * 86400 ? s : null;
}

function strings(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

/** The stored `repos` section, with defaults filled in (what the CLI uses). */
export function reposSettings(raw) {
  const r = isObject(raw) ? raw : {};
  const roots = strings(r.roots);
  const overrides = {};
  if (isObject(r.overrides)) for (const [k, v] of Object.entries(r.overrides)) if (spanSeconds(v)) overrides[k] = v.trim();
  return {
    roots: roots.length ? roots : [...REPOS_DEFAULTS.roots],
    every: spanSeconds(r.every) ? r.every.trim() : REPOS_DEFAULTS.every,
    overrides,
    exclude: strings(r.exclude),
  };
}

function checkPath(p) {
  if (p.length > REPOS_LIMITS.maxPath) return `longer than ${REPOS_LIMITS.maxPath} characters`;
  if (CONTROL_RE.test(p)) return 'contains a control character';
  if (!(p === '~' || p.startsWith('~/') || p.startsWith('/'))) return 'must be absolute or start with ~/';
  return null;
}

/** A repo key (override / exclude): a directory name, or a path (anything with a `/`). */
function checkKey(k) {
  if (!k) return 'empty repo name';
  if (k.length > REPOS_LIMITS.maxPath || CONTROL_RE.test(k)) return `bad repo name "${k.slice(0, 40)}"`;
  if (k.includes('/')) {
    const bad = checkPath(k);
    if (bad) return `${k}: ${bad}`;
  }
  return null;
}

/**
 * Validate `{ roots, every, overrides, exclude }` from the UI.
 * → { settings, errors: [{ field, error }] }
 */
export function validateReposSettings(body) {
  const L = REPOS_LIMITS;
  const errors = [];
  const b = isObject(body) ? body : {};
  const roots = [];
  if (!Array.isArray(b.roots) || !b.roots.length) errors.push({ field: 'roots', error: 'at least one root directory' });
  else if (b.roots.length > L.maxRoots) errors.push({ field: 'roots', error: `at most ${L.maxRoots} roots` });
  else {
    for (const r of b.roots) {
      const p = typeof r === 'string' ? r.trim() : '';
      const bad = p ? checkPath(p) : 'empty root';
      if (bad) errors.push({ field: 'roots', error: p ? `${p}: ${bad}` : bad });
      else if (!roots.includes(p)) roots.push(p);
    }
  }
  const every = typeof b.every === 'string' ? b.every.trim() : '';
  if (!spanSeconds(every)) errors.push({ field: 'every', error: 'interval must look like 30m, 12h or 7d (at least 1m)' });
  const overrides = {};
  if (b.overrides != null && !isObject(b.overrides)) errors.push({ field: 'overrides', error: 'overrides must be an object' });
  else {
    const entries = Object.entries(b.overrides ?? {});
    if (entries.length > L.maxEntries) errors.push({ field: 'overrides', error: `at most ${L.maxEntries} overrides` });
    for (const [k, v] of entries) {
      const key = k.trim();
      const bad = checkKey(key);
      if (bad) errors.push({ field: 'overrides', error: bad });
      else if (!spanSeconds(v)) errors.push({ field: 'overrides', error: `${key}: interval must look like 30m, 12h or 7d` });
      else overrides[key] = v.trim();
    }
  }
  const exclude = [];
  if (b.exclude != null && !Array.isArray(b.exclude)) errors.push({ field: 'exclude', error: 'exclude must be a list' });
  else if ((b.exclude ?? []).length > L.maxEntries) errors.push({ field: 'exclude', error: `at most ${L.maxEntries} excluded repos` });
  else {
    for (const x of b.exclude ?? []) {
      const key = typeof x === 'string' ? x.trim() : '';
      const bad = checkKey(key);
      if (bad) errors.push({ field: 'exclude', error: bad });
      else if (!exclude.includes(key)) exclude.push(key);
    }
  }
  return { settings: { roots, every, overrides, exclude }, errors };
}

/**
 * @param cli         lib/overmind-cli.mjs instance (`repos`, `reposSync`, `reposService`, `configSet`)
 * @param configFile  the config path the CLI writes (OVERMIND_CONFIG)
 * @param self        this host's name
 */
export function createRepos({ cli, configFile, self, home = os.homedir(), fsImpl = fs }) {
  let queue = Promise.resolve(); // one write at a time (the CLI's tmp file is fixed)
  const plist = path.join(home, 'Library', 'LaunchAgents', `${REPOS_LAUNCHD_LABEL}.plist`);

  function readRaw() {
    let text;
    try {
      text = fsImpl.readFileSync(configFile, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return {};
      throw Object.assign(new Error(`cannot read overmind config: ${err.message}`), { status: 500 });
    }
    try {
      const raw = JSON.parse(text);
      return isObject(raw) ? raw : {};
    } catch (err) {
      throw Object.assign(new Error(`overmind config is not valid JSON: ${err.message}`), { status: 500 });
    }
  }

  function service() {
    return { installed: fsImpl.existsSync(plist), supported: process.platform === 'darwin', tickMinutes: REPOS_TICK_MINUTES };
  }

  /** GET: settings + every repo under the roots (excluded ones flagged) + the timer. */
  async function get() {
    const settings = reposSettings(readRaw().repos);
    let repos = [];
    let error = null;
    try {
      repos = await cli.repos({ all: true });
    } catch (err) {
      if (err?.missing) throw Object.assign(new Error('this host’s overmind CLI has no `repos` command — update it'), { status: 501 });
      error = String(err?.message ?? err);
    }
    return { host: self, settings, repos, error, service: service(), limits: REPOS_LIMITS };
  }

  /** PUT `{ roots, every, overrides, exclude }` → { status, body }. 400 `{ error, errors }` when invalid. */
  async function put(body) {
    const { settings, errors } = validateReposSettings(body);
    if (errors.length) return { status: 400, body: { host: self, error: errors[0].error, errors } };
    const run = queue.then(async () => {
      // Keep keys the UI doesn't know about.
      const before = readRaw().repos;
      const value = { ...(isObject(before) ? before : {}), ...settings };
      await cli.configSet({ key: 'repos', value, configFile });
      return { status: 200, body: { ...(await get()), saved: true } };
    });
    queue = run.catch(() => {});
    return run;
  }

  /** POST sync `{ names? }` → the CLI's results. 409 while another sync runs. */
  async function sync(body) {
    const names = body?.names == null ? [] : body.names;
    if (!Array.isArray(names) || names.length > REPOS_LIMITS.maxNames || names.some((n) => typeof n !== 'string' || checkKey(n.trim()))) {
      return { status: 400, body: { error: 'names must be a list of repo names or ~/paths' } };
    }
    try {
      const results = await cli.reposSync(names.map((n) => n.trim()));
      return { status: 200, body: { host: self, results } };
    } catch (err) {
      if (/another .*sync.* is running/i.test(err?.message ?? '')) return { status: 409, body: { error: 'a sync is already running on this host' } };
      if (err?.missing) return { status: 501, body: { error: 'this host’s overmind CLI has no `repos` command — update it' } };
      return { status: err?.timedOut ? 504 : 502, body: { error: String(err?.message ?? err) } };
    }
  }

  /** POST service `{ install: boolean }` → the GET shape. */
  async function setService(body) {
    if (typeof body?.install !== 'boolean') return { status: 400, body: { error: 'install must be true or false' } };
    if (!service().supported) return { status: 501, body: { error: 'the sync timer is macOS-only (launchd)' } };
    try {
      await cli.reposService({ uninstall: !body.install });
    } catch (err) {
      return { status: 502, body: { error: String(err?.message ?? err) } };
    }
    return { status: 200, body: await get() };
  }

  return { get, put, sync, setService };
}
