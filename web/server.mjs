#!/usr/bin/env node
// overmind-web — zero-dependency server for the overmind HTTP API + the bundled PWA.
// Config: the shared overmind config ($OVERMIND_CONFIG or ~/.config/overmind/config.json).
// See ARCHITECTURE.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_VOICE_FAILED_DIR, configPath, createSlackSettingsReloader, expandHome, overmindStateDir, loadConfig, ensurePath, ensureUtf8Locale, resolveBinary } from './lib/config.mjs';
import { run } from './lib/run.mjs';
import { createOvermindCli } from './lib/overmind-cli.mjs';
import { createFocus } from './lib/focus.mjs';
import { createOvermind } from './lib/overmind.mjs';
import { createDiscoveryWatcher, discoveryRoots } from './lib/watch.mjs';
import { createBackend } from './lib/backends.mjs';
import { createTranscriptReader, locateTranscript } from './lib/transcript.mjs';
import { createSpawner } from './lib/spawn.mjs';
import { createBrancher } from './lib/branch.mjs';
import { createKiller } from './lib/kill.mjs';
import { createAutoNamer, createSpawnNamer } from './lib/autoname.mjs';
import { createGrouper } from './lib/grouping.mjs';
import { createUploader } from './lib/uploads.mjs';
import { SPEECH_KEY_NAME, createKeySource, createSpeaker, createTranscriber } from './lib/transcribe.mjs';
import { createOperator } from './lib/operator.mjs';
import { createCompleter } from './lib/complete.mjs';
import { createDiffer } from './lib/diff.mjs';
import { createReviews } from './lib/reviews.mjs';
import { createAsks } from './lib/asks.mjs';
import { createPrNotes } from './lib/pr-notes.mjs';
import { createFiles } from './lib/files.mjs';
import { createNotes } from './lib/notes.mjs';
import { createSpawnDirsEditor } from './lib/spawn-dirs.mjs';
import { createRepos } from './lib/repos.mjs';
import { createJobs } from './lib/jobs.mjs';
import { createTouchedIndex } from './lib/touched.mjs';
import { createBriefExtractor } from './lib/brief-extract.mjs';
import { createBriefStore, createBriefs, createClaudeAsk, gitInfo } from './lib/briefs.mjs';
import { createStacks } from './lib/stacks.mjs';
import { createAgentAsk, createInbox } from './lib/inbox.mjs';
import { createPromptQueue } from './lib/queue.mjs';
import { TOKEN_NAMES, createSlackApi, createSlackBridge, createSlackDownload, createSocketClient } from './lib/slack.mjs';
import { fetchPeerHost, proxyToPeer, setPeerConnects, setPeerProxies } from './lib/peers.mjs';
import { createDormant } from './lib/dormant.mjs';
import { createMemos } from './lib/memos.mjs';
import { createApi } from './lib/api.mjs';
import { createHttpServer } from './lib/app.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const NAME = 'overmind-web';
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const log = (line) => process.stdout.write(`${line}\n`);
const logError = (err, context = '') =>
  process.stderr.write(`[error]${context ? ` ${context}` : ''} ${err?.stack ?? String(err)}\n`);

ensurePath(process.env);
ensureUtf8Locale(process.env);

let config;
try {
  config = loadConfig({ env: process.env, webRoot: ROOT, log: console });
} catch (err) {
  process.stderr.write(`[overmind-web] ${err.message}\n`);
  process.exit(2);
}

setPeerProxies(config.peerProxies);
setPeerConnects(config.peerConnects);

const cli = createOvermindCli({ run, bin: config.overmindBin });
// Local discovery runs `overmind list` when a watched file says something changed (and at least
// every web.discovery.safetySeconds while someone asks); OVERMIND_WEB_WATCH=0 → the 2 s TTL.
// Signals before the API exists only mark the list dirty; after, they also schedule a rebuild.
let overmindAccess = null;
const discoveryWatcher = config.discovery.watch
  ? createDiscoveryWatcher({
      roots: discoveryRoots({ env: process.env }),
      live: () => overmind.peek()?.sessions ?? null,
      onChange: (cls) => (overmindAccess ? overmindAccess.discoveryChanged(cls) : overmind.signal(cls)),
      log,
    })
  : null;
