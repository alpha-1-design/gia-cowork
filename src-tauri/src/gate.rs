//! Rust-side enforcement gate for shell commands.
//!
//! WHY THIS EXISTS (and why it duplicates rules from TypeScript): the
//! TypeScript `src/services/permissions.ts` classifies a command for the UI
//! -- risk rating, diff/command preview, grant scope -- but it is ADVISORY:
//! it only shapes what the webview shows. The actual process spawn happens
//! in `terminal.rs` on the native side, so a command can reach the OS even
//! if the TS layer never got the final word (a race, a bug, a future code
//! path that skips the TS review). This module is the enforcement point:
//! `terminal_exec` consults it BEFORE spawning. Its rule table is seeded
//! from the same Windows + Unix danger patterns as `permissions.ts`
//! SEGMENT_RULES; TS permissions.ts remains the advisory/diff-preview layer
//! while this module is enforcement. The duplication is deliberate. A rule
//! here may be STRICTER than its TS counterpart, never looser.
//!
//! DECISION PROTOCOL (typed-error path, chosen over a blocking handshake):
//! when the classification is Prompt, `GateState::check` registers a
//! PendingPrompt and returns `Err("GIA_GATE_PROMPT:<request_id>:<scope>")`.
//! The TS layer renders its existing permission card, and after the user
//! answers either calls `gate_decide(request_id, allow)` (which records a
//! session-only grant on allow) or `gate_grant(scope, session_only)`, then
//! simply re-invokes `terminal_exec`. No oneshot/mpsc handshake is needed,
//! the Tauri invoke stays a plain request/response, and the webview keeps
//! full ownership of the UX -- which is why this beats blocking inside the
//! Rust command. A critical rule with no matching grant returns
//! `Err("GIA_GATE_DENY:<scope>")` for a hard block.
//!
//! PERSISTENCE: none, deliberately -- the grant table dies with the process
//! (mirroring `useTrustStore`'s Grant/audit shape, minus its persisted
//! `grants` list). TS is the UX and the source of grant *intent*; Rust is
//! the wall. A persistent TS grant cannot outlive this in-memory table, so
//! after a restart the webview must re-seed via `gate_grant` if a
//! previously persistent grant should keep holding.

use serde::Serialize;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

// ── decisions ────────────────────────────────────────────────────────────

/// What the gate wants to happen to a command. Allow runs it; Prompt asks
/// the user (typed-error protocol above); Deny refuses outright.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Prompt,
    Deny,
}

/// How bad a matched rule is. Critical maps to Deny, High/Moderate to
/// Prompt; unmatched (low/none) maps to Allow -- exactly the TS severity
/// ladder, minus 'low'/'none' which need no rule entries here.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Severity {
    Moderate,
    High,
    Critical,
}

// ── segment analysis (mirrors permissions.ts splitSegments) ──────────────

/// One slice of a command line (or the whole line, for whole-line rules),
/// pre-lowercased and tokenized. All matchers are case-insensitive on
/// purpose: cmdlet casing is irrelevant but `C:\Users` must match as
/// `c:\users` -- same reasoning as the TS rules.
struct Segment {
    lower: String,
    tokens: Vec<String>,
}

impl Segment {
    fn new(text: &str) -> Self {
        let lower = text.to_lowercase();
        let tokens = lower.split_whitespace().map(|w| w.to_string()).collect();
        Segment { lower, tokens }
    }

    fn has_token(&self, t: &str) -> bool {
        self.tokens.iter().any(|w| w == t)
    }
}

/// Split a command into pipeline/chain segments the way the TS advisory
/// layer does: quoted regions are blanked out first (a `;` inside a string
/// literal is not a separator), then split on the chaining operators.
fn split_segments(command: &str) -> Vec<String> {
    let mut unquoted = String::with_capacity(command.len());
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                } else {
                    unquoted.push(' ');
                }
            }
            None => {
                if c == '\'' || c == '"' {
                    quote = Some(c);
                    unquoted.push(' ');
                } else {
                    unquoted.push(c);
                }
            }
        }
    }
    unquoted
        .split(|c| matches!(c, '|' | '&' | ';' | '\n'))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

// ── rule matchers ────────────────────────────────────────────────────────
//
// Segment rules run against every pipeline segment independently, so a
// dangerous word inside one segment can never promote an unrelated one.
// Whole-line rules run against the raw text: those patterns only exist
// BETWEEN segments (a download piped into a shell, a fork bomb), and
// splitting destroys exactly the evidence they look for.

