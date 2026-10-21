import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tailLines, sleep as defaultSleep } from './util.mjs';

/** Error with an HTTP status attached. */
// Largest piece of text one `send-keys -l` types. Claude Code takes a burst of more than ~800
// bytes as a paste (collapsed into `[Pasted text]`), and from one write of more than ~1 KB it keeps
// only what follows the first 1 KB.
export const TYPE_CHUNK = 512;

/** Split `text` into pieces of at most `max` UTF-8 bytes, never inside a character. */
export function typeChunks(text, max = TYPE_CHUNK) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > max && cur) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  if (cur) out.push(cur);
  return out;
}

export class BackendError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
  }
}

export const ITERM_SCRIPT = `on findSession(theId)
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (id of s) is theId then return s
        end repeat
      end repeat
    end repeat
  end tell
  return missing value
end findSession

on run argv
  set theMode to item 1 of argv
  set theId to item 2 of argv
  set theSession to findSession(theId)
  if theSession is missing value then
    error "iterm session not found: " & theId number 1001
  end if
  if theMode is "peek" then
    tell application "iTerm2"
      return text of theSession
    end tell
  else if theMode is "send" then
    tell application "iTerm2"
      tell theSession to write text (item 3 of argv) without newline
    end tell
    delay 0.2
    tell application "iTerm2"
      tell theSession to write text ""
    end tell
    return "ok"
  else if theMode is "type" then
    tell application "iTerm2"
      tell theSession to write text (item 3 of argv) without newline
    end tell
    return "ok"
  else if theMode is "enter" then
    tell application "iTerm2"
      tell theSession to write text ""
    end tell
    return "ok"
  else if theMode is "escape" then
    tell application "iTerm2"
      tell theSession to write text (ASCII character 27) without newline
    end tell
    return "ok"
  else if theMode is "up" then
    tell application "iTerm2"
      tell theSession to write text ((ASCII character 27) & "[A") without newline
    end tell
    return "ok"
  else if theMode is "down" then
    tell application "iTerm2"
      tell theSession to write text ((ASCII character 27) & "[B") without newline
    end tell
    return "ok"
  else if theMode is "close" then
    tell application "iTerm2"
      tell theSession to close
    end tell
    return "ok"
  end if
  error "unknown mode: " & theMode number 1002
end run
`;

/**
 * Write the AppleScript helper once per process and reuse the path.
 */
export function createScriptProvider({ tmpdir = os.tmpdir(), fsImpl = fs } = {}) {
  let cached = null;
  return () => {
    if (cached && fsImpl.existsSync(cached)) return cached;
    const file = path.join(tmpdir, `fleet-web-iterm-${process.pid}.applescript`);
    fsImpl.writeFileSync(file, ITERM_SCRIPT, 'utf8');
    cached = file;
    return file;
  };
}

/**
 * Backend driver. `run(file, args, opts)` is injected so the logic stays testable.
 */
