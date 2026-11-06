// Close a session for good: interrupt a Codex turn, stop the tool processes that turn started,
// terminate the process, then tear down the terminal that hosted it (the tmux window, and the tmux
// session when that was its only window, or the iTerm tab).
//
// This lives in the web backend layer (next to lib/backends.mjs), not in the `overmind` CLI:
// it needs nothing discovery doesn't already hand us (pid, backend, handle, tmux_session),
// and the tmux half is the same few tmux calls the backends make directly.

function isAlive(pid, killProcess) {
  try {
    killProcess(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * @param deps
 *   run          execFile wrapper (lib/run.mjs)
 *   tmux         tmux binary
 *   killProcess  process.kill (injected for tests)
 *   sleep        (ms) => Promise
 *   closeIterm   (session) => Promise — backends.closeIterm
 *   graceMs      SIGTERM → SIGKILL grace period
 *   keys         (session, key) => Promise — backends.keys (the Codex interrupt)
 *   listSessions () => Promise<rows|null> — a fresh `overmind list` of this host
 *   interruptMs  how long a Codex interrupt may take to land before SIGTERM anyway
 *   now          () => ms — the interrupt's wall clock (injected for tests)
 *   tools        lib/codex-tools.mjs `{ find, alive }` — a Codex turn's tool processes (null: none looked for)
 */
export function createKiller({
  run,
  tmux = 'tmux',
  killProcess = process.kill.bind(process),
  sleep,
  closeIterm,
  graceMs = 4000,
  keys = null,
  listSessions = null,
  interruptMs = 5000,
  now = Date.now,
  tools = null,
}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  /**
   * A busy or waiting Codex row: Escape first (its menu's "No", the turn's interrupt), so the
   * rollout ends with `turn_aborted`. SIGTERM alone leaves an embedded turn open forever, and a
   * daemon-mode turn keeps running in the daemon. Waits until the row reads idle (or is gone),
   * at most `interruptMs` of wall clock — a list can take seconds (iTerm peeks), so the sleeps
   * alone are no bound. The kill goes ahead either way.
   * @returns 'skipped' | 'interrupted' | 'timeout' | 'failed'
   */
  async function interrupt(session) {
    const codexTurn = session.harness === 'codex' && (session.status === 'busy' || session.status === 'waiting');
    if (!codexTurn || !keys || !session.handle) return 'skipped';
    try {
      await keys(session, 'Escape');
    } catch {
      return 'failed';
    }
    const step = 250;
    const end = now() + interruptMs;
    while (now() < end) {
      await wait(step);
      const rows = listSessions ? await listSessions().catch(() => null) : null;
      if (!rows) continue;
      const row = rows.find((r) => Number(r.pid) === Number(session.pid));
      if (!row || row.status === 'idle') return 'interrupted';
    }
    return 'timeout';
  }

  /** Sends `sig` to `pid`: null when it was sent, else the error (ESRCH: the process is gone). */
  const send = (pid, sig) => {
    try {
      killProcess(pid, sig);
      return null;
    } catch (err) {
      return err;
    }
  };

  /**
   * The tool processes a busy or waiting Codex row's current turn started (lib/codex-tools.mjs:
   * the TUI's own shells, embedded mode, matched by the commands the turn asked for), looked up
   * after the interrupt and TERMed before the agent goes — neither Esc nor the agent's SIGTERM
   * stops them. An idle row's commands are left running: a dev server or watcher the user asked
   * for outlives its turn on purpose. Each is checked again to be the same process (pid, args,
   * start) right before the TERM; a group only while its leader is. Errors are ignored (gone
   * already, or not ours). Returns what was signalled, for `reap` once the agent is gone; null
   * when nothing was.
   */
  async function stopTools(session) {
    const codexTurn = session.harness === 'codex' && (session.status === 'busy' || session.status === 'waiting');
    if (!codexTurn || !tools) return null;
    const found = await tools.find(session).catch(() => null);
    if (!found?.pids?.length) return null;
    const rows = await tools.alive(found).catch(() => []);
    if (!rows.length) return null;
    const live = new Set(rows.map((r) => r.pid));
    for (const g of found.groups ?? []) if (live.has(g)) send(-g, 'SIGTERM');
    for (const pid of live) send(pid, 'SIGTERM');
    return { ...found, pids: [...live].sort((a, b) => a - b), groups: (found.groups ?? []).filter((g) => live.has(g)), rows };
  }

  /**
   * Waits up to graceMs for `found`'s processes to end, then KILLs the ones still running — each
   * checked again first to be the same process (pid, args, start), so a reused pid is never hit.
   */
  async function reap(found) {
    const end = now() + graceMs;
    let left = await tools.alive(found).catch(() => []);
    while (left.length && now() < end) {
      await wait(200);
      left = await tools.alive(found).catch(() => []);
    }
    if (!left.length) return { pids: found.pids, result: 'terminated' };
    left = await tools.alive(found).catch(() => []);
    for (const r of left) send(r.pid, 'SIGKILL');
    return { pids: found.pids, result: left.length ? 'killed' : 'terminated' };
  }

  /** SIGTERM, wait up to graceMs, then SIGKILL. Returns how it died ('gone' if it never was alive). */
  async function terminate(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return 'skipped';
    if (!isAlive(pid, killProcess)) return 'gone';
    const term = send(pid, 'SIGTERM');
    if (term?.code === 'ESRCH') return 'gone';
    if (term) throw term;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await wait(200);
      if (!isAlive(pid, killProcess)) return 'terminated';
    }
    if (!isAlive(pid, killProcess)) return 'terminated';
    const kill = send(pid, 'SIGKILL');
    if (kill?.code === 'ESRCH') return 'terminated';
    if (kill) throw kill;
    await wait(200);
    return 'killed';
  }

  /**
   * Where the pane lives, resolved BEFORE the process dies: when Claude is the pane's own
   * command (not typed into a shell) its pane, window and maybe session vanish with it.
   * Stable ids (`$3`, `@7`) are used as targets afterwards, never names: `-t a:b` on a
   * session called `a:b` resolves as session `a`, window `b`, and a bare name prefix-matches.
   * Returns null when the pane is already gone.
   */
  async function tmuxShape(pane) {
    try {
      const { stdout } = await run(tmux, ['display-message', '-p', '-t', pane, '#{session_id} #{window_id} #{session_windows}'], {
        timeout: 5000,
      });
      const m = /^(\$\d+) (@\d+) (\d+)$/.exec(stdout.trim());
      return m ? { sessionId: m[1], windowId: m[2], windows: Number(m[3]) } : null;
    } catch {
      return null;
    }
  }

  const isGone = (err) => /can't find|no such|not found|no server running|no current/i.test(String(err?.message ?? err));

  async function tmuxKill(args) {
    try {
      await run(tmux, args, { timeout: 5000 });
    } catch (err) {
      if (!isGone(err)) throw err; // it closed itself when Claude exited: that is the goal
    }
  }

  /**
   * @param session a `overmind list --json` row { pid, backend, handle, tmux_session }
   * @returns {{ process, terminal, interrupt?, tools? }} what happened to each half (+ a Codex turn's
   *   interrupt, and its tool processes: `{ pids, result: 'terminated' | 'killed' }`)
   *   process:  'terminated' | 'killed' | 'gone' | 'skipped'
   *   terminal: 'tmux-session-killed' | 'tmux-window-killed' | 'tmux-pane-gone'
   *           | 'iterm-tab-closed' | 'iterm-tab-left' | 'left'
   */
  async function kill(session) {
    const backend = String(session.backend || 'unknown');
    const shape = backend === 'tmux' && session.handle ? await tmuxShape(session.handle) : null;
    const interrupted = await interrupt(session);
    const toolsFound = await stopTools(session);
    const processResult = await terminate(Number(session.pid));
    const toolsResult = toolsFound ? await reap(toolsFound) : null;
    let terminal = 'left';

    if (backend === 'tmux' && session.handle) {
      if (!shape) {
        terminal = 'tmux-pane-gone';
      } else if (shape.windows <= 1) {
        await tmuxKill(['kill-session', '-t', shape.sessionId]);
        terminal = 'tmux-session-killed';
      } else {
        // Other windows live in this tmux session: only take down the one that hosted Claude.
        await tmuxKill(['kill-window', '-t', shape.windowId]);
        terminal = 'tmux-window-killed';
      }
    } else if (backend === 'iterm' && session.handle && closeIterm) {
      try {
        await closeIterm(session);
        terminal = 'iterm-tab-closed';
      } catch {
        terminal = 'iterm-tab-left'; // iTerm may refuse (prefs); the process is dead anyway
      }
    }
    return {
      process: processResult,
      terminal,
      ...(interrupted === 'skipped' ? {} : { interrupt: interrupted }),
      ...(toolsResult ? { tools: toolsResult } : {}),
    };
  }

  /** Close an iTerm tab whose process already ended (a sleep): what `kill` reports for it. */
  async function closeTab(session) {
    if (String(session.backend) !== 'iterm' || !session.handle || !closeIterm) return 'left';
    try {
      await closeIterm(session);
      return 'iterm-tab-closed';
    } catch {
      return 'iterm-tab-left';
    }
  }

  return { kill, terminate, closeTab, interrupt };
}