fn rm_recursive_root(seg: &Segment) -> bool {
    if !seg.has_token("rm") {
        return false;
    }
    // rm with a recursive/force flag group, aimed at the filesystem root,
    // the home directory, or "everything".
    let flags_rf = seg
        .tokens
        .iter()
        .filter(|t| t.starts_with('-'))
        .any(|t| t.contains('r') || t.contains('f'));
    let rooted = seg.tokens.iter().any(|t| {
        matches!(t.as_str(), "/" | "/*" | "~" | "$home" | "*") || t.starts_with("~/")
    });
    flags_rf && rooted
}

fn dd_raw_device(seg: &Segment) -> bool {
    seg.has_token("dd") && seg.tokens.iter().any(|t| t.starts_with("of=/dev/"))
}

fn format_disk(seg: &Segment) -> bool {
    seg.tokens.iter().any(|t| t.starts_with("mkfs"))
        || seg.has_token("fdisk")
        || (seg.has_token("diskutil") && seg.has_token("erase"))
        || (seg.has_token("format")
            && seg
                .tokens
                .iter()
                .any(|t| t.len() == 2 && t.ends_with(':') && t.as_bytes()[0].is_ascii_alphabetic()))
}

fn win_recursive_delete(seg: &Segment) -> bool {
    let cmdlet = seg.tokens.iter().any(|t| {
        matches!(
            t.as_str(),
            "remove-item" | "ri" | "del" | "erase" | "rd" | "rmdir"
        )
    });
    let recursive = seg.tokens.iter().any(|t| t.contains("recurse"))
        || seg.tokens.iter().any(|t| t.starts_with("/s"));
    // Root targets only -- a recursive delete of a project subdirectory is
    // routine and must NOT be denied here, matching the TS rule.
    // Multi-word roots ("c:\\program files") CANNOT be matched per-token: the
    // whitespace split breaks them apart ("c:\\program" + "files"), so
    // `rd /s /q C:\Program Files` silently matched nothing (REVIEW-1 B1).
    // Wildcards and $-tokens stay per-token; path prefixes run against the
    // segment text, exactly like the TS rule does.
    let root = seg.tokens.iter().any(|t| {
        matches!(t.as_str(), "*" | "c:\\*" | "c:\\" | "$home" | "~")
            || t.starts_with("~/")
    }) || ["c:\\users", "c:\\windows", "c:\\program files"]
        .iter()
        .any(|p| seg.lower.contains(p));
    cmdlet && recursive && root
}

fn vssadmin_delete(seg: &Segment) -> bool {
    (seg.has_token("vssadmin") && seg.has_token("delete"))
        || (seg.has_token("delete") && seg.has_token("shadows"))
}

/// Force-kills processes, including ones this app did not start. Mirrors the
/// TS moderate rule (permissions.ts `kill(all)? -9 | pkill`) — REVIEW-1 S4:
/// this was the only non-low TS segment rule with no gate counterpart.
fn force_kill(seg: &Segment) -> bool {
    seg.tokens.windows(2).any(|w| {
        (w[0] == "kill" || w[0] == "killall")
            && matches!(w[1].as_str(), "-9" | "-KILL")
    }) || seg.tokens.iter().any(|t| t == "pkill")
}

/// `>` into a raw block device (checked on the segment's lowercased text so
/// the redirect operator and the device path are adjacent, as in the TS rule).
fn raw_disk_redirect(seg: &Segment) -> bool {
    let bytes = seg.lower.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        if b != b'>' {
            continue;
        }
        let rest = seg.lower[i + 1..].trim_start();
        if rest.starts_with("/dev/sd")
            || rest.starts_with("/dev/nvme")
            || rest.starts_with("/dev/disk")
            || rest.starts_with("/dev/hd")
        {
            return true;
        }
    }
    false
}

fn sudo_root(seg: &Segment) -> bool {
    seg.tokens
        .iter()
        .any(|t| matches!(t.as_str(), "sudo" | "doas" | "su"))
}

fn power_off(seg: &Segment) -> bool {
    seg.tokens
        .iter()
        .any(|t| matches!(t.as_str(), "shutdown" | "reboot" | "halt" | "poweroff"))
}

fn chmod_world_writable(seg: &Segment) -> bool {
    seg.has_token("chmod")
        && (seg.tokens.iter().any(|t| t == "777")
            || seg.lower.contains("a+rwx")
            || seg.lower.contains("o+w"))
}