const overmind = createOvermind({
  cli,
  self: config.self,
  ttlMs: 2000,
  watcher: discoveryWatcher,
  safetyMs: config.discovery.safetyMs,
  gaps: { fast: config.discovery.fastGapMs, slow: config.discovery.slowGapMs },
});
const backend = createBackend({ run, tmux: config.tmux });
const autoNamer = createAutoNamer({
  cli,
  intervalMs: config.autoName.intervalMinutes * 60 * 1000,
  log,
});
// After an unnamed spawn with a first prompt: name that one session once it has replied.
const spawnNamer = config.autoName.enabled
  ? createSpawnNamer({
      cli,
      listSessions: async () => {
        const host = await overmind.localHost({ force: true });
        return host.ok ? host.sessions : [];
      },
      log,
    })
  : null;
const uploader = createUploader({
  dir: config.uploads.dir,
  maxBytes: config.uploads.maxMB * 1024 * 1024,
  retentionDays: config.uploads.retentionDays,
  log,
});
// Only the grouping host runs the pass; the overmind accessors are bound once the API exists.
const grouper = config.grouping.enabled
  ? createGrouper({
      cli,
      getOvermind: () => overmindAccess.buildOvermind(),
      peekOvermind: () => overmindAccess.peekOvermind(),
      self: config.self,
      intervalMs: config.grouping.intervalMinutes * 60 * 1000,
      log,
    })
  : null;
