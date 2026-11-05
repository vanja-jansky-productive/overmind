//! Mining lessons from a finished session (docs/lessons.md → "Getting them in").
//!
//! Once per session, at close (the `SessionEnd` hook), from where the last mine of that session
//! stopped: the transcript is compacted to prompts, replies and tool failures, one `claude -p`
//! proposes at most [`MAX_PROPOSALS`] lessons as JSON, and each one is checked before it is
//! queued — its evidence quote must be in the transcript, and it must not look like a rejected,
//! retired or already proposed lesson. One that looks like an active lesson confirms it instead.

use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::core::lessons::{self, Draft, Evidence, Known, Store};
use crate::error::{Error, Result};

/// A session with fewer prompts (since the last mine) is not mined.
pub const MIN_PROMPTS: usize = 3;
pub const MAX_PROPOSALS: usize = 3;
/// The compacted transcript the model reads: the head and the (longer) tail past this.
const MAX_CHARS: usize = 80_000;
const HEAD_CHARS: usize = 20_000;
/// One reply / tool line in the compact form.
const REPLY_CHARS: usize = 1_500;
const TOOL_CHARS: usize = 160;
pub const DEFAULT_MODEL: &str = "sonnet";
const DEADLINE: Duration = Duration::from_secs(240);

/// A transcript slice, compacted.
#[derive(Debug, Default)]
pub struct Compact {
    /// What the model reads.
    pub text: String,
    /// Every prompt and reply in full, whitespace-folded and lowercased: where quotes are checked.
    pub haystack: String,
    /// Human prompts in the slice.
    pub prompts: usize,
    /// Byte offset just past the last complete line read.
    pub end: u64,
}