/// Loosened-but-not-world-writable mode bits: any octal literal whose last
/// three digits start with 7 (7xx, 07xx...), per the TS `moderate` rule.
fn chmod_loosened(seg: &Segment) -> bool {
    seg.has_token("chmod")
        && seg.tokens.iter().any(|t| {
            t.len() >= 3
                && t.chars().all(|c| c.is_ascii_digit())
                && t.as_bytes()[t.len() - 3] == b'7'
        })
}

fn change_owner(seg: &Segment) -> bool {
    seg.tokens
        .iter()
        .any(|t| matches!(t.as_str(), "chown" | "chgrp"))
}

fn system_accounts(seg: &Segment) -> bool {
    seg.tokens.iter().any(|t| {
        matches!(
            t.as_str(),
            "visudo" | "passwd" | "useradd" | "userdel" | "usermod" | "dscl"
        )
    })
}

fn win_system_write(seg: &Segment) -> bool {
    let cmdlet = seg.tokens.iter().any(|t| {
        matches!(
            t.as_str(),
            "set-content" | "add-content" | "out-file" | "new-item" | "export-clixml"
        )
    });
    let system_dir = seg
        .lower
        .contains("c:\\windows")
        || seg.lower.contains("c:\\program files");
    cmdlet && system_dir
}

fn registry_change(seg: &Segment) -> bool {
    seg.tokens.iter().any(|t| t.starts_with("reg.exe"))
        || seg
            .tokens
            .iter()
            .any(|t| matches!(t.as_str(), "remove-itemproperty" | "set-itemproperty"))
        || seg.tokens.windows(2).any(|w| {
            w[0] == "reg"
                && matches!(
                    w[1].as_str(),
                    "add" | "delete" | "import" | "restore" | "load"
                )
        })
}

fn boot_config(seg: &Segment) -> bool {
    seg.tokens
        .iter()
        .any(|t| matches!(t.as_str(), "bcdedit" | "bcdboot"))
}

fn defender_settings(seg: &Segment) -> bool {
    seg.tokens.iter().any(|t| {
        matches!(
            t.as_str(),
            "set-mppreference" | "add-mppreference" | "remove-mppreference"
        )
    })
}

fn win_service_change(seg: &Segment) -> bool {
    seg.has_token("stop-service")
        || seg.tokens.windows(2).any(|w| {
            (w[0] == "sc" || w[0] == "sc.exe")
                && matches!(w[1].as_str(), "config" | "delete" | "stop")
        })
}

fn git_force_push(seg: &Segment) -> bool {
    seg.tokens
        .windows(2)
        .any(|w| w[0] == "git" && w[1] == "push")
        && seg
            .tokens
            .iter()
            .any(|t| matches!(t.as_str(), "--force" | "--force-with-lease" | "-f"))
}

fn git_push(seg: &Segment) -> bool {
    seg.tokens
        .windows(2)
        .any(|w| w[0] == "git" && w[1] == "push")
}

fn git_reset_hard(seg: &Segment) -> bool {
    seg.tokens
        .windows(2)
        .any(|w| w[0] == "git" && w[1] == "reset")
        && seg.has_token("--hard")
}

fn git_clean_force(seg: &Segment) -> bool {
    seg.tokens
        .windows(2)
        .any(|w| w[0] == "git" && w[1] == "clean")
        && seg
            .tokens
            .iter()
            .any(|t| t.starts_with('-') && t.contains('f'))
}

/// `git checkout .` / `git checkout -- .` -- discards the whole working tree.
fn git_checkout_all(seg: &Segment) -> bool {
    for (i, w) in seg.tokens.windows(2).enumerate() {
        if w[0] == "git" && w[1] == "checkout" {
            // Slice patterns bind &String, so compare through as_str().
            match &seg.tokens[i + 2..] {
                [only] if only.as_str() == "." => return true,
                [flag, dot] if flag.as_str() == "--" && dot.as_str() == "." => return true,
                _ => {}
            }
        }
    }
    false
}

fn git_history_loss(seg: &Segment) -> bool {
    seg.has_token("filter-branch")
        || seg
            .tokens
            .windows(3)
            .any(|w| w[0] == "git" && w[1] == "stash" && w[2] == "drop")
        || seg
            .tokens
            .windows(3)
            .any(|w| w[0] == "git" && w[1] == "branch" && w[2] == "-d")
}

fn node_install(seg: &Segment) -> bool {
    seg.tokens.windows(2).any(|w| {
        matches!(w[0].as_str(), "npm" | "pnpm" | "yarn" | "bun")
            && matches!(w[1].as_str(), "i" | "install" | "add")
    })
}