const ghBin = resolveBinary('gh');
const claudeBin = resolveBinary('claude', { extraDirs: [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local')] });
// Session briefs: GET/PUT always work; background generation only with web.briefs.enabled.
const briefs = createBriefs({
  settings: config.briefs,
  self: config.self,
  store: createBriefStore({ dir: config.briefs.dir }),
  extractor: createBriefExtractor({ locate: (cwd, id) => locateTranscript(cwd, id) }),
  listSessions: async () => {
    const host = await overmind.localHost();
    return host.ok ? host.sessions : null;
  },
  ask: createClaudeAsk({ bin: claudeBin, run }),
  git: (cwd) => gitInfo(cwd, { run }),
  log,
});
// Session stacks: the routes always work (the CLI owns the files); the background membership
// sync runs every web.stacks.syncMinutes while a session is in a stack (OVERMIND_WEB_STACKS=0: off).
const stacks = createStacks({
  cli,
  self: config.self,
  listSessions: async () => {
    const host = await overmind.localHost({ force: true });
    if (!host.ok) throw new Error(host.error);
    return host.sessions;
  },
  gateSessions: async () => {
    const host = await overmind.localHost();
    return host.ok ? host.sessions : null;
  },
  syncEnabled: config.stacks.sync,
  syncIntervalMs: config.stacks.syncMinutes * 60 * 1000,
  log,
});
// Inbox: the live to-do list, run by the `inbox.host` server only (the others proxy to it).
const inbox = config.inbox.enabled
  ? createInbox({
      settings: config.inbox,
      cli,
      getOvermind: async () => overmindAccess.peekOvermind() ?? (await overmindAccess.buildOvermind()),
      ask: createClaudeAsk({ bin: claudeBin, run }),
      agent: createAgentAsk({ bin: claudeBin, run }),
      file: path.join(overmindStateDir(process.env), 'inbox.json'),
      log,
    })
  : null;
// Slack links: the bridge runs on the `slack.host` server only (the others proxy /api/slack there).
let slack = null;
if (config.slack.enabled) {
  const getBotToken = createKeySource({ name: TOKEN_NAMES.bot, run });
  const call = createSlackApi({ getToken: getBotToken });
  const socket = createSocketClient({
    getAppToken: createKeySource({ name: TOKEN_NAMES.app, run }),
    onEvent: (event) => slack.handleEvent(event),
    log,
  });
  slack = createSlackBridge({
    settings: config.slack,
    call,
    socket,
    self: config.self,
    // A link's session may run on any host: a peer is asked through its web server.
    listSessions: async (host) => {
      if (!host || host === config.self) {
        const local = await overmind.localHost({ force: true });
        return local.ok ? local.sessions : null;
      }
      const peerUrl = config.peers[host];
      if (!peerUrl) return null;
      const h = await fetchPeerHost(host, peerUrl, { timeoutMs: 8000 });
      return h.ok ? h.sessions : null;
    },
    send: async (session, text, host) => {
      if (!host || host === config.self) return backend.send(session, text);
      const peerUrl = config.peers[host];
      if (!peerUrl) throw new Error(`${host} is not a peer with a web url`);
      const r = await proxyToPeer(peerUrl, {
        method: 'POST',
        pathname: `/api/hosts/${encodeURIComponent(host)}/sessions/${encodeURIComponent(session.session_id)}/send`,
        body: JSON.stringify({ text }),
        timeoutMs: 15000,
      });
      if (r.status !== 200) throw new Error(r.body?.error ?? `HTTP ${r.status} from ${host}`);
    },
    // slack.spawn: a mention opens a session on `host` — this server, else that peer's (a spawn
    // linked to Slack answers once the session is linked, ≤ ~1 min).
    spawn: async (host, body) => {
      const local = !host || host === config.self;
      const loopback = ['0.0.0.0', '::', '', undefined, null].includes(config.bind) ? '127.0.0.1' : config.bind;
      const base = local ? `http://${loopback.includes(':') ? `[${loopback}]` : loopback}:${config.port}` : config.peers[host];
      if (!base) throw new Error(`${host} is not a peer with a web url`);
      const r = await proxyToPeer(base, {
        method: 'POST',
        pathname: `/api/hosts/${encodeURIComponent(local ? config.self : host)}/spawn`,
        body: JSON.stringify(body),
        timeoutMs: 120000,
      });
      if (r.status !== 200) throw new Error(r.body?.error ?? `HTTP ${r.status} from ${host}`);
      return r.body;
    },
    file: path.join(overmindStateDir(process.env), 'slack-links.json'),
    download: createSlackDownload({ getToken: getBotToken }),
    // The owner's DM about a blocked session links to it in the web UI of the session's host.
    sessionUrl: (host, id) => {
      const base = host === config.self ? config.selfWeb : config.peers[host];
      return base ? `${base}/#/s/${encodeURIComponent(host)}/${encodeURIComponent(id)}` : null;
    },
    log,
  });
}
// Prompt queue: messages typed while a session works go in one per run, once it is idle again.
const queue = createPromptQueue({
  file: path.join(overmindStateDir(process.env), 'prompt-queue.json'),
  listSessions: async () => {
    const host = await overmind.localHost({ force: true });
    return host.ok ? host.sessions : null;
  },
  send: (session, text) => backend.send(session, text),
  log,
});
// Session recovery: dormant sessions after a reboot (`overmind --local restore … --json`).
const dormant = createDormant({ cli, log });
// Voice: an OpenAI key for speech-to-text (voice prompts) and one for text-to-speech (the
// operator's replies) — OPENAI_TEXT_TO_SPEECH_API_KEY, else the transcription key.
const transcribeKey = createKeySource({ run });
const ttsKey = createKeySource({ name: SPEECH_KEY_NAME, run });
const speechKey = async () => (await ttsKey()) ?? (await transcribeKey());
const transcriber = createTranscriber({ getKey: transcribeKey, keepDir: expandHome(DEFAULT_VOICE_FAILED_DIR), log });
// Voice memos: segments transcribed with the same key, titled by `claude -p`.
const memos = createMemos({ ...config.memos, transcriber, ask: createClaudeAsk({ bin: claudeBin, run }), log });
const spawner = createSpawner({
  run,
  tmux: config.tmux,
  launcher: config.claude,
  launchers: config.launchers,
  ghIdentities: config.ghIdentities,
  ghIdentityLauncher: (name, launcher) => cli.ghIdentityLauncher(name, launcher),
  harnessDefaults: () => config.harnessDefaults,
});
const operator = createOperator({ config, overmind, spawner, backend, log });
// One transcript reader: the chat and the review threads (their replies) share its cache.
const transcripts = createTranscriptReader();
// Files each session worked on: file links resolve against them, the diff reviewer finds the checkouts it edits.
const touched = createTouchedIndex();

const handleApi = createApi({
  config,
  overmind,
  backend,
  transcripts,
  spawner,
  brancher: createBrancher({ spawner }),
  killer: createKiller({
    run,
    tmux: config.tmux,
    closeIterm: (s) => backend.closeIterm(s),
    keys: (s, key) => backend.keys(s, key),
    listSessions: async () => {
      const host = await overmind.localHost({ force: true });
      return host.ok ? host.sessions : null;
    },
  }),
  cli,
  autoNamer,
  spawnNamer,
  uploader,
  focus: createFocus({ run }),
  transcriber,
  memos,
  speaker: createSpeaker({ getKey: speechKey, voice: config.operator.voice ?? undefined, log }),
  operator,
  files: createFiles({ home: os.homedir(), run, touched, roots: config.files.roots }),
  touched,
  completer: createCompleter({ home: os.homedir(), run }),
  differ: createDiffer({ run }),
  // Diff reviewer side questions: a read-only `claude -p` fork of the session, kept in memory only.
  asks: createAsks({ bin: claudeBin }),
  // PR review notes (the reviewer on a PR without a session); posting one runs this host's gh.
  prNotes: createPrNotes({ dir: path.join(overmindStateDir(process.env), 'pr-notes'), gh: (args, opts) => run(ghBin, args, opts) }),
  // Diff reviewer threads: typed into the session like a send, answers read from its transcript.
  reviews: createReviews({
    dir: path.join(overmindStateDir(process.env), 'reviews'),
    send: (session, text) => backend.send(session, text),
    messages: async (session) => (await transcripts.messages(session, 500))?.messages ?? null,
  }),
  notes: createNotes({ config: config.notes, home: os.homedir(), run }),
  // Settings → Start directories: writes through `overmind config set`, hot-reloads config.spawnDirs.
  spawnDirs: createSpawnDirsEditor({ config, configFile: config.configFile ?? configPath(process.env), cli }),
  // Settings → Git repos: `overmind --local repos …` + `overmind config set repos`.
  repos: createRepos({ cli, configFile: config.configFile ?? configPath(process.env), self: config.self }),
  // Jobs screen: `overmind --local jobs …` (list / show / run now / enable|disable).
  jobs: createJobs({ cli, self: config.self }),
  briefs,
  stacks,
  dormant,
  grouper,
  inbox,
  slack,
  queue,
  name: NAME,
  version: VERSION,
  logError,
});

overmindAccess = handleApi;

const server = createHttpServer({ handleApi, uiDir: config.uiDir, log, logError });

server.on('error', (err) => {
  logError(err, 'server');
  process.exit(1);
});

server.listen(config.port, config.bind, () => {
  log(`[overmind-web] self=${config.self} listening on http://${config.bind}:${config.port}`);
  log(`[overmind-web] config=${config.configFile ?? '(none, defaults)'} peers=${Object.keys(config.peers).join(',') || '(none)'}`);
  log(`[overmind-web] overmind=${config.overmindBin} tmux=${config.tmux} ui=${config.uiDir ?? '(none)'}`);
  const d = config.discovery;
  log(d.watch
    ? `[overmind-web] discovery: watch (safety ${d.safetyMs / 1000}s, gaps ${d.fastGapMs / 1000}s/${d.slowGapMs / 1000}s)`
    : '[overmind-web] discovery: ttl 2s (OVERMIND_WEB_WATCH=0)');
  if (config.autoName.enabled) {
    autoNamer.start();
    log(`[overmind-web] autoname every ${config.autoName.intervalMinutes}m (overmind name --all --apply)`);
  } else {
    log('[overmind-web] autoname off (web.autoName.enabled = false)');
  }
  uploader.start();
  // A running operator keeps its workspace current (its ./api helper names this server's port).
  operator.prepare().catch((err) => logError(err, 'operator workspace'));
  operator.start();
  if (config.operator.clearIdleMinutes) log(`[overmind-web] operator: /clear after ${config.operator.clearIdleMinutes}m idle`);
  log(`[overmind-web] memos ${config.memos.dir} (audio ${config.memos.audioDir})`);
  log(`[overmind-web] uploads ${config.uploads.dir} (max ${config.uploads.maxMB} MB, kept ${config.uploads.retentionDays || '∞'} days)`);
  if (grouper) {
    grouper.start();
    log(`[overmind-web] grouping every ${config.grouping.intervalMinutes}m (overmind group, all hosts)`);
  } else if (config.grouping.host && config.grouping.host !== config.self) {
    log(`[overmind-web] grouping: served by ${config.grouping.host}`);
  } else {
    log('[overmind-web] grouping off (web.grouping.enabled = false)');
  }
  if (config.briefs.enabled) {
    briefs.start();
    const b = config.briefs;
    log(`[overmind-web] briefs on (${b.dir}; ${b.model}, idle ${b.idleMs / 1000}s, every ≥ ${b.minIntervalMs / 60000}m per session, ≤ ${b.maxCallsPerHour}/h)`);
  } else {
    log(`[overmind-web] briefs: background generation off (web.briefs.enabled = false); ${config.briefs.dir}`);
  }
  if (inbox) {
    inbox.start();
    const ib = config.inbox;
    log(`[overmind-web] inbox on (${ib.comms ? `Slack + mail every ${ib.scanMinutes}m in work hours, ${ib.model}` : 'no Slack + mail'}; brief ${ib.briefModel}, ≥ ${ib.briefMinutes}m apart)`);
  } else if (config.inbox.host) {
    log(`[overmind-web] inbox: served by ${config.inbox.host}`);
  }
  queue.start();
  if (slack) {
    slack.start();
    // slack.owner / slack.spawn: live from the config file (`overmind config set`), no restart.
    const reloadSlack = createSlackSettingsReloader({ config, log });
    setInterval(() => {
      if (reloadSlack()) log(`[slack] settings reloaded: owner=${config.slack.owner ?? '(none)'}`);
    }, 5000).unref();
    log(`[overmind-web] slack links on (Socket Mode; ${TOKEN_NAMES.bot} + ${TOKEN_NAMES.app} from env or Keychain)`);
  } else if (config.slack.host) {
    log(`[overmind-web] slack links: served by ${config.slack.host}`);
  }
  // The sync judges members on other hosts with the merged overmind (the warm snapshot when someone
  // is watching, else one fresh build); a sibling started on a peer is found in that peer's list.
  stacks.attach({
    overmindBody: async () => handleApi.peekOvermind() ?? (await handleApi.buildOvermind()),
    peerSessions: async (name) => {
      const url = config.peers[name];
      if (!url) return null;
      const h = await fetchPeerHost(name, url, { timeoutMs: 6000 });
      return h.ok ? h.sessions : null;
    },
  });
  stacks.start();
  log(config.stacks.sync
    ? `[overmind-web] stacks: sync every ${config.stacks.syncMinutes}m while a session is in a stack (overmind stack sync)`
    : '[overmind-web] stacks: background sync off (OVERMIND_WEB_STACKS=0)');
  if (config.restore.onBoot) {
    log('[overmind-web] restore.onBoot: bringing back dormant sessions (overmind restore --all)');
    dormant.restoreOnBoot({ markerFile: config.restore.markerFile }).then((r) => {
      if (r?.restored?.length) handleApi.refreshOvermind();
    });
  }
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`[overmind-web] ${signal} received, shutting down`);
  autoNamer.stop();
  spawnNamer?.stop();
  grouper?.stop();
  briefs.stop();
  inbox?.stop();
  queue.stop();
  slack?.stop();
  stacks.stop();
  operator.stop();
  uploader.stop();
  handleApi.stop();
  overmind.stop();
  const timer = setTimeout(() => process.exit(0), 3000);
  timer.unref?.();
  server.close(() => {
    log('[overmind-web] closed');
    process.exit(0);
  });
  server.closeIdleConnections?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => logError(err, 'uncaughtException'));
process.on('unhandledRejection', (err) => logError(err, 'unhandledRejection'));