fn fold(s: &str) -> String {
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn cut(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut t: String = s.chars().take(n).collect();
    t.push('…');
    t
}

/// Compact the transcript from byte `from` (a line start: where the last mine ended).
pub fn compact(path: &Path, from: u64) -> Result<Compact> {
    let bytes = std::fs::read(path)?;
    let from = (from as usize).min(bytes.len());
    let slice = &bytes[from..];
    // Only complete lines: a session still writing leaves a partial last one.
    let complete = slice.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let text = String::from_utf8_lossy(&slice[..complete]);
    let mut c = Compact {
        end: (from + complete) as u64,
        ..Default::default()
    };
    let mut out = String::new();
    let mut hay = String::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v["isSidechain"] == true || v["isMeta"] == true || v["isCompactSummary"] == true {
            continue;
        }
        let content = &v["message"]["content"];
        match v["type"].as_str() {
            Some("user") => {
                let human = match v["origin"]["kind"].as_str() {
                    Some(kind) => kind == "human",
                    None => v["origin"].is_null(),
                };
                let mut typed = Vec::new();
                match content {
                    Value::String(s) => typed.push(s.as_str()),
                    Value::Array(parts) => {
                        for p in parts {
                            match p["type"].as_str() {
                                Some("text") => typed.extend(p["text"].as_str()),
                                Some("tool_result") if p["is_error"] == true => {
                                    let t = tool_text(&p["content"]);
                                    out.push_str(&format!(
                                        "[tool failed: {}]\n",
                                        cut(&t, TOOL_CHARS)
                                    ));
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                for t in typed {
                    // Command and hook wrappers are not the person talking.
                    if t.trim_start().starts_with('<') {
                        continue;
                    }
                    if human {
                        c.prompts += 1;
                    }
                    out.push_str(&format!("USER: {}\n", t.trim()));
                    hay.push_str(&fold(t));
                    hay.push(' ');
                }
            }
            Some("assistant") => {
                let Value::Array(parts) = content else {
                    continue;
                };
                for p in parts {
                    match p["type"].as_str() {
                        Some("text") => {
                            let t = p["text"].as_str().unwrap_or_default();
                            out.push_str(&format!("ASSISTANT: {}\n", cut(t, REPLY_CHARS)));
                            hay.push_str(&fold(t));
                            hay.push(' ');
                        }
                        Some("tool_use") => {
                            let name = p["name"].as_str().unwrap_or("tool");
                            let input = &p["input"];
                            let what = input["command"]
                                .as_str()
                                .or(input["file_path"].as_str())
                                .or(input["pattern"].as_str())
                                .or(input["description"].as_str())
                                .unwrap_or_default();
                            out.push_str(&format!("[{name}: {}]\n", cut(what, TOOL_CHARS)));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    if out.chars().count() > MAX_CHARS {
        let head: String = out.chars().take(HEAD_CHARS).collect();
        let skip = out.chars().count() - (MAX_CHARS - HEAD_CHARS);
        let tail: String = out.chars().skip(skip).collect();
        out = format!("{head}\n[… middle of the session left out …]\n{tail}");
    }
    c.text = out;
    c.haystack = hay;
    Ok(c)
}

fn tool_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// The instructions the model gets, with the session and what it must not propose again.
pub fn prompt(c: &Compact, repo: Option<&str>, avoid: &[String]) -> String {
    let avoid = if avoid.is_empty() {
        "(none yet)".to_string()
    } else {
        avoid
            .iter()
            .map(|t| format!("- {t}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let repo = repo.unwrap_or("(not a GitHub repo)");
    format!(
        "You review a finished coding-agent session and extract LESSONS: durable, transferable rules \
about how the agent should do its work, learned the hard way in this session. Good sources: the user \
correcting the agent, an approach that failed before one worked, a convention or caveat of the repo \
discovered along the way, a wrong assumption that cost time.\n\
\n\
Not lessons: facts about this one task, things any competent agent already does, summaries of what \
was built, anything that only restates the user's request.\n\
\n\
Propose at most {MAX_PROPOSALS}, and none when nothing qualifies — an empty list is the usual answer. \
Each one:\n\
- \"title\": a short name for the situation (max 10 words)\n\
- \"rule\": what to do, starting with the situation: \"When …, …\" (1-3 sentences)\n\
- \"consequence\": what went wrong, or goes wrong, without it (1 sentence)\n\
- \"kind\": approach | friction | intuition | style\n\
- \"scope\": \"repo\" when it only holds in this repository ({repo}), else \"global\"\n\
- \"quote\": a VERBATIM excerpt (one or two sentences, copied exactly) from a USER or ASSISTANT line \
below that shows it — prefer the user's own words\n\
\n\
Do not propose anything that repeats one of these known, rejected or retired lessons:\n{avoid}\n\
\n\
Answer with only a JSON array, no prose, no code fence. Example: \
[{{\"title\":\"…\",\"rule\":\"When …, …\",\"consequence\":\"…\",\"kind\":\"approach\",\"scope\":\"global\",\"quote\":\"…\"}}]\n\
\n\
SESSION:\n{}",
        c.text
    )
}

/// One proposal from the model's answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Raw {
    pub title: String,
    pub rule: String,
    pub consequence: String,
    pub kind: String,
    pub scope: String,
    pub quote: String,
}

/// The JSON array in a model answer (code fences and prose around it tolerated).
pub fn parse_answer(answer: &str) -> Vec<Raw> {
    let (Some(a), Some(b)) = (answer.find('['), answer.rfind(']')) else {
        return Vec::new();
    };
    if b < a {
        return Vec::new();
    }
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&answer[a..=b]) else {
        return Vec::new();
    };
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().trim().to_string();
    items
        .iter()
        .map(|v| Raw {
            title: s(v, "title"),
            rule: s(v, "rule"),
            consequence: s(v, "consequence"),
            kind: s(v, "kind"),
            scope: s(v, "scope"),
            quote: s(v, "quote"),
        })
        .filter(|r| !r.rule.is_empty())
        .take(MAX_PROPOSALS)
        .collect()
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub session: Option<String>,
    pub skipped: Option<String>,
    pub proposed: Vec<String>,
    pub confirmed: Vec<String>,
    /// Dropped proposals: why.
    pub dropped: Vec<String>,
}

pub struct Opts<'a> {
    pub transcript: &'a Path,
    pub session: Option<&'a str>,
    pub cwd: Option<&'a str>,
    pub model: &'a str,
    /// Mine from the start, not from where the last mine stopped.
    pub again: bool,
}

/// The titles the model must not repeat: every rejection, retired and active lesson, and every
/// open proposal (newest first, capped so the prompt stays small).
fn avoid_list(s: &Store) -> Vec<String> {
    let mut out: Vec<String> = s.rejected.iter().rev().map(|r| r.title.clone()).collect();
    out.extend(s.lessons.iter().rev().map(|l| l.title.clone()));
    out.extend(s.proposals.iter().map(|p| p.draft.title.clone()));
    out.truncate(150);
    out
}

/// Mine one transcript with `ask` (a `claude -p` call in production).
pub fn mine_with(o: &Opts, ask: impl FnOnce(&str) -> Result<String>) -> Result<Report> {
    let session = o.session.map(String::from).or_else(|| {
        o.transcript
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
    });
    let mut rep = Report {
        session: session.clone(),
        ..Default::default()
    };
    let store = lessons::load()?;
    let from = match (&session, o.again) {
        (Some(sid), false) => store.mined.get(sid).copied().unwrap_or(0),
        _ => 0,
    };
    let c = compact(o.transcript, from)?;
    // Too little to mine: the offset stays, so a resumed session is judged on all of it.
    if c.prompts < MIN_PROMPTS {
        rep.skipped = Some(format!(
            "{} new prompt(s), fewer than {MIN_PROMPTS}",
            c.prompts
        ));
        return Ok(rep);
    }
    let repo = o
        .cwd
        .and_then(|d| crate::core::git::head_of(Path::new(d)))
        .and_then(|h| h.repo);
    let answer = ask(&prompt(&c, repo.as_deref(), &avoid_list(&store)))?;
    let raws = parse_answer(&answer);
    let now = lessons::now_iso();
    lessons::update(|s| {
        for r in raws {
            let quote_ok = !r.quote.is_empty() && c.haystack.contains(&fold(&r.quote));
            if !quote_ok {
                rep.dropped
                    .push(format!("{}: its quote is not in the session", r.title));
                continue;
            }
            let ev = Evidence {
                kind: "session".into(),
                quote: r.quote.clone(),
                at: now.clone(),
                session: session.clone(),
            };
            match s.known(&r.title, &r.rule) {
                Known::Active(id) => {
                    if let Ok(i) = s.find(&id) {
                        s.lessons[i].confirm(Some(ev), &now);
                        rep.confirmed.push(id);
                    }
                }
                Known::New => {
                    let scope = if r.scope == "repo" && repo.is_some() {
                        "repo"
                    } else {
                        "global"
                    };
                    let kind = Some(r.kind.to_lowercase())
                        .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric()));
                    let d = Draft {
                        kind,
                        title: r.title.clone(),
                        rule: r.rule.clone(),
                        consequence: r.consequence.clone(),
                        scope: Some(scope.into()),
                        repo: (scope == "repo").then(|| repo.clone()).flatten(),
                        tier: Some(1),
                        evidence: vec![ev],
                    };
                    rep.proposed
                        .push(s.propose(d, session.as_deref(), o.cwd, &now));
                }
                other => rep.dropped.push(format!("{}: {other:?}", r.title)),
            }
        }
        if let Some(sid) = &session {
            s.mined.insert(sid.clone(), c.end);
        }
        Ok(())
    })?;
    Ok(rep)
}

/// Mine with `claude -p` (`lessons.mineModel`, default `sonnet`).
pub fn mine(o: &Opts) -> Result<Report> {
    mine_with(o, |p| {
        crate::core::naming::ask_claude(p, o.model, DEADLINE, &AtomicBool::new(false))
            .map_err(|e| Error::Other(format!("mining failed: {e}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: Value) -> String {
        serde_json::to_string(&v).unwrap() + "\n"
    }

    pub fn transcript(prompts: &[&str]) -> String {
        let mut t = String::new();
        for p in prompts {
            t += &line(serde_json::json!({
                "type": "user", "origin": {"kind": "human"},
                "message": {"role": "user", "content": p}
            }));
            t += &line(serde_json::json!({
                "type": "assistant",
                "message": {"role": "assistant", "content": [
                    {"type": "text", "text": format!("ok: {p}")},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "cargo test"}}
                ]}
            }));
            t += &line(serde_json::json!({
                "type": "user",
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "is_error": true, "content": "boom"}
                ]}
            }));
        }
        t += &line(
            serde_json::json!({"type": "user", "isMeta": true, "message": {"content": "meta"}}),
        );
        t
    }

    #[test]
    fn compacts_prompts_replies_and_failures() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let text = transcript(&["first", "Do NOT   push to main"]);
        std::fs::write(&p, format!("{text}{{\"partial\":")).unwrap();
        let c = compact(&p, 0).unwrap();
        assert_eq!(c.prompts, 2);
        assert_eq!(c.end, text.len() as u64);
        assert!(
            c.text
                .contains("USER: Do NOT   push to main\nASSISTANT: ok: Do NOT")
        );
        assert!(c.text.contains("[Bash: cargo test]\n[tool failed: boom]"));
        assert!(!c.text.contains("meta"));
        assert!(c.haystack.contains("do not push to main"));
        // From the offset on, nothing is new.
        assert_eq!(compact(&p, c.end).unwrap().prompts, 0);
    }

    #[test]
    fn parses_answers_leniently() {
        let a = "Here:\n```json\n[{\"title\":\"T\",\"rule\":\"When x, y\",\"quote\":\"q\"},{\"title\":\"no rule\"}]\n```";
        let r = parse_answer(a);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].rule, "When x, y");
        assert!(parse_answer("nothing").is_empty());
        assert!(parse_answer("[]").is_empty());
        assert!(parse_answer("] oops [").is_empty());
    }

    #[test]
    fn prompt_lists_what_to_avoid() {
        let c = Compact {
            text: "USER: hi\n".into(),
            ..Default::default()
        };
        let p = prompt(&c, Some("o/n"), &["Old one".into()]);
        assert!(p.contains("- Old one") && p.contains("(o/n)") && p.ends_with("USER: hi\n"));
    }
}