export function createBackend({
  run,
  tmux = 'tmux',
  osascript = '/usr/bin/osascript',
  scriptPath = createScriptProvider(),
  sleep = defaultSleep,
  enterDelayMs = 150,
} = {}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  let pasteSeq = 0;

  function requireHandle(session) {
    const handle = session?.handle;
    if (typeof handle !== 'string' || handle === '') {
      throw new BackendError('session has no usable handle', 409);
    }
    return handle;
  }

  function backendOf(session) {
    const b = String(session?.backend ?? 'unknown').toLowerCase();
    if (b !== 'tmux' && b !== 'iterm') {
      throw new BackendError(`backend "${session?.backend ?? 'unknown'}" cannot be controlled`, 409);
    }
    return b;
  }

  /** Type `text` literally, a TYPE_CHUNK at a time, so a long line reaches the TUI whole. */
  async function typeText(handle, text) {
    const chunks = typeChunks(text);
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0) await sleep(20);
      await run(tmux, ['send-keys', '-t', handle, '-l', '--', chunk], { timeout: 8000 });
    }
  }

  async function peek(session, lines) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      const { stdout } = await run(tmux, ['capture-pane', '-p', '-J', '-t', handle, '-S', `-${lines}`], {
        timeout: 8000,
      });
      return tailLines(stdout, lines);
    }
    const { stdout } = await run(osascript, [scriptPath(), 'peek', handle], { timeout: 15000 });
    return tailLines(stdout, lines);
  }

  async function send(session, text) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      if (/[\r\n]/.test(text)) {
        // tmux (3.6) drops newlines typed by `send-keys -l`, so a multi-line message would reach
        // Claude as one line. Paste it as a bracketed paste instead: the TUI keeps the newlines.
        const buf = `fleet-send-${process.pid}-${++pasteSeq}`;
        await run(tmux, ['load-buffer', '-b', buf, '-'], { input: text, timeout: 8000 });
        await run(tmux, ['paste-buffer', '-p', '-r', '-d', '-b', buf, '-t', handle], { timeout: 8000 });
      } else {
        await typeText(handle, text);
      }
      await sleep(enterDelayMs);
      await run(tmux, ['send-keys', '-t', handle, 'Enter'], { timeout: 8000 });
      return;
    }
    await run(osascript, [scriptPath(), 'send', handle, text], { timeout: 15000 });
  }

  async function keys(session, key) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      await run(tmux, ['send-keys', '-t', handle, key], { timeout: 8000 });
      return;
    }
    const mode = { Escape: 'escape', Enter: 'enter', Up: 'up', Down: 'down' }[key] ?? 'enter';
    await run(osascript, [scriptPath(), mode, handle], { timeout: 15000 });
  }

  /** Type `text` without submitting it (no Enter). */
  async function type(session, text) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      await typeText(handle, text);
      return;
    }
    await run(osascript, [scriptPath(), 'type', handle, text], { timeout: 15000 });
  }

  /**
   * The pane's visible screen for the live terminal view: each row with its SGR colours
   * (`capture-pane -e`, not joined), the size, the cursor and the input modes the app turned on
   * (application cursor keys, mouse tracking) — so the browser terminal encodes keys and clicks
   * the way the app expects. tmux only: iTerm has no equivalent (409).
   */
  async function screen(session) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend !== 'tmux') throw new BackendError('the live terminal needs a tmux session', 409);
    const [info, cap] = await Promise.all([
      run(tmux, ['display-message', '-p', '-t', handle, SCREEN_FORMAT], { timeout: 8000 }),
      run(tmux, ['capture-pane', '-p', '-e', '-N', '-t', handle], { timeout: 8000 }),
    ]);
    return parseScreen(info.stdout, cap.stdout);
  }

  /**
   * Raw terminal input — keystrokes, escape sequences, mouse reports — exactly as a terminal
   * would write them to the app. tmux gets the bytes as hex (`send-keys -H`), which it passes
   * through untouched; iTerm writes them as text (no newline).
   */
  async function input(session, data) {
    const backend = backendOf(session);
    const handle = requireHandle(session);
    if (backend === 'tmux') {
      const bytes = Buffer.from(data, 'utf8');
      for (let i = 0; i < bytes.length; i += INPUT_CHUNK) {
        const hex = [...bytes.subarray(i, i + INPUT_CHUNK)].map((b) => b.toString(16).padStart(2, '0'));
        await run(tmux, ['send-keys', '-t', handle, '-H', ...hex], { timeout: 8000 });
      }
      return;
    }
    await run(osascript, [scriptPath(), 'type', handle, data], { timeout: 15000 });
  }

  /** Close the iTerm tab/pane hosting the session (best effort; the process should be dead already). */
  async function closeIterm(session) {
    const handle = requireHandle(session);
    await run(osascript, [scriptPath(), 'close', handle], { timeout: 15000 });
  }

  return { peek, send, keys, type, screen, input, closeIterm };
}

// Bytes per `send-keys -H` call (each byte is one argument).
const INPUT_CHUNK = 256;

const SCREEN_FIELDS = [
  'pane_width',
  'pane_height',
  'cursor_x',
  'cursor_y',
  'cursor_flag',
  'alternate_on',
  'keypad_cursor_flag',
  'mouse_standard_flag',
  'mouse_button_flag',
  'mouse_all_flag',
  'mouse_sgr_flag',
  'mouse_utf8_flag',
];
export const SCREEN_FORMAT = SCREEN_FIELDS.map((f) => `#{${f}}`).join(' ');

/**
 * `display-message -p SCREEN_FORMAT` + `capture-pane -p -e -N` → the live terminal's frame:
 * `{ cols, rows, cursor: { x, y, visible }, altScreen, appCursor, mouse: { tracking, sgr, utf8 }, lines }`.
 * `tracking` is the mouse mode the app asked for: none | click (1000) | drag (1002) | all (1003).
 */
export function parseScreen(info, captured) {
  const v = Object.fromEntries(String(info).trim().split(/\s+/).map((x, i) => [SCREEN_FIELDS[i], Number(x) || 0]));
  const rows = Math.max(1, v.pane_height || 24);
  const lines = String(captured).replace(/\n$/, '').split('\n').slice(0, rows);
  while (lines.length < rows) lines.push('');
  const tracking = v.mouse_all_flag ? 'all' : v.mouse_button_flag ? 'drag' : v.mouse_standard_flag ? 'click' : 'none';
  return {
    cols: Math.max(1, v.pane_width || 80),
    rows,
    cursor: { x: v.cursor_x, y: v.cursor_y, visible: v.cursor_flag === 1 },
    altScreen: v.alternate_on === 1,
    appCursor: v.keypad_cursor_flag === 1,
    mouse: { tracking, sgr: v.mouse_sgr_flag === 1, utf8: v.mouse_utf8_flag === 1 },
    lines,
  };
}