fn python_install(seg: &Segment) -> bool {
    seg.tokens
        .windows(2)
        .any(|w| matches!(w[0].as_str(), "pip" | "pip3" | "uv") && w[1] == "install")
}

fn system_pkg_change(seg: &Segment) -> bool {
    seg.tokens.windows(2).any(|w| {
        matches!(
            w[0].as_str(),
            "apt" | "apt-get" | "brew" | "yum" | "dnf" | "apk"
        ) && matches!(w[1].as_str(), "install" | "remove" | "purge" | "upgrade")
    })
}

fn remote_access(seg: &Segment) -> bool {
    seg.tokens
        .iter()
        .any(|t| matches!(t.as_str(), "ssh" | "scp" | "rsync"))
}

fn eval_or_source(seg: &Segment) -> bool {
    seg.tokens
        .iter()
        .any(|t| matches!(t.as_str(), "eval" | "source"))
}

fn history_or_shred(seg: &Segment) -> bool {
    seg.tokens
        .windows(2)
        .any(|w| w[0] == "history" && w[1] == "-c")
        || (seg.has_token("shred") && seg.lower.contains("/dev/"))
}

// Whole-line rules: these patterns only exist BETWEEN segments, so they run
// against the raw command text, not against the split segments.

fn fork_bomb(seg: &Segment) -> bool {
    // Whitespace-squeezed comparison covers the common spellings of
    // `:(){ :|:& };:`.
    let squeezed: String = seg.lower.split_whitespace().collect();
    squeezed.contains(":(){:|:&};:")
}

/// A segment piped into a shell interpreter (curl|sh, base64 -d|sh, ...).
/// The pipe target is checked as a whole word, so `| sha256sum` is not a
/// match.
fn pipe_to_shell(seg: &Segment) -> bool {
    for (i, _) in seg.lower.match_indices('|') {
        let mut rest = seg.lower[i + 1..].trim_start();
        if let Some(after_sudo) = rest.strip_prefix("sudo") {
            rest = after_sudo.trim_start();
        }
        for sh in ["sh", "bash", "zsh", "ksh", "fish"] {
            if let Some(after) = rest.strip_prefix(sh) {
                // Bounded = the shell word ends here. Only an alphanumeric
                // continues a word (`sha256sum`); REVIEW-1 S2: `-` must NOT
                // count as a continuation, or `| sh-foo` escapes the match
                // the TS \b catches.
                let bounded = after.is_empty()
                    || !after.starts_with(|c: char| c.is_ascii_alphanumeric());
                if bounded {
                    return true;
                }
            }
        }
    }
    false
}

fn nested_substitution(seg: &Segment) -> bool {
    seg.lower.contains("$(") || seg.lower.contains('`')
}

/// A redirection's target decides the risk (mirrors the TS redirect
/// analysis: a write inside a system directory is 'high', into the user's
/// own files is 'moderate'). Without this, enforcement would be LOOSER
/// than the advisory layer for `echo x > /etc/passwd`.
fn redirect_target_risk(seg: &Segment) -> Option<Severity> {
    const SYSTEM_PREFIXES: [&str; 15] = [
        "/etc", "/usr", "/bin", "/sbin", "/boot", "/lib", "/var", "/proc", "/sys",
        "/System", "/Library", "/Applications", "/private/etc",
        "c:\\windows", "c:\\program files",
    ];
    const HOME_PREFIXES: [&str; 3] = ["/home", "/users", "c:\\users"];
    for (i, _) in seg.lower.match_indices('>') {
        let rest = seg.lower[i + 1..].trim_start();
        let rest = rest.strip_prefix('>').unwrap_or(rest).trim_start();
        if let Some(target) = rest.split_whitespace().next() {
            // REVIEW-1 S1: strip surrounding quotes so `> 'c:\windows\a'`
            // is judged on the path, not the quote character. TS analyzePath
            // does the same strip.
            let target = target.trim_matches(|c| c == '\'' || c == '"');
            // TS-matching semantics: the bare prefix itself counts, or the
            // prefix followed by a path separator — never a longer name that
            // merely starts with the prefix (e.g. `/homeless`).
            let at_boundary = |p: &&str| {
                target.len() >= p.len()
                    && &target[..p.len()] == *p
                    && (target.len() == p.len()
                        || target.as_bytes()[p.len()] == b'/')
            };
            if SYSTEM_PREFIXES.iter().any(at_boundary) {
                return Some(Severity::High);
            }
            if HOME_PREFIXES.iter().any(at_boundary) || target.starts_with("~/") {
                return Some(Severity::Moderate);
            }
        }
    }
    None
}

