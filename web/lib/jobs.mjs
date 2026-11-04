// Jobs (cron-scheduled agent sessions): GET /api/hosts/:host/jobs[/:name], POST …/jobs/:name/run,
// POST …/jobs/:name/enabled. The CLI owns everything (docs/cli.md → Jobs): the list is
// `overmind --local jobs --json`, one job with its runs `overmind --local jobs show <name> --json`, a run
// now `overmind --local jobs run [--force] <name>`, pause / resume `overmind --local jobs enable|disable`.
// Each host has its own jobs (its config's `jobs`); the UI asks every host. A prompt file gets
// `prompt.abs` (`~` expanded on the job's host) and `prompt.root` (its git checkout, else its
// directory); the API layer adds their editor links.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A job name as the UI may send it (config keys are free-form; the web only passes these). */
export const JOB_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

const MISSING = 'this host’s overmind CLI has no `jobs` command — update it';

export function validJobName(name) {
  return typeof name === 'string' && JOB_NAME_RE.test(name);
}

/** A CLI failure → { status, body }. */
function failure(err) {
  if (err?.missing) return { status: 501, body: { error: MISSING } };
  if (err?.notFound) return { status: 404, body: { error: String(err.message) } };
  if (err?.busy) return { status: 409, body: { error: String(err.message), busy: true } };
  return { status: err?.timedOut ? 504 : 502, body: { error: String(err?.message ?? err) } };
}

/** The git checkout containing `file` (a `.git` above it), else its directory. */
function rootOf(file, exists) {
  const dir = path.dirname(file);
  for (let d = dir; ; d = path.dirname(d)) {
    if (exists(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

/** A job with `prompt.abs` and `prompt.root` for a `~/…` or absolute prompt file. */
function withPromptAbs(job, home, exists) {
  const file = job?.prompt?.file;
  if (typeof file !== 'string') return job;
  const abs = file === '~' || file.startsWith('~/') ? home + file.slice(1) : file;
  return abs.startsWith('/') ? { ...job, prompt: { ...job.prompt, abs, root: rootOf(abs, exists) } } : job;
}

/**
 * @param cli   lib/overmind-cli.mjs instance (`jobs`, `jobShow`, `jobRunNow`, `jobSetEnabled`)
 * @param self  this host's name
 * @param home  this host's home directory (expands a `~/…` prompt file)
 * @param exists  path → whether it exists (finds a prompt file's git checkout)
 */
export function createJobs({ cli, self, home = os.homedir(), exists = fs.existsSync }) {
  async function list() {
    try {
      return { status: 200, body: { host: self, jobs: (await cli.jobs()).map((j) => withPromptAbs(j, home, exists)) } };
    } catch (err) {
      return failure(err);
    }
  }

  async function show(name) {
    if (!validJobName(name)) return { status: 400, body: { error: 'bad job name' } };
    try {
      return { status: 200, body: { host: self, ...withPromptAbs(await cli.jobShow(name), home, exists) } };
    } catch (err) {
      return failure(err);
    }
  }

  /** POST run `{ force? }` → `{ host, name, output }`. 409 while a session of the job works. */
  async function runNow(name, body) {
    if (!validJobName(name)) return { status: 400, body: { error: 'bad job name' } };
    if (body?.force != null && typeof body.force !== 'boolean') return { status: 400, body: { error: 'force must be true or false' } };
    try {
      const output = await cli.jobRunNow(name, { force: body?.force === true });
      return { status: 200, body: { host: self, name, output } };
    } catch (err) {
      return failure(err);
    }
  }

  /** POST enabled `{ enabled }` → `{ host, name, enabled, output, job }` (the job after the change). */
  async function setEnabled(name, body) {
    if (!validJobName(name)) return { status: 400, body: { error: 'bad job name' } };
    if (typeof body?.enabled !== 'boolean') return { status: 400, body: { error: 'enabled must be true or false' } };
    try {
      const output = await cli.jobSetEnabled(name, body.enabled);
      const job = await cli.jobShow(name).catch(() => null);
      return { status: 200, body: { host: self, name, enabled: body.enabled, output, job } };
    } catch (err) {
      return failure(err);
    }
  }

  return { list, show, runNow, setEnabled };
}
