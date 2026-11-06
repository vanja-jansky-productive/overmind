// Claude Code's AskUserQuestion prompt: read it from the transcript, answer it by typing the
// keys a human would press in the terminal.
//
// The terminal UI (Claude Code 2.1): one tab per question, the cursor on option 1.
//   single-select  ↓ to an option + Enter picks it and moves on; option N+1 is "Type something."
//                  (typing there fills it in, Enter picks it)
//   multi-select   Enter toggles the option under the cursor; typing on "Type something" fills
//                  and checks it; the row after it ("Next" / "Submit") + Enter moves on
//   2+ questions   a "Review your answers" screen follows, "Submit answers" focused → Enter
// A lone single-select question submits on its pick (no review screen).

import { createHash } from 'node:crypto';

export const QUESTION_TOOL = 'AskUserQuestion';
export const MAX_ANSWER_TEXT = 2000;

const str = (v) => (typeof v === 'string' ? v : '');

/** The tool input's questions, normalized; null when it isn't a usable question list. */
export function normalizeQuestions(input) {
  const raw = input && Array.isArray(input.questions) ? input.questions : null;
  if (!raw?.length) return null;
  const out = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object' || !str(q.question).trim()) return null;
    const options = Array.isArray(q.options)
      ? q.options.filter((o) => o && str(o.label).trim()).map((o) => ({ label: str(o.label), description: str(o.description) }))
      : [];
    if (!options.length) return null;
    out.push({ question: str(q.question), header: str(q.header), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

/** Plain-markdown rendering, for readers that don't know `kind: 'question'`. */
export function questionsText(questions) {
  return questions
    .map((q) => [`**${q.header ? `${q.header}: ` : ''}${q.question}**`, ...q.options.map((o) => `- ${o.label}`)].join('\n'))
    .join('\n\n');
}

/**
 * What became of the prompt, from its tool_result entry: `{ answers: (string|null)[] }` aligned
 * with `questions`, or `{ declined: true }` (Esc, "Chat about this", interrupted).
 */
export function questionOutcome(questions, entry, block) {
  const answers = entry?.toolUseResult?.answers;
  if (!block?.is_error && answers && typeof answers === 'object') {
    return { answers: questions.map((q) => (typeof answers[q.question] === 'string' ? answers[q.question] : null)) };
  }
  return { declined: true };
}

/**
 * The body of POST …/answer against the pending prompt's `questions`:
 *   { toolUseId, answers: [{ options: [index…], text? }] } — one entry per question, in order.
 * Single-select: exactly one option, or text. Multi-select: any options and/or text, at least one.
 */
export function validateAnswer(body, questions) {
  const b = body && typeof body === 'object' ? body : {};
  if (!Array.isArray(b.answers) || b.answers.length !== questions.length) {
    return { ok: false, error: `answers must be an array of ${questions.length}` };
  }
  const answers = [];
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const a = b.answers[i] && typeof b.answers[i] === 'object' ? b.answers[i] : {};
    const opts = Array.isArray(a.options) ? a.options : [];
    if (!opts.every((n) => Number.isInteger(n) && n >= 0 && n < q.options.length)) {
      return { ok: false, error: `answers[${i}].options: unknown option` };
    }
    const options = [...new Set(opts)].sort((x, y) => x - y);
    const text = typeof a.text === 'string' ? a.text.trim() : '';
    if (text && q.noOther) return { ok: false, error: `answers[${i}]: pick an option` };
    if (/[\r\n]/.test(text)) return { ok: false, error: `answers[${i}].text must be a single line` };
    if (text.length > MAX_ANSWER_TEXT) return { ok: false, error: `answers[${i}].text too long (max ${MAX_ANSWER_TEXT})` };
    if (q.multiSelect) {
      if (!options.length && !text) return { ok: false, error: `answers[${i}]: pick at least one option or type something` };
    } else if (options.length + (text ? 1 : 0) !== 1) {
      return { ok: false, error: `answers[${i}]: pick exactly one option or type something` };
    }
    answers.push({ options, text: text || null });
  }
  return { ok: true, answers };
}

/** The keystrokes answering `questions` with validated `answers`: `{ key }` or `{ text }` steps. */
export function answerSteps(questions, answers) {
  const steps = [];
  const down = (n) => {
    for (let i = 0; i < n; i += 1) steps.push({ key: 'Down' });
  };
  questions.forEach((q, i) => {
    const a = answers[i];
    const other = q.options.length; // the "Type something" row
    if (!q.multiSelect) {
      if (a.text) {
        down(other);
        steps.push({ text: a.text }, { key: 'Enter' });
      } else {
        down(a.options[0]);
        steps.push({ key: 'Enter' });
      }
      return;
    }
    let at = 0;
    for (const n of a.options) {
      down(n - at);
      steps.push({ key: 'Enter' });
      at = n;
    }
    if (a.text) {
      down(other - at);
      steps.push({ text: a.text });
      at = other;
    }
    down(other + 1 - at); // "Next" / "Submit"
    steps.push({ key: 'Enter' });
  });
  if (questions.length > 1) steps.push({ key: 'Enter' }); // review → "Submit answers"
  return steps;
}

const squash = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Is the terminal showing this prompt, untouched? Its first question on screen (the TUI wraps
 * long lines, so compared whitespace-folded) with the cursor on option 1.
 */
export function screenShowsPrompt(screen, questions) {
  const flat = squash(screen);
  const q = squash(questions[0].question).slice(0, 60);
  return flat.includes(q) && /❯ 1\. /.test(flat) && /Enter to select/.test(flat);
}

// ------------------------------------------------------------------ the prompt on screen
//
// Claude Code 2.1.310+ writes the AskUserQuestion call to the transcript only once it is
// answered, so while it waits the terminal is the only place it shows. It shows one tab at a
// time (the active tab isn't marked in plain text), then a "Review your answers" screen:
//   ←  ☒ Fruit  ☐ Toppings  ✔ Submit  →      (a lone question: just "☐ Color")
//   Pick toppings?                            (long ones may be quoted: "│ …")
//   ❯ 1. [ ] Nuts                             ([ ] / [✔]: multi-select)
//          Add nuts
//     3. [ ] Type something                   (the "Type something" row is always last)
//        Submit                               (multi-select: "Next" / "Submit")
//   ────────
//     4. Chat about this
//   Enter to select · …
// Review: "Review your answers", the picks, then "❯ 1. Submit answers" / "2. Cancel".

const TAB_BAR = /^\s*(?:←\s+)?[☐☒]\s/;
const OPTION = /^\s*(❯\s*)?(\d+)\.\s+(?:\[([ ✔])\]\s+)?(.*)$/;
const RULE = /^\s*─{8,}/;

/**
 * The question the terminal shows, as `{ id, questions: [q], untouched, cursorAt }` (`q.noOther`
 * on the review screen: no "Type something" row); null when it shows none. `untouched`: cursor
 * on option 1, nothing checked — only then is it safe to answer by typing. `cursorAt`: the
 * option index the cursor is on (-1 when none).
 */
export function parseScreenPrompt(screen) {
  const lines = String(screen ?? '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let bar = -1;
  for (let i = lines.length - 1; i >= 0 && bar < 0; i -= 1) if (TAB_BAR.test(lines[i])) bar = i;
  if (bar < 0) return null;
  const body = lines.slice(bar + 1);
  const first = body.findIndex((l) => OPTION.test(l));
  if (first < 0) return null;
  const rawHead = body.slice(0, first);
  const head = rawHead.map((l) => l.replace(/^\s*│ ?/, ''));
  const review = head.find((l) => l.trim())?.trim() === 'Review your answers';
  if (!review && !body.slice(first).some((l) => /Enter to select/.test(l))) return null;

  const options = [];
  let checked = false;
  let cursorAt = -1;
  for (const l of body.slice(first)) {
    if (RULE.test(l) || /Enter to select/.test(l)) break;
    const m = l.match(OPTION);
    if (m) {
      if (m[1]) cursorAt = options.length;
      if (m[3] === '✔') checked = true;
      options.push({ label: m[4].trim(), description: '', box: m[3] !== undefined });
    } else if (l.trim().startsWith('❯')) {
      cursorAt = options.length; // multi-select's "Next" / "Submit" row
      break;
    } else if (options.length && l.trim() && !/^(Next|Submit)$/.test(l.trim())) {
      const o = options[options.length - 1];
      o.description = o.description ? `${o.description} ${l.trim()}` : l.trim();
    }
  }
  const multiSelect = options.some((o) => o.box);
  if (!review) {
    if (!/^Type something\.?$/.test(options[options.length - 1]?.label ?? '')) return null;
    options.pop();
  }
  if (!options.length) return null;

  // The question: lines the terminal wrapped (the next word would not have fit) rejoined, the
  // others kept; the review's summary keeps its lines.
  const width = Math.max(...lines.map((l) => l.length));
  const wrapped = (i) => rawHead[i].length + 1 + (head[i + 1]?.trim().split(/\s/)[0].length ?? 0) > width - 2;
  const question = review
    ? head.map((l) => l.trim()).filter(Boolean).join('\n')
    : head
        .map((l, i) => l.trim() + (i === head.length - 1 ? '' : head[i + 1].trim() && l.trim() && wrapped(i) ? ' ' : '\n'))
        .join('')
        .trim()
        .replace(/\n{3,}/g, '\n\n');
  if (!question) return null;
  const header = review ? 'Submit' : '';
  const q = { question, header, multiSelect, options: options.map(({ label, description }) => ({ label, description })) };
  if (review) q.noOther = true;
  const sig = squash([question, ...q.options.map((o) => o.label)].join('\n'));
  const id = `screen:${createHash('sha1').update(sig).digest('hex').slice(0, 12)}`;
  return { id, questions: [q], untouched: cursorAt === 0 && !checked, cursorAt };
}

// ------------------------------------------------------------------ Codex's approval menus
//
// Codex 0.166 asks in the terminal only (nothing is persisted), with one of three screens.
// An escalated command:
//     Would you like to run the following command?
//     Thread: Agent (01a1a7b1)                     (a sub-agent's request, shown in the parent)
//     Environment: local
//     Reason: Allow creating hello.txt …           (may wrap)
//     $ printf hi > hello.txt                      (may span lines)
//   › 1. Yes, proceed (y)
//     2. Yes, and don't ask again for commands that start with `printf hi` (p)   (may wrap)
//     3. No, and tell Codex what to do differently (esc)
//     Press enter to confirm or esc to cancel
// Option 2 writes a permanent `prefix_rule(… decision="allow")` to ~/.codex/rules/default.rules —
// for every session on the host. Option 3 ends the turn like Esc.
// An apply_patch the sandbox does not allow (the diff is drawn above it, in the history):
//     Would you like to make the following edits?
//     Description: Apply proposed file edits
//     Destination: /abs/path/a.txt                 (or the path on the next lines, hard-wrapped)
//   › 1. Yes, proceed (y)
//     2. Yes, and don't ask again for these files (a)     (this session only: no file written)
//     3. No, and tell Codex what to do differently (esc)  (ends the turn)
//     Press enter to confirm or esc to cancel
// An MCP tool call (an elicitation form; a tool marked read-only does not ask):
//     Field 1/1
//     Allow the tiny MCP server to run tool "write_note"?
//     path: /abs/pa...                             (each argument, cut to the width)
//   › 1. Allow                   Run the tool and continue
//     2. Allow for this session  Run the tool and remember this choice for this session
//     3. Always allow            Run the tool and remember this choice for future tool calls
//     4. Cancel                  Cancel this tool call         (the turn goes on)
//     enter to submit | esc to cancel
// "Always allow" writes `[mcp_servers.<server>.tools.<tool>] approval_mode = "approve"` to
// Codex's config.toml. `›` is the cursor in all three; ↓ moves it, Enter picks. A pick with a
// lasting side effect is `secondary: true`.

const CODEX_HEAD = 'Would you like to run the following command?';
const CODEX_PATCH_HEAD = 'Would you like to make the following edits?';
const CODEX_MCP_HEAD = /^Allow the (\S+) MCP server to run tool "(.+)"\?$/;
const CODEX_FOOT = /Press enter to confirm/;
const CODEX_MCP_FOOT = /enter to submit \| esc to cancel/;
const CODEX_OPTION = /^\s*(›\s*)?(\d+)\.\s+(.*)$/;
const CODEX_HOTKEY = /\s*\((?:y|p|esc|a|n)\)\s*$/;

const codexHead = (l) => {
  if (l.includes(CODEX_HEAD)) return { kind: 'exec' };
  if (l.includes(CODEX_PATCH_HEAD)) return { kind: 'patch' };
  const m = l.trim().match(CODEX_MCP_HEAD);
  return m ? { kind: 'mcp', server: m[1], tool: m[2] } : null;
};

/** The menu's options from its first `1.` on: `{ options, cursorAt }`. */
function codexOptions(lines, { columns = false } = {}) {
  const options = [];
  let cursorAt = -1;
  for (const raw of lines) {
    const m = raw.match(CODEX_OPTION);
    if (m && Number(m[2]) === options.length + 1) {
      if (m[1]) cursorAt = options.length;
      // The MCP form: `Allow for this session  Run the tool and …` — label, 2+ spaces, description.
      const [label, ...rest] = columns ? m[3].trim().split(/\s{2,}/) : [m[3].trim()];
      options.push({ label, description: rest.join(' ') });
    } else if (raw.trim() && options.length) {
      const o = options[options.length - 1];
      // A wrapped option: its (p) lands on the next line; a wrapped MCP description.
      if (columns) o.description = `${o.description} ${raw.trim()}`.trim();
      else o.label = `${o.label} ${raw.trim()}`;
    }
  }
  for (const o of options) o.label = o.label.replace(CODEX_HOTKEY, '');
  return { options, cursorAt };
}

/** The menu's first option: the last `1.` before the footer that carries the cursor or reads `Yes,` / `Allow`. */
function firstOptionAt(block) {
  for (let i = block.length - 1; i >= 0; i -= 1) {
    const m = block[i].match(CODEX_OPTION);
    if (m && m[2] === '1' && (m[1] || /^(Yes,|Allow\b)/.test(m[3]))) return i;
  }
  return -1;
}

/**
 * The approval menu Codex shows, as `{ id, kind, questions: [q], untouched, cursorAt }` (+ `files`,
 * the absolute paths a patch edits); null when none. `kind`: 'exec' | 'patch' | 'mcp'.
 * `request`: the row's `approval_id` (the pending call, or the hook's stamp) — mixed into the id,
 * so the same request asked again is a new card, and a card for an earlier request cannot answer
 * a later one with the same text. `cwd`: a patch's files are shown relative to it.
 */
export function parseCodexScreenPrompt(screen, { request = null, cwd = null } = {}) {
  const lines = String(screen ?? '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let head = -1;
  let found = null;
  for (let i = lines.length - 1; i >= 0 && head < 0; i -= 1) {
    found = codexHead(lines[i]);
    if (found) head = i;
  }
  if (head < 0) return null;
  const footRe = found.kind === 'mcp' ? CODEX_MCP_FOOT : CODEX_FOOT;
  const foot = lines.findIndex((l, i) => i > head && footRe.test(l));
  if (foot < 0) return null;
  const block = lines.slice(head + 1, foot);
  const firstOption = firstOptionAt(block);
  if (firstOption < 0) return null;
  const { options, cursorAt } = codexOptions(block.slice(firstOption), { columns: found.kind === 'mcp' });
  if (options.length < 2) return null;
  const before = block.slice(0, firstOption);

  let question;
  let header = 'Approval';
  let files;
  let sigExtra = []; // a patch's id is its absolute files, not the cwd-relative text
  if (found.kind === 'exec') {
    const meta = { thread: '', reason: '' };
    const cmd = [];
    let field = null;
    for (const raw of before) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith('$ ') && !cmd.length) {
        cmd.push(l.slice(2));
        field = 'cmd';
      } else if (field === 'cmd') {
        cmd.push(l);
      } else if (/^Thread:\s/.test(l)) {
        meta.thread = l.replace(/^Thread:\s*/, '');
        field = null;
      } else if (/^Environment:\s/.test(l)) {
        field = null;
      } else if (/^Reason:\s/.test(l)) {
        meta.reason = l.replace(/^Reason:\s*/, '');
        field = 'reason';
      } else if (field === 'reason') {
        meta.reason = `${meta.reason} ${l}`;
      }
    }
    if (!cmd.length) return null;
    // Its "don't ask again" writes a host-wide prefix rule.
    const always = options.findIndex((o) => /^Yes, and don't ask again/i.test(o.label));
    if (always >= 0) {
      const prefix = options[always].label.match(/`([^`]+)`/)?.[1];
      options[always].secondary = true;
      options[always].description = prefix
        ? `Adds a permanent allow rule for commands starting with \`${prefix}\` — for every Codex session on this host`
        : 'Adds a permanent allow rule — for every Codex session on this host';
    }
    question = [CODEX_HEAD, ...(meta.thread ? [`Thread: ${meta.thread}`] : []), `$ ${cmd.join('\n')}`, ...(meta.reason ? [`Reason: ${meta.reason}`] : [])].join('\n');
  } else if (found.kind === 'patch') {
    // `Destination: <path>`, or the label alone and the path on the lines below, hard-wrapped at
    // the pane's width: joined back without spaces.
    files = [];
    let open = false;
    for (const raw of before) {
      const l = raw.trim();
      const d = l.match(/^Destination:\s*(.*)$/);
      if (d) {
        files.push(d[1]);
        open = true;
      } else if (open && l && !/^[A-Z][\w ]*:\s/.test(l)) {
        files[files.length - 1] += l;
      } else {
        open = false;
      }
    }
    files = files.filter(Boolean);
    if (!files.length) return null;
    const base = cwd ? `${String(cwd).replace(/\/+$/, '')}/` : null;
    const shown = files.map((f) => (base && f.startsWith(base) ? f.slice(base.length) : f));
    header = 'Edit approval';
    question = [CODEX_PATCH_HEAD, 'Files:', ...shown.map((f) => `  ${f}`)].join('\n');
    sigExtra = files;
    const these = options.findIndex((o) => /^Yes, and don't ask again for these files/i.test(o.label));
    if (these >= 0) {
      options[these].secondary = true;
      options[these].description = 'Approves edits to these files for the rest of this session, without asking again';
    }
  } else {
    const args = before.map((l) => l.trim()).filter(Boolean);
    header = 'MCP approval';
    question = [lines[head].trim(), ...args].join('\n');
    const name = `${found.server}.${found.tool}`;
    for (const o of options) {
      if (/^Allow for this session$/i.test(o.label)) o.secondary = true;
      if (/^Always allow$/i.test(o.label)) {
        o.secondary = true;
        o.description = `Adds approval_mode = "approve" for ${name} to Codex's config.toml — every later call, in every Codex session on this host`;
      }
    }
  }

  const q = { header, question, multiSelect: false, noOther: true, options };
  const sig = squash([found.kind === 'patch' ? CODEX_PATCH_HEAD : question, ...sigExtra, ...options.map((o) => o.label), ...(request ? [`request ${request}`] : [])].join('\n'));
  const id = `screen:${createHash('sha1').update(sig).digest('hex').slice(0, 12)}`;
  return { id, kind: found.kind, ...(files ? { files } : {}), questions: [q], untouched: cursorAt === 0, cursorAt };
}

const PREVIEW_LINES = 60;
const PREVIEW_WIDTH = 240;

/** A patch's text from a pending call: an `apply_patch` call's input, or `tools.apply_patch("…")` in an exec script. */
function patchOfCall(p) {
  const input = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : '';
  if (p.name === 'apply_patch') return input;
  if (p.name !== 'exec') return null;
  const m = input.match(/tools\.apply_patch\(\s*("(?:[^"\\]|\\.)*")/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * The diff preview of a waiting patch card: the current turn's pending `apply_patch` (no output
 * yet) whose files are exactly the menu's `files` (absolute; a patch's relative paths resolve
 * against `cwd`) and, when the row's `request` is a call id (not the hook's `hook-…` stamp), whose
 * call it is — so a preview never shows another patch than the one asked about. Its lines
 * between `*** Begin Patch` and `*** End Patch`, at most PREVIEW_LINES; null when none matches.
 * The screen stays the truth for what is asked; this only shows what Codex drew above the menu.
 */
export function codexPatchPreview(rolloutText, files, cwd, request = null) {
  const pending = new Map();
  for (const line of String(rolloutText ?? '').split('\n')) {
    if (!/task_started|_call/.test(line)) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    const p = v?.payload;
    if (!p || typeof p !== 'object') continue;
    if (v.type === 'event_msg' && p.type === 'task_started') pending.clear();
    else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      const patch = patchOfCall(p);
      if (patch) pending.set(p.call_id, patch);
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') pending.delete(p.call_id);
  }
  const want = [...new Set(files ?? [])].sort().join('\n');
  const abs = (f) => (f.startsWith('/') || !cwd ? f : `${String(cwd).replace(/\/+$/, '')}/${f}`);
  const only = request && !String(request).startsWith('hook-') ? String(request) : null;
  for (const [callId, patch] of [...pending.entries()].reverse()) {
    if (only && callId !== only) continue;
    const lines = patch.split('\n').filter((l) => !/^\*\*\* (Begin|End) Patch\s*$/.test(l));
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const touched = lines.map((l) => l.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/)?.[1]?.trim()).filter(Boolean);
    if ([...new Set(touched.map(abs))].sort().join('\n') !== want) continue;
    const shown = lines.slice(0, PREVIEW_LINES).map((l) => (l.length > PREVIEW_WIDTH ? `${l.slice(0, PREVIEW_WIDTH - 1)}…` : l));
    if (lines.length > PREVIEW_LINES) shown.push(`… ${lines.length - PREVIEW_LINES} more lines`);
    return shown.join('\n');
  }
  return null;
}

/**
 * The option a screen answer ends on, when it is one Enter on one option (single-select, no
 * text — every Codex approval): the server checks the cursor is there before that Enter.
 * Null otherwise.
 */
export function finalPick(questions, answers) {
  if (questions.length !== 1 || questions[0].multiSelect || answers[0].text) return null;
  return answers[0].options[0];
}

/** The screen-prompt parser for a session's harness; null when it has none. */
export function screenPromptParser(harness) {
  if (!harness || harness === 'claude') return parseScreenPrompt;
  if (harness === 'codex') return parseCodexScreenPrompt;
  return null;
}