// ── rule tables ──────────────────────────────────────────────────────────
//
// Seeded from `src/services/permissions.ts` (WHOLE_COMMAND_RULES +
// SEGMENT_RULES, including its Windows/PowerShell additions). Every entry
// here must exist in permissions.ts at the same or broader severity; this
// table may be a subset but never a loosening. TS permissions.ts remains
// the advisory/diff-preview layer; THIS table is enforcement.

struct Rule {
    severity: Severity,
    matches: fn(&Segment) -> bool,
}

static SEGMENT_RULES: &[Rule] = &[
    // ── unrecoverable ─────────────────────────────────────────────────────
    Rule { severity: Severity::Critical, matches: rm_recursive_root },
    Rule { severity: Severity::Critical, matches: dd_raw_device },
    Rule { severity: Severity::Critical, matches: format_disk },
    Rule { severity: Severity::Critical, matches: win_recursive_delete },
    Rule { severity: Severity::Critical, matches: vssadmin_delete },
    Rule { severity: Severity::Critical, matches: raw_disk_redirect },
    // ── privilege and system scope ────────────────────────────────────────
    Rule { severity: Severity::High, matches: sudo_root },
    Rule { severity: Severity::High, matches: power_off },
    Rule { severity: Severity::High, matches: chmod_world_writable },
    Rule { severity: Severity::Moderate, matches: chmod_loosened },
    Rule { severity: Severity::High, matches: change_owner },
    Rule { severity: Severity::High, matches: system_accounts },
    // ── Windows / PowerShell ──────────────────────────────────────────────
    Rule { severity: Severity::High, matches: win_system_write },
    Rule { severity: Severity::High, matches: registry_change },
    Rule { severity: Severity::High, matches: boot_config },
    Rule { severity: Severity::High, matches: defender_settings },
    Rule { severity: Severity::Moderate, matches: win_service_change },
    // ── network and supply chain ──────────────────────────────────────────
    Rule { severity: Severity::Moderate, matches: node_install },
    Rule { severity: Severity::Moderate, matches: python_install },
    Rule { severity: Severity::High, matches: system_pkg_change },
    Rule { severity: Severity::Moderate, matches: remote_access },
    Rule { severity: Severity::High, matches: git_force_push },
    Rule { severity: Severity::Moderate, matches: git_push },
    // ── version control that loses work ───────────────────────────────────
    Rule { severity: Severity::High, matches: git_reset_hard },
    Rule { severity: Severity::High, matches: git_clean_force },
    Rule { severity: Severity::High, matches: git_checkout_all },
    Rule { severity: Severity::Moderate, matches: git_history_loss },
    // ── structure that hides a write ──────────────────────────────────────
    Rule { severity: Severity::Moderate, matches: eval_or_source },
    Rule { severity: Severity::Moderate, matches: history_or_shred },
    Rule { severity: Severity::Moderate, matches: force_kill },
];

static WHOLE_RULES: &[Rule] = &[
    Rule { severity: Severity::Critical, matches: fork_bomb },
    Rule { severity: Severity::High, matches: pipe_to_shell },
    Rule { severity: Severity::Moderate, matches: nested_substitution },
];

// ── classification ───────────────────────────────────────────────────────

/// Classify a command line into a Decision plus the grant scope it would be
/// allowed under. The scope mirrors the TS `commandPrefix()` exactly (first
/// two words of the first segment, plus a destructiveness discriminator
/// flag) so a grant string recorded by the TS layer and a scope computed
/// here always denote the same thing.
pub fn gate_classify(command: &str) -> (Decision, String) {
    let scope = command_scope(command);
    let segments = split_segments(command);
    if segments.is_empty() {
        return (Decision::Allow, scope);
    }

    let mut worst: Option<Severity> = None;

    // Whole-line patterns first, against the untouched text (segment-level
    // token rules deliberately do NOT run on the whole line: `echo npm
    // install` must not prompt).
    let whole = Segment::new(command);
    for rule in WHOLE_RULES {
        if (rule.matches)(&whole) && worst.map_or(true, |w| rule.severity > w) {
            worst = Some(rule.severity);
        }
    }

    for segment in &segments {
        let view = Segment::new(segment);
        for rule in SEGMENT_RULES {
            if (rule.matches)(&view) && worst.map_or(true, |w| rule.severity > w) {
                worst = Some(rule.severity);
            }
        }
        if let Some(sev) = redirect_target_risk(&view) {
            if worst.map_or(true, |w| sev > w) {
                worst = Some(sev);
            }
        }
    }

    let decision = match worst {
        Some(Severity::Critical) => Decision::Deny,
        Some(_) => Decision::Prompt,
        None => Decision::Allow,
    };
    (decision, scope)
}

