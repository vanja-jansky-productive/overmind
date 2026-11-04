// "Open in editor" links (`web.editor`: "vscode" | "cursor" | null). The browser follows them,
// so they are built for the machine the browser runs on (editorViewer: loopback = this host, a
// peer's web address = that peer; behind a local HTTPS proxy, its X-Forwarded-For): a session on that machine opens as a local folder
// (`vscode://file/<path>`), a session on another host through Remote-SSH with that host's ssh
// alias from this server's config (`vscode://vscode-remote/ssh-remote+<alias><path>`) — for this
// server's own host `web.editorSsh`, else `<user>@<the address the browser used>`. A proxied
// response carries only the peer's absolute paths; the server that received the request fills
// in the link.

import os from 'node:os';

import { parseFrontmatter } from './brief-format.mjs';

export const EDITORS = ['vscode', 'cursor'];
export const DEFAULT_EDITOR = 'vscode';

/** An ssh destination that is safe in the URL's authority-like segment (alias or user@host). */
const SSH_ALIAS_RE = /^[A-Za-z0-9._@-]{1,253}$/;

function encodePath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/**
 * → the editor URL for `absPath` on `host`, or null (no editor, relative path, or a remote host
 * without a usable ssh alias). `config` = normalized config ({ self, editor, sshHosts }).
 * `line` opens `absPath` as a file at that line: VS Code opens a remote path as a folder unless
 * it ends in `:<line>`.
 */
export function editorUrl(config, host, absPath, { line = null } = {}) {
  const editor = config?.editor ?? null;
  if (!EDITORS.includes(editor) || typeof absPath !== 'string' || !absPath.startsWith('/')) return null;
  const at = Number.isInteger(line) && line > 0 ? `:${line}` : '';
  if (host === config.self) return `${editor}://file${encodePath(absPath)}${at}`;
  const alias = config.sshHosts?.[host] ?? null;
  if (typeof alias !== 'string' || !SSH_ALIAS_RE.test(alias)) return null;
  return `${editor}://vscode-remote/ssh-remote+${alias}${encodePath(absPath)}${at}`;
}

const LOOPBACK_RE = /^(?:127\.\d+\.\d+\.\d+|::1)$/;

/**
 * The browser's address: the socket's, or — behind a reverse proxy on this machine (`tailscale
 * serve` for HTTPS) — the last `X-Forwarded-For` entry, the one that proxy added.
 */
function clientAddr(req) {
  const socket = String(req?.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!LOOPBACK_RE.test(socket)) return socket;
  const xff = req?.headers?.['x-forwarded-for'];
  const forwarded = typeof xff === 'string' ? (xff.split(',').pop() ?? '').trim().replace(/^::ffff:/, '') : '';
  return forwarded || socket;
}

/**
 * The config to build editor links with for this request: `self` becomes the host the browser is
 * on (null when it is none of ours — a phone), and this server's host gets an ssh destination
 * when the browser is elsewhere. Without a request (or a socket address): `config` as is.
 */
export function editorViewer(config, req, { user = safeUser() } = {}) {
  const addr = clientAddr(req);
  if (!config || !addr || LOOPBACK_RE.test(addr)) return config;
  const viewer = Object.entries(config.hostAddrs ?? {}).find(([, a]) => a === addr)?.[0] ?? null;
  if (viewer === config.self) return config;
  let selfSsh = config.sshHosts?.[config.self] ?? config.editorSsh ?? null;
  if (!selfSsh && user) {
    const hostname = hostnameOf(req?.headers?.host);
    if (hostname) selfSsh = `${user}@${hostname}`;
  }
  return { ...config, self: viewer, sshHosts: { ...config.sshHosts, ...(selfSsh ? { [config.self]: selfSsh } : {}) } };
}

function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || !hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname || null;
  } catch {
    return null;
  }
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/**
 * Fill `editor` / `editorUrl` into a GET/PUT brief body (gitRoot preferred over absCwd) and into
 * each of its `worktrees`. A peer
 * too old to send `absCwd` still has the session's cwd in the frontmatter (`cwd:`), used when
 * it is absolute.
 */
export function withBriefEditor(body, host, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.error) return body;
  let target = body.gitRoot ?? body.absCwd ?? null;
  if (target == null && body.absCwd === undefined && typeof body.markdown === 'string') {
    const cwd = parseFrontmatter(body.markdown).meta.cwd;
    if (typeof cwd === 'string' && cwd.startsWith('/')) target = cwd;
  }
  const out = { ...body, editor: config.editor ?? null, editorUrl: editorUrl(config, host, target) };
  if (Array.isArray(body.worktrees)) out.worktrees = body.worktrees.map((w) => ({ ...w, editorUrl: editorUrl(config, host, w?.path ?? null) }));
  return out;
}

/** Each session row of an overmind host gets `editorUrl` (its cwd; no git lookup — the brief has the root). */
export function withSessionEditors(hostEntry, config) {
  if (!hostEntry || !Array.isArray(hostEntry.sessions)) return hostEntry;
  return {
    ...hostEntry,
    sessions: hostEntry.sessions.map((s) => ({ ...s, editorUrl: editorUrl(config, hostEntry.name, typeof s?.cwd === 'string' ? s.cwd : null) })),
  };
}
