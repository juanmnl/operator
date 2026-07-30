//! Plan limits — the session/weekly usage percentages, read from the CLI we already depend on.
//!
//! `usage.rs` computes what it can locally, and its own docs record that the % bars "come from
//! Anthropic's servers and aren't reproducible locally". That is still true of any local
//! derivation — but there is a supported way to ASK: `claude -p "/usage"` prints them, and the
//! three numbers match the Settings → Usage pane exactly.
//!
//! So this module shells out and parses plain text. Explicitly NOT: any undocumented HTTP
//! endpoint, any credential file, any keychain read, any TUI scraping. The subprocess owns auth
//! and Operator never touches it.
//!
//! The parsing is deliberately loose. This is another program's HUMAN-READABLE output and the
//! wording WILL change. Every field is optional; an unrecognised line yields `None` plus a `note`
//! that reaches the UI. A wrong number here is worse than no number, because the whole point is
//! to stop the user checking another app.

use serde::Serialize;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a cached read stays fresh. Session limits move on the order of minutes, and each read
/// costs a process spawn plus a network round-trip.
const TTL: Duration = Duration::from_secs(5 * 60);
/// The subprocess is a network call behind a spawn. The UI must never be able to wedge on it.
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimits {
    pub session_pct: Option<u8>,
    pub session_resets: Option<String>,
    pub week_pct: Option<u8>,
    pub week_resets: Option<String>,
    /// The per-model weekly line. Its LABEL names whichever model the plan meters separately, so
    /// it is carried rather than hardcoded — "Fable" today is not a promise about tomorrow.
    pub model_label: Option<String>,
    pub model_pct: Option<u8>,
    pub model_resets: Option<String>,
    /// The plan sentence, when the CLI offers one ("You are currently using your subscription…").
    pub plan: Option<String>,
    pub fetched_at: String,
    /// The CLI ran but said something unexpected. SURFACED, never swallowed — an empty meter with
    /// no explanation is indistinguishable from a broken one.
    pub note: Option<String>,
}

/// Pull the first `NN%` out of a line, clamped to 0–100.
///
/// Clamped rather than rejected: a plan that reports 120% has genuinely exceeded its limit, and
/// showing a full bar is the honest rendering. Only a non-number is a parse failure.
fn percent_in(line: &str) -> Option<u8> {
    let idx = line.find('%')?;
    let digits: String = line[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u32>().ok().map(|n| n.min(100) as u8)
}

/// The reset clause, verbatim after "resets". Never re-formatted: the string already carries a
/// localised time AND its timezone, and re-deriving a local time from an already-localised one is
/// how you print the wrong hour.
fn resets_in(line: &str) -> Option<String> {
    let at = line.find("resets")?;
    let rest = line[at + "resets".len()..].trim();
    if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    }
}