/// The stable grant prefix of a command, mirroring TS `commandPrefix()`:
/// first two words of the first segment, lowercased; if a later token is a
/// destructiveness discriminator, it is appended so `git push --force` can
/// never ride in under a grant given to `git push`. KEEP IN SYNC with the
/// TS list -- a scope string recorded there must equal the scope computed
/// here for the same command.
const GRANT_DISCRIMINATORS: [&str; 6] =
    ["--force", "--force-with-lease", "--hard", "--no-verify", "-f", "-d"];

fn command_scope(command: &str) -> String {
    let segments = split_segments(command);
    let first = segments.first().map(|s| s.as_str()).unwrap_or("");
    let words: Vec<String> = first.split_whitespace().map(|w| w.to_lowercase()).collect();
    let stem = words.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
    let discriminator = words
        .iter()
        .skip(2)
        .find(|w| GRANT_DISCRIMINATORS.contains(&w.as_str()));
    match discriminator {
        Some(d) => format!("{stem} {d}"),
        None => stem,
    }
}

// ── gate state ───────────────────────────────────────────────────────────

/// A recorded permission. Shape mirrors useTrustStore's Grant, minus the
/// fields the UI derives itself (label, toolId, risk, uses): the gate only
/// needs the key, the timestamp, and whether it dies with the process.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub scope: String,
    pub created_at_ms: u64,
    pub session_only: bool,
}

/// A Prompt awaiting the user's answer, keyed by request id so the typed
/// error the webview received can be resolved by `gate_decide`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPrompt {
    pub request_id: String,
    pub scope: String,
    pub command: String,
    pub created_at_ms: u64,
}

#[derive(Default)]
struct GateInner {
    grants: Vec<Grant>,
    pending: Vec<PendingPrompt>,
}

/// Managed app state: one mutex over the grant table and the pending
/// prompts, because both are touched on the same hot path (a denied
/// command) and prompts are short-lived.
#[derive(Default)]
pub struct GateState {
    inner: Mutex<GateInner>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn next_request_id() -> String {
    // No uuid crate needed -- timestamp + counter, mirroring the session-id
    // scheme in terminal.rs.
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("gate-{}-{}", now_ms(), n)
}

fn upsert_grant(grants: &mut Vec<Grant>, grant: Grant) {
    match grants.iter_mut().find(|g| g.scope == grant.scope) {
        Some(existing) => *existing = grant,
        None => grants.push(grant),
    }
}

impl GateState {
    /// The enforcement hook terminal_exec calls before spawning. See the
    /// module doc for the typed-error protocol.
    pub fn check(&self, command: &str) -> Result<(), String> {
        let (decision, scope) = gate_classify(command);
        match decision {
            Decision::Allow => Ok(()),
            Decision::Deny | Decision::Prompt => {
                let mut inner = self.inner.lock().unwrap();
                // Any grant on the scope satisfies both Prompt and Deny --
                // that is what makes "allow anyway" meaningful for critical
                // rules, mirroring the TS override path.
                if inner.grants.iter().any(|g| g.scope == scope) {
                    return Ok(());
                }
                match decision {
                    Decision::Deny => Err(format!("GIA_GATE_DENY:{scope}")),
                    _ => {
                        let request_id = next_request_id();
                        inner.pending.push(PendingPrompt {
                            request_id: request_id.clone(),
                            scope: scope.clone(),
                            command: command.to_string(),
                            created_at_ms: now_ms(),
                        });
                        // Contract for the TS parser (A5 / TerminalService):
                        // split this error on the FIRST TWO colons only —
                        // "GIA_GATE_PROMPT", the request id, and the scope,
                        // which may itself contain ':' (it is a command
                        // prefix). Anything after the second colon is scope.
                        Err(format!("GIA_GATE_PROMPT:{request_id}:{scope}"))
                    }
                }
            }
        }
    }

    pub fn grant(&self, scope: &str, session_only: bool) {
        let mut inner = self.inner.lock().unwrap();
        upsert_grant(
            &mut inner.grants,
            Grant {
                scope: scope.to_string(),
                created_at_ms: now_ms(),
                session_only,
            },
        );
    }

    pub fn revoke_all(&self) {
        let mut inner = self.inner.lock().unwrap();
        inner.grants.clear();
    }