/// The label inside the parentheses of "Current week (all models)".
fn paren_label(line: &str) -> Option<String> {
    let open = line.find('(')?;
    let close = line[open..].find(')')? + open;
    let inner = line[open + 1..close].trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

/// Parse `claude -p "/usage"` stdout.
///
/// Matches on SHAPE, not on exact strings: a line mentioning "current session" with a percentage
/// is the session line, whatever else it says. A "current week" line whose parenthesised label is
/// some form of "all models" is the overall weekly one; any other parenthesised week line is the
/// per-model one.
pub fn parse_usage(stdout: &str) -> PlanLimits {
    let mut out = PlanLimits {
        fetched_at: now_iso(),
        ..Default::default()
    };
    let mut saw_any = false;

    for raw in stdout.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_lowercase();

        if out.plan.is_none() && lower.contains("subscription") && !lower.contains('%') {
            out.plan = Some(line.to_string());
            continue;
        }
        // Stop at the "what's contributing" section: usage.rs already computes that locally, and
        // its lines carry percentages that would otherwise be mistaken for limits.
        if lower.starts_with("what's contributing") || lower.starts_with("whats contributing") {
            break;
        }
        if lower.contains("current session") {
            saw_any = true;
            out.session_pct = percent_in(line);
            out.session_resets = resets_in(line);
        } else if lower.contains("current week") {
            saw_any = true;
            let label = paren_label(line);
            let is_all = label
                .as_deref()
                .map(|l| l.to_lowercase().contains("all model"))
                .unwrap_or(true); // an unlabelled weekly line is the overall one
            if is_all {
                out.week_pct = percent_in(line);
                out.week_resets = resets_in(line);
            } else {
                out.model_label = label;
                out.model_pct = percent_in(line);
                out.model_resets = resets_in(line);
            }
        }
    }

    // Say what happened whenever the numbers aren't there. "Absent" must be explicable — a blank
    // meter with no reason reads as a bug in Operator rather than as a different kind of account.
    if !saw_any {
        let head: String = stdout.trim().lines().take(2).collect::<Vec<_>>().join(" ");
        out.note = Some(if head.is_empty() {
            "`claude -p \"/usage\"` returned nothing.".to_string()
        } else {
            format!("Couldn't find usage lines in the CLI's reply: {}", truncate(&head, 160))
        });
    } else if out.session_pct.is_none() && out.week_pct.is_none() {
        out.note = Some("Found the usage lines but no percentages in them — the CLI's wording may have changed.".to_string());
    }
    out
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

fn now_iso() -> String {
    // Same shape the frontend gets everywhere else. std-only: no chrono in this crate.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm), so the date is right without a date crate.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.000Z")
}

/// Milliseconds since the epoch. `now_iso` formats the same clock for the wire; this is the same
/// reading in the form arithmetic can use.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// When the window a reset clause names ends, in epoch ms — **relative phrasings only**.
///
/// The split is deliberate, and it is a capability boundary rather than a preference. The clause
/// the CLI actually emits today is `Jul 30 at 8:30pm (America/Guayaquil)`: a wall-clock time in a
/// named IANA zone. Converting that needs a timezone database, and this crate is std-only on
/// purpose — `now_iso` hand-rolls civil-from-days precisely because there is no date crate — so
/// doing it here would mean guessing an offset, which is the "print the wrong hour" mistake
/// `resets_in` above exists to avoid, moved one layer down where nobody would see it.
///
/// The renderer has `Intl`, which has the whole database, and it is the only place the number is
/// ever DISPLAYED; it does the zoned check and forces a refresh (see lib/plan-limits `windowEnded`).
/// What this covers is the relative form — exact with no zone knowledge at all — so the cache
/// cannot serve a provably-closed window for those phrasings either.
fn resets_at_ms(clause: &str, fetched_ms: u64) -> Option<u64> {
    let t = clause.trim().to_lowercase();
    let rest = t.strip_prefix("in ")?;
    let mut total_ms: u64 = 0;
    let mut saw = false;
    let mut num: Option<u64> = None;
    for tok in rest.split(|c: char| c.is_whitespace() || c == ',') {
        let tok = tok.trim();
        if tok.is_empty() {
            continue;
        }
        if let Ok(n) = tok.parse::<u64>() {
            num = Some(n);
            continue;
        }
        // A unit only counts when a number is waiting for it; anything else means a phrasing we
        // do not understand, and half-understanding one is worse than declining it.
        let n = match num.take() {
            Some(n) => n,
            None => return None,
        };
        if tok.starts_with("hour") || tok == "h" || tok.starts_with("hr") {
            total_ms += n * 3_600_000;
            saw = true;
        } else if tok.starts_with("min") || tok == "m" {
            total_ms += n * 60_000;
            saw = true;
        } else {
            return None;
        }
    }
    // A trailing bare number ("in 3") names no unit; decline it.
    if !saw || num.is_some() {
        return None;
    }
    Some(fetched_ms + total_ms)
}

/// Has the session window this reading describes already ended? `false` whenever we cannot tell —
/// never assume closed, since that would throw away a perfectly good reading.
fn window_ended(value: &PlanLimits, fetched_ms: u64, now: u64) -> bool {
    value
        .session_resets
        .as_deref()
        .and_then(|c| resets_at_ms(c, fetched_ms))
        .map(|at| now >= at)
        .unwrap_or(false)
}

struct Cache {
    value: PlanLimits,
    at: Instant,
    /// When the cached value was read, as epoch ms — `at` is an `Instant`, which cannot be
    /// compared against a wall-clock reset time.
    fetched_ms: u64,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);
/// The in-flight guard. Five refresh clicks must not spawn five processes — a separate lock from
/// the cache so a running fetch doesn't block a cache read.
static FETCHING: Mutex<()> = Mutex::new(());

/// Run the CLI through a LOGIN SHELL, the same way `terminal_spawn` does.
///
/// A bare `Command::new("claude")` from a GUI app doesn't see the user's PATH — the app is not
/// launched from a shell, so `~/.local/bin` and friends aren't on it. `$SHELL -ilc` is how the rest
/// of this crate finds the binary, and this must not be the one place that guesses differently.
fn run_usage() -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(&shell)
        .args(["-ilc", "claude -p '/usage'"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start {shell}: {e}"))?;

    // Poll for the timeout rather than blocking on wait(): a hung network call must not hold the
    // command handler forever, and the child is KILLED rather than left behind.
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "`claude -p \"/usage\"` didn't answer within {}s.",
                        TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            Err(e) => return Err(format!("waiting on the CLI failed: {e}")),
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("reading the CLI's reply failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if stdout.trim().is_empty() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        let err = err.trim();
        return Err(if err.is_empty() {
            "`claude -p \"/usage\"` returned nothing.".to_string()
        } else {
            truncate(err, 200)
        });
    }
    Ok(stdout)
}

/// Cached plan limits. `force` skips the TTL for an explicit refresh.
///
/// Never returns an error to the UI: a failed read is a `PlanLimits` with no numbers and a `note`,
/// because the meter has to render *something* honest either way.
pub fn fetch(force: Option<bool>) -> PlanLimits {
    let force = force.unwrap_or(false);
    if !force {
        if let Ok(guard) = CACHE.lock() {
            if let Some(c) = guard.as_ref() {
                // Fresh by the clock AND still describing a window that exists. A cache entry past
                // its own reset boundary is not stale, it is false, and serving it for the rest of
                // the TTL is how a percentage from a closed window stays on screen.
                if c.at.elapsed() < TTL && !window_ended(&c.value, c.fetched_ms, now_ms()) {
                    return c.value.clone();
                }
            }
        }
    }
    // One process at a time. A caller that arrives mid-fetch waits, then finds the fresh value in
    // the cache below rather than spawning a second one.
    let _fetching = FETCHING.lock();
    if !force {
        if let Ok(guard) = CACHE.lock() {
            if let Some(c) = guard.as_ref() {
                if c.at.elapsed() < TTL && !window_ended(&c.value, c.fetched_ms, now_ms()) {
                    return c.value.clone();
                }
            }
        }
    }

    let value = match run_usage() {
        Ok(stdout) => parse_usage(&stdout),
        Err(note) => PlanLimits {
            fetched_at: now_iso(),
            note: Some(note),
            ..Default::default()
        },
    };
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(Cache {
            value: value.clone(),
            at: Instant::now(),
            fetched_ms: now_ms(),
        });
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from this machine, 2026-07-30.
    const REAL: &str = "You are currently using your subscription to power your Claude Code usage

Current session: 66% used · resets Jul 30 at 2am (America/Guayaquil)
Current week (all models): 39% used · resets Aug 4 at 1am (America/Guayaquil)
Current week (Fable): 0% used · resets Aug 4 at 1am (America/Guayaquil)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine.

Last 24h · 2719 requests · 14 sessions
  92% of your usage was at >150k context
  87% of your usage came from sessions active for 8+ hours";

    #[test]
    fn parses_the_real_output() {
        let p = parse_usage(REAL);
        assert_eq!(p.session_pct, Some(66));
        assert_eq!(p.session_resets.as_deref(), Some("Jul 30 at 2am (America/Guayaquil)"));
        assert_eq!(p.week_pct, Some(39));
        assert_eq!(p.model_label.as_deref(), Some("Fable"));
        assert_eq!(p.model_pct, Some(0));
        assert!(p.plan.as_deref().unwrap().contains("subscription"));
        assert!(p.note.is_none(), "a clean parse must not carry a note");
    }

    #[test]
    fn ignores_the_contributing_section() {
        // Those lines carry percentages too — 92% and 87% must never be mistaken for limits.
        let p = parse_usage(REAL);
        assert_eq!(p.session_pct, Some(66));
        assert_eq!(p.week_pct, Some(39));
        assert_eq!(p.model_pct, Some(0), "0% is DATA, not absence");
    }

    #[test]
    fn zero_percent_is_a_value_not_an_absence() {
        let p = parse_usage("Current session: 0% used · resets tomorrow");
        assert_eq!(p.session_pct, Some(0));
    }

    #[test]
    fn a_missing_model_line_is_simply_absent() {
        let p = parse_usage(
            "Current session: 12% used · resets Jul 30 at 2am
Current week (all models): 5% used · resets Aug 4 at 1am",
        );
        assert_eq!(p.session_pct, Some(12));
        assert_eq!(p.week_pct, Some(5));
        assert_eq!(p.model_pct, None);
        assert_eq!(p.model_label, None);
        assert!(p.note.is_none(), "an absent optional line is not an anomaly");
    }

    #[test]
    fn survives_rewording() {
        // Shape, not exact strings: different punctuation, casing and reset phrasing.
        let p = parse_usage(
            "Current Session usage - 44% used, resets in 3 hours
Current Week (All Models) — 71% used, resets Sunday",
        );
        assert_eq!(p.session_pct, Some(44));
        assert_eq!(p.week_pct, Some(71));
        assert_eq!(p.session_resets.as_deref(), Some("in 3 hours"));
    }

    #[test]
    fn an_unlabelled_weekly_line_is_the_overall_one() {
        let p = parse_usage("Current week: 22% used · resets Aug 4");
        assert_eq!(p.week_pct, Some(22));
        assert_eq!(p.model_pct, None);
    }

    #[test]
    fn a_percentage_over_100_clamps_rather_than_lying() {
        let p = parse_usage("Current session: 120% used · resets later");
        assert_eq!(p.session_pct, Some(100));
    }

    #[test]
    fn empty_stdout_yields_no_numbers_and_a_note() {
        let p = parse_usage("");
        assert_eq!(p.session_pct, None);
        assert!(p.note.is_some(), "absent must be explicable");
    }

    #[test]
    fn a_non_subscription_account_is_absent_not_zero() {
        // API billing prints something else entirely. It must NOT render as 0%.
        let p = parse_usage("You are using the Anthropic API with pay-as-you-go billing.");
        assert_eq!(p.session_pct, None);
        assert_eq!(p.week_pct, None);
        assert!(p.note.is_some());
    }

    #[test]
    fn garbage_parses_without_panicking() {
        for junk in [
            "%%%%",
            "Current session: % used",
            "Current week ( : 5% used",
            "\u{0}\u{1}\u{2}",
            "Current session: 999999999999999999999% used",
            "resets",
        ] {
            let p = parse_usage(junk);
            assert!(p.session_pct.is_none() || p.session_pct.unwrap() <= 100);
        }
    }

    #[test]
    fn a_line_with_no_percentage_reports_a_note_rather_than_a_number() {
        let p = parse_usage("Current session: unavailable right now");
        assert_eq!(p.session_pct, None);
        assert!(p.note.as_deref().unwrap().contains("wording"));
    }

    #[test]
    fn reset_text_is_carried_verbatim_including_its_timezone() {
        // Re-deriving a local time from an already-localised string prints the wrong hour.
        let p = parse_usage("Current session: 3% used · resets Jul 30 at 2am (America/Guayaquil)");
        assert_eq!(p.session_resets.as_deref(), Some("Jul 30 at 2am (America/Guayaquil)"));
    }

    #[test]
    fn the_cache_serves_a_fresh_value_without_respawning() {
        // The guard that matters isn't the lock, it's this: five refresh clicks inside the TTL
        // must do ONE spawn. Seed the cache and assert `fetch` never reaches the subprocess —
        // `run_usage` would take ~1.5s and return a different `fetched_at` if it did.
        let seeded = PlanLimits { session_pct: Some(42), fetched_at: "seeded".into(), ..Default::default() };
        *CACHE.lock().unwrap() = Some(Cache { value: seeded.clone(), at: Instant::now(), fetched_ms: now_ms() });
        for _ in 0..5 {
            let got = fetch(Some(false));
            assert_eq!(got, seeded, "a cache hit must not spawn anything");
        }
        *CACHE.lock().unwrap() = None; // leave no state for the other tests
    }

    #[test]
    fn an_expired_cache_is_not_served() {
        let stale = PlanLimits { session_pct: Some(1), fetched_at: "stale".into(), ..Default::default() };
        *CACHE.lock().unwrap() = Some(Cache {
            value: stale.clone(),
            at: Instant::now().checked_sub(TTL + Duration::from_secs(1)).unwrap(),
            fetched_ms: now_ms(),
        });
        // Not asserting on the fetched value (it would really spawn `claude`); only that the
        // staleness check itself says no.
        let expired = CACHE.lock().unwrap().as_ref().map(|c| c.at.elapsed() >= TTL);
        assert_eq!(expired, Some(true));
        *CACHE.lock().unwrap() = None;
    }

    #[test]
    fn fetched_at_is_a_plausible_iso_timestamp() {
        let s = parse_usage(REAL).fetched_at;
        assert_eq!(s.len(), 24, "{s}");
        assert!(s.starts_with("20"), "{s}");
        assert!(s.ends_with('Z'), "{s}");
        assert_eq!(&s[4..5], "-");
        assert_eq!(&s[10..11], "T");
    }
}

#[cfg(test)]
mod reset_window_tests {
    use super::*;

    const HOUR: u64 = 3_600_000;

    #[test]
    fn parses_the_relative_phrasings() {
        let t0 = 1_000_000_000_000;
        assert_eq!(resets_at_ms("in 3 hours", t0), Some(t0 + 3 * HOUR));
        assert_eq!(resets_at_ms("in 1 hour", t0), Some(t0 + HOUR));
        assert_eq!(resets_at_ms("in 45 minutes", t0), Some(t0 + 45 * 60_000));
        assert_eq!(resets_at_ms("in 45 min", t0), Some(t0 + 45 * 60_000));
        // The shape Claude's own UI uses: "Resets in 4 hr 55 min".
        assert_eq!(resets_at_ms("in 4 hr 55 min", t0), Some(t0 + 4 * HOUR + 55 * 60_000));
        assert_eq!(resets_at_ms("  IN 2 HOURS  ", t0), Some(t0 + 2 * HOUR));
    }

    #[test]
    fn declines_every_phrasing_it_cannot_pin_exactly() {
        // All of these are real fixtures from the parser tests above. Declining is the whole
        // point: an unparseable clause falls back to the plain TTL rather than guessing, and a
        // guess here would blank a number the user can see is fine.
        let t0 = 1_000_000_000_000;
        for clause in [
            "Jul 30 at 2am (America/Guayaquil)", // zoned wall clock — the renderer's job
            "Jul 30 at 8:30pm (America/Guayaquil)",
            "Jul 30 at 2am",
            "tomorrow",
            "Sunday",
            "Aug 4",
            "later",
            "in 3",        // a number with no unit
            "in a while",  // a unit with no number
            "",
        ] {
            assert_eq!(resets_at_ms(clause, t0), None, "should decline {clause:?}");
        }
    }

    #[test]
    fn a_window_is_ended_only_once_its_reset_has_passed() {
        let t0 = 1_000_000_000_000;
        let v = PlanLimits {
            session_pct: Some(12),
            session_resets: Some("in 2 hours".into()),
            ..Default::default()
        };
        assert!(!window_ended(&v, t0, t0));                    // just read
        assert!(!window_ended(&v, t0, t0 + HOUR));             // mid-window
        assert!(window_ended(&v, t0, t0 + 2 * HOUR));          // exactly at the boundary
        assert!(window_ended(&v, t0, t0 + 3 * HOUR));          // past it
    }

    #[test]
    fn an_unreadable_clause_never_reads_as_ended() {
        // Never assume closed: that would throw away a perfectly good reading on every account
        // whose phrasing we don't parse — which today is the common one.
        let t0 = 1_000_000_000_000;
        for clause in [Some("Jul 30 at 2am (America/Guayaquil)".to_string()), Some("later".into()), None] {
            let v = PlanLimits { session_resets: clause.clone(), ..Default::default() };
            assert!(!window_ended(&v, t0, t0 + 999 * HOUR), "clause {clause:?}");
        }
    }

    #[test]
    fn the_cache_refuses_a_value_whose_window_has_closed() {
        // The brief's requirement: past its own reset boundary is a MISS, independently of the
        // 5-minute TTL. Asserted on the predicate rather than by calling `fetch` — a miss really
        // would spawn `claude -p "/usage"`.
        let fetched = now_ms();
        let closed = PlanLimits {
            session_pct: Some(12),
            session_resets: Some("in 1 min".into()),
            ..Default::default()
        };
        let open = PlanLimits {
            session_resets: Some("in 5 hours".into()),
            ..Default::default()
        };
        let now = fetched + 2 * 60_000; // two minutes later — well inside the TTL
        assert!(window_ended(&closed, fetched, now), "a closed window must not be served");
        assert!(!window_ended(&open, fetched, now), "an open one still is");
    }
}