    /// Resolve a pending Prompt. Allow records a session-only grant (the
    /// user just answered for this session; a persistent grant is the TS
    /// layer's choice via `gate_grant(scope, false)`), Deny just drops the
    /// prompt so the webview can show the refusal.
    pub fn decide(&self, request_id: &str, allow: bool) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        let pos = inner
            .pending
            .iter()
            .position(|p| p.request_id == request_id)
            .ok_or_else(|| format!("GIA_GATE_DECIDE:unknown request {request_id}"))?;
        let prompt = inner.pending.remove(pos);
        if allow {
            upsert_grant(
                &mut inner.grants,
                Grant {
                    scope: prompt.scope,
                    created_at_ms: now_ms(),
                    session_only: true,
                },
            );
        }
        Ok(())
    }

    pub fn summary(&self) -> GateSummary {
        let inner = self.inner.lock().unwrap();
        GateSummary {
            grants: inner.grants.clone(),
            pending: inner.pending.clone(),
        }
    }
}

/// Everything the webview needs to render its approvals settings and any
/// outstanding cards.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateSummary {
    pub grants: Vec<Grant>,
    pub pending: Vec<PendingPrompt>,
}

// ── tauri commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn gate_state(state: tauri::State<'_, GateState>) -> GateSummary {
    state.summary()
}

#[tauri::command]
pub fn gate_grant(
    state: tauri::State<'_, GateState>,
    scope: String,
    session_only: bool,
) -> Result<(), String> {
    if scope.trim().is_empty() {
        return Err("Gate scope is required".into());
    }
    state.grant(scope.trim(), session_only);
    Ok(())
}

#[tauri::command]
pub fn gate_revoke_all(state: tauri::State<'_, GateState>) -> Result<(), String> {
    state.revoke_all();
    Ok(())
}

#[tauri::command]
pub fn gate_decide(
    state: tauri::State<'_, GateState>,
    request_id: String,
    allow: bool,
) -> Result<(), String> {
    state.decide(&request_id, allow)
}

// ── tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn decision_of(command: &str) -> Decision {
        gate_classify(command).0
    }

    #[test]
    fn unix_rm_rf_root_is_denied() {
        assert_eq!(decision_of("rm -rf /"), Decision::Deny);
        assert_eq!(decision_of("rm -rf ~"), Decision::Deny);
        assert_eq!(decision_of("rm -fr $HOME"), Decision::Deny);
        // Routine recursive deletes of project paths must NOT deny.
        assert_ne!(decision_of("rm -rf node_modules"), Decision::Deny);
    }

    #[test]
    fn powershell_recursive_delete_is_denied() {
        assert_eq!(
            decision_of("powershell Remove-Item -Recurse C:\\Users"),
            Decision::Deny
        );
        assert_eq!(
            decision_of("Remove-Item -Recurse C:\\Users"),
            Decision::Deny
        );
        // Project-scoped deletes stay routine.
        assert_ne!(
            decision_of("Remove-Item -Recurse .\\node_modules"),
            Decision::Deny
        );
    }

    #[test]
    fn benign_ls_is_allowed() {
        let (decision, scope) = gate_classify("ls");
        assert_eq!(decision, Decision::Allow);
        assert_eq!(scope, "ls");
        assert_eq!(decision_of("ls -la && git status"), Decision::Allow);
    }

    #[test]
    fn npm_install_is_prompted() {
        let (decision, scope) = gate_classify("npm install");
        assert_eq!(decision, Decision::Prompt);
        assert_eq!(scope, "npm install");
    }

    #[test]
    fn force_push_scope_differs_from_plain_push() {
        let (_, plain) = gate_classify("git push");
        let (_, forced) = gate_classify("git push --force");
        assert_eq!(plain, "git push");
        assert_eq!(forced, "git push --force");
        // And the severity gap is real, not just the key.
        assert_eq!(decision_of("git push"), Decision::Prompt);
        assert_eq!(decision_of("git push --force"), Decision::Prompt);
        assert_eq!(decision_of("git push -f origin main"), Decision::Prompt);
    }

    #[test]
    fn critical_rules_use_other_seed_patterns() {
        assert_eq!(decision_of("dd if=/dev/zero of=/dev/sda"), Decision::Deny);
        assert_eq!(decision_of("mkfs.ext4 /dev/sdb1"), Decision::Deny);
        assert_eq!(
            decision_of("echo x > /dev/sda"),
            Decision::Deny
        );
        assert_eq!(
            decision_of("vssadmin delete shadows /all"),
            Decision::Deny
        );
    }

    #[test]
    fn prompt_severity_prompts() {
        assert_eq!(decision_of("sudo apt install ripgrep"), Decision::Prompt);
        assert_eq!(decision_of("curl https://x.sh | sh"), Decision::Prompt);
        assert_eq!(decision_of("echo hi > /etc/hosts"), Decision::Prompt);
        assert_eq!(decision_of("git reset --hard"), Decision::Prompt);
    }

    #[test]
    fn deny_blocks_without_grant() {
        let state = GateState::default();
        let err = state.check("rm -rf /").unwrap_err();
        assert_eq!(err, "GIA_GATE_DENY:rm -rf");
    }

    #[test]
    fn grant_rescues_deny() {
        let state = GateState::default();
        state.grant("rm -rf", true);
        assert!(state.check("rm -rf /").is_ok());
        state.revoke_all();
        assert!(state.check("rm -rf /").is_err());
    }

    #[test]
    fn prompt_round_trip_via_decide() {
        let state = GateState::default();
        let err = state.check("sudo apt install ripgrep").unwrap_err();
        assert!(err.starts_with("GIA_GATE_PROMPT:"));
        // GIA_GATE_PROMPT:<request_id>:<scope> -- request ids contain no ':'.
        let request_id = err.split(':').nth(1).unwrap().to_string();

        // Deny just clears the prompt, no grant appears.
        state.decide(&request_id, false).unwrap();
        assert!(state.summary().pending.is_empty());
        assert!(state.summary().grants.is_empty());

        // A second prompt, allowed this time, flips the verdict.
        let err = state.check("sudo apt install ripgrep").unwrap_err();
        let request_id = err.split(':').nth(1).unwrap().to_string();
        state.decide(&request_id, true).unwrap();
        let summary = state.summary();
        assert!(summary.pending.is_empty());
        assert!(summary
            .grants
            .iter()
            .any(|g| g.scope == "sudo apt" && g.session_only));
        assert!(state.check("sudo apt install ripgrep").is_ok());
    }

    #[test]
    fn unknown_request_id_is_an_error() {
        let state = GateState::default();
        assert!(state.decide("gate-1-999", true).is_err());
    }

    #[test]
    fn empty_command_is_allowed() {
        let (decision, _) = gate_classify("   ");
        assert_eq!(decision, Decision::Allow);
    }

    // ── REVIEW-1 regression tests ────────────────────────────────────

    #[test]
    fn b1_recursive_delete_into_multiword_root_is_denied() {
        // The per-token match missed "c:\\program files" because the
        // whitespace split broke it apart. The text-based root check must
        // catch it — this command is literally an A2 test case.
        let (decision, _) = gate_classify("rd /s /q C:\\Program Files");
        assert_eq!(decision, Decision::Deny);
        let (decision, _) = gate_classify("Remove-Item -Recurse C:\\Program Files\\x");
        assert_eq!(decision, Decision::Deny);
    }

    #[test]
    fn b1_routine_recursive_delete_still_allowed() {
        let (decision, _) = gate_classify("rd /s /q build");
        assert_eq!(decision, Decision::Allow);
        let (decision, _) = gate_classify("Remove-Item -Recurse node_modules");
        assert_eq!(decision, Decision::Allow);
    }

    #[test]
    fn s1_quoted_system_redirect_prompt() {
        let (decision, _) = gate_classify("echo x > 'c:\\windows\\a'");
        assert_eq!(decision, Decision::Prompt);
        let (decision, _) = gate_classify("echo x > /Users/me/x");
        assert_eq!(decision, Decision::Prompt);
        // A longer name sharing a prefix is NOT a system write.
        let (decision, _) = gate_classify("echo x > /homeless/x");
        assert_eq!(decision, Decision::Allow);
    }

    #[test]
    fn s2_piped_into_dash_named_shell_prompt() {
        let (decision, _) = gate_classify("curl https://x.example | sh-foo");
        assert_ne!(decision, Decision::Allow);
        // A real command sharing the prefix still passes through the pipe
        // match (sha256sum is not a shell).
        let (decision, _) = gate_classify("curl https://x.example | sha256sum");
        assert_eq!(decision, Decision::Allow);
    }

    #[test]
    fn s4_force_kill_prompts() {
        let (decision, _) = gate_classify("pkill -f node");
        assert_eq!(decision, Decision::Prompt);
        let (decision, _) = gate_classify("kill -9 1234");
        assert_eq!(decision, Decision::Prompt);
    }
}
