// Usage & cost (port of usage.ts). Parses ~/.claude/projects/<slug>/*.jsonl once
// into a cached in-memory record set, then aggregates per requested range from
// the cache — so switching time filters is instant (no re-scan / re-parse).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::backend::{iso_from_ms, now_iso};

// $/1M tokens, (input, output, cache-read). Substring-matched so a dated model id
// (`claude-opus-5-20260101`) resolves without a table entry per release, and so a point release
// inherits its tier — `sonnet-5` is written to catch a future `sonnet-5-1` too.
//
// PESSIMISTIC WHERE THE ID IS AMBIGUOUS. An unknown model bills at the Opus rate rather than at
// zero, because a silent 0 reads as "this cost nothing". The same rule decides the bare aliases:
// a version-less `sonnet` (rare — transcripts carry full ids, but `<synthetic>` rows and
// hand-written fixtures exist) takes the HIGHER 3/15 of Sonnet 4.6, and only a confident
// `sonnet-5` match takes 2/10. Under-reporting is the failure this module refuses.
//
// CACHE-READ IS A RATE, NOT A MULTIPLIER. It is 0.1× input on every model here except Fable 5.1,
// which reads cache at a flat $0.25/Mtok — a quarter of what 0.1 × $10 would say, on the traffic
// an agent session is mostly made of. Scoped to `fable-5-1` deliberately: $0.25 is documented as
// something 5.1 ADDS over Fable 5, and whether Mythos 5.1 shares it is open, so `claude-fable-5`
// and the mythos ids keep the 0.1× default rather than take a discount nobody has confirmed.
//
// `fast` is Opus fast mode (`usage.speed == "fast"`), which bills 10/50 instead of 5/25 — the
// same model, 2.5× the output speed, at a premium. It is a research preview on Opus 5 and 4.8
// only, so no other family consults the flag; 4.8's fast rate is not separately published, and
// pricing it with Opus 5's is the pessimistic reading.
//
// Kept in step with `rates()` in electron/src/main/usage.ts — same table, same order, same rule.
fn rates(model: &str, fast: bool) -> (f64, f64, f64) {
    // Cache-read defaults to a tenth of input — derived, never hand-copied, so the two can't drift.
    let tier = |input: f64, output: f64| (input, output, input * 0.1);
    if model.contains("fable-5-1") { (10.0, 50.0, 0.25) }
    else if model.contains("fable") || model.contains("mythos") { tier(10.0, 50.0) }
    else if model.contains("opus") { if fast { tier(10.0, 50.0) } else { tier(5.0, 25.0) } }
    else if model.contains("sonnet-5") { tier(2.0, 10.0) }
    else if model.contains("sonnet") { tier(3.0, 15.0) }
    else if model.contains("haiku") { tier(1.0, 5.0) }
    else { tier(5.0, 25.0) }
}

// One assistant message's usage, pre-parsed and cached.
struct Record {
    day: String, // YYYY-MM-DD (ISO dates sort lexicographically)
    model: String,
    slug: String,
    session: String,
    ts_ms: i64,
    duration_ms: i64,
    context: u64, // total prompt size = input + cache_read + cache_creation
    sidechain: bool,
    skill: Option<String>,
    /// `usage.speed == "fast"` — Opus fast mode, billed at the premium rate. See `rates`.
    fast: bool,
    input: u64,
    output: u64,
    cache_read: u64,
    cache5m: u64,
    cache1h: u64,
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn parse_iso_ms(s: &str) -> i64 {
    // "YYYY-MM-DDTHH:MM:SS(.mmm)?Z" — best-effort, no external crate.
    let bytes: Vec<&str> = s.splitn(2, 'T').collect();
    let date = bytes.first().copied().unwrap_or("");
    let dp: Vec<i64> = date.split('-').filter_map(|x| x.parse().ok()).collect();
    if dp.len() != 3 {
        return 0;
    }
    let days = days_from_civil(dp[0], dp[1], dp[2]);
    let (mut h, mut mi, mut sec) = (0i64, 0i64, 0i64);
    if let Some(time) = bytes.get(1) {
        let t = time.trim_end_matches('Z');
        let tp: Vec<&str> = t.split(':').collect();
        h = tp.first().and_then(|x| x.parse().ok()).unwrap_or(0);
        mi = tp.get(1).and_then(|x| x.parse().ok()).unwrap_or(0);
        sec = tp.get(2).map(|x| x.split('.').next().unwrap_or("0")).and_then(|x| x.parse().ok()).unwrap_or(0);
    }
    (days * 86400 + h * 3600 + mi * 60 + sec) * 1000
}

impl Record {
    // Cache-write is billed ABOVE the input rate (1.25× for 5-minute, 2× for 1-hour); cache-read
    // is its own rate from the table, not a multiplier applied here.
    fn cost(&self) -> f64 {
        let (ri, ro, rcr) = rates(&self.model, self.fast);
        let per_in = ri / 1e6;
        self.input as f64 * per_in
            + self.output as f64 * (ro / 1e6)
            + self.cache_read as f64 * (rcr / 1e6)
            + self.cache5m as f64 * per_in * 1.25
            + self.cache1h as f64 * per_in * 2.0
    }
    fn tokens(&self) -> u64 {
        self.input + self.output + self.cache_read + self.cache5m + self.cache1h
    }
}

// 30s cache so flipping ranges is instant; new usage still shows up within ~30s.
static CACHE: OnceLock<Mutex<Option<(Instant, Arc<Vec<Record>>)>>> = OnceLock::new();
const CACHE_TTL_SECS: u64 = 30;

fn records() -> Arc<Vec<Record>> {
    let cell = CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if let Some((at, recs)) = guard.as_ref() {
        if at.elapsed().as_secs() < CACHE_TTL_SECS {
            return recs.clone();
        }
    }
    let recs = Arc::new(load_records());
    *guard = Some((Instant::now(), recs.clone()));
    recs
}

fn load_records() -> Vec<Record> {
    let home = std::env::var("HOME").unwrap_or_default();
    let projects_dir = std::path::Path::new(&home).join(".claude").join("projects");
    let mut out = vec![];
    let mut seen: HashSet<String> = HashSet::new();

    let Ok(dirs) = std::fs::read_dir(&projects_dir) else { return out };
    for dir in dirs.flatten() {
        if !dir.path().is_dir() {
            continue;
        }
        let slug = dir.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(dir.path()) else { continue };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().map(|e| e != "jsonl").unwrap_or(true) {
                continue;
            }
            let session = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            for line in raw.lines() {
                if line.is_empty() {
                    continue;
                }
                let Ok(obj) = serde_json::from_str::<Value>(line) else { continue };
                let Some(msg) = obj.get("message") else { continue };
                let Some(usage) = msg.get("usage") else { continue };
                let model = match msg.get("model").and_then(|v| v.as_str()) {
                    Some(m) if m != "<synthetic>" => m.to_string(),
                    _ => continue,
                };
                if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                    let key = format!("{id}:{}", obj.get("requestId").and_then(|v| v.as_str()).unwrap_or(""));
                    if !seen.insert(key) {
                        continue;
                    }
                }
                let g = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let cc_total = g(usage, "cache_creation_input_tokens");
                let (cache5m, cache1h) = match usage.get("cache_creation") {
                    Some(cc) if cc.get("ephemeral_5m_input_tokens").is_some() || cc.get("ephemeral_1h_input_tokens").is_some() => {
                        (g(cc, "ephemeral_5m_input_tokens"), g(cc, "ephemeral_1h_input_tokens"))
                    }
                    _ => (cc_total, 0),
                };
                let ts = obj.get("timestamp").and_then(|v| v.as_str()).unwrap_or("");
                let day = ts.chars().take(10).collect::<String>();
                let input = g(usage, "input_tokens");
                let cache_read = g(usage, "cache_read_input_tokens");
                out.push(Record {
                    day,
                    model,
                    slug: slug.clone(),
                    session: session.clone(),
                    ts_ms: parse_iso_ms(ts),
                    duration_ms: obj.get("durationMs").and_then(|v| v.as_i64()).unwrap_or(0),
                    context: input + cache_read + cache5m + cache1h,
                    sidechain: obj.get("isSidechain").and_then(|v| v.as_bool()).unwrap_or(false),
                    // Claude Code persists the API's own `usage.speed` verbatim; anything but the
                    // literal "fast" (including the null `<synthetic>` rows carry) is standard.
                    fast: usage.get("speed").and_then(|v| v.as_str()) == Some("fast"),
                    skill: obj.get("attributionSkill").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string()),
                    input,
                    output: g(usage, "output_tokens"),
                    cache_read,
                    cache5m,
                    cache1h,
                });
            }
        }
    }
    out
}

#[derive(Default, Clone)]
struct Acc {
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
    cost: f64,
    messages: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage { model: String, input_tokens: u64, output_tokens: u64, cache_write_tokens: u64, cache_read_tokens: u64, cost: f64, messages: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage { slug: String, name: String, cost: f64, tokens: u64, messages: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage { date: String, cost: f64, tokens: u64 }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    total_cost: f64,
    total_tokens: u64,
    api_ms: i64,
    wall_ms: i64,
    by_model: Vec<ModelUsage>,
    by_project: Vec<ProjectUsage>,
    by_day: Vec<DayUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<String>,
    generated_at: String,
}

fn project_name(slug: &str) -> String {
    slug.split('-').filter(|s| !s.is_empty()).next_back().unwrap_or(slug).to_string()
}

pub fn compute_usage(days: i64) -> UsageStats {
    let generated_at = now_iso();
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let (cutoff_day, since) = if days > 0 {
        let cutoff_ms = now_ms.saturating_sub((days as u128) * 86_400_000);
        let iso = iso_from_ms(cutoff_ms);
        (iso.chars().take(10).collect::<String>(), Some(iso))
    } else {
        (String::new(), None)
    };

    let recs = records();
    let mut by_model: HashMap<String, Acc> = HashMap::new();
    let mut by_project: HashMap<String, Acc> = HashMap::new();
    let mut by_day: HashMap<String, (f64, u64)> = HashMap::new();
    let mut total_cost = 0.0;
    let mut total_tokens: u64 = 0;
    let mut api_ms: i64 = 0;
    let (mut min_ts, mut max_ts) = (i64::MAX, i64::MIN);

    for r in recs.iter() {
        if !cutoff_day.is_empty() && !r.day.is_empty() && r.day < cutoff_day {
            continue;
        }
        let cost = r.cost();
        let tokens = r.tokens();
        let cache_write = r.cache5m + r.cache1h;
        total_cost += cost;
        total_tokens += tokens;
        api_ms += r.duration_ms.max(0);
        if r.ts_ms > 0 {
            min_ts = min_ts.min(r.ts_ms);
            max_ts = max_ts.max(r.ts_ms);
        }

        let m = by_model.entry(r.model.clone()).or_default();
        m.input += r.input; m.output += r.output; m.cache_write += cache_write; m.cache_read += r.cache_read; m.cost += cost; m.messages += 1;

        let p = by_project.entry(r.slug.clone()).or_default();
        p.input += r.input; p.output += r.output; p.cache_write += cache_write; p.cache_read += r.cache_read; p.cost += cost; p.messages += 1;

        let d = by_day.entry(if r.day.is_empty() { generated_at.chars().take(10).collect() } else { r.day.clone() }).or_insert((0.0, 0));
        d.0 += cost; d.1 += tokens;
    }

    let mut by_model: Vec<ModelUsage> = by_model.into_iter().map(|(model, a)| ModelUsage { model, input_tokens: a.input, output_tokens: a.output, cache_write_tokens: a.cache_write, cache_read_tokens: a.cache_read, cost: a.cost, messages: a.messages }).collect();
    by_model.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    let mut by_project: Vec<ProjectUsage> = by_project.into_iter().map(|(slug, a)| ProjectUsage { name: project_name(&slug), slug, cost: a.cost, tokens: a.input + a.output + a.cache_read + a.cache_write, messages: a.messages }).collect();
    by_project.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    let mut by_day: Vec<DayUsage> = by_day.into_iter().map(|(date, (cost, tokens))| DayUsage { date, cost, tokens }).collect();
    by_day.sort_by(|a, b| a.date.cmp(&b.date));

    let wall_ms = if max_ts > min_ts { max_ts - min_ts } else { 0 };
    UsageStats { total_cost, total_tokens, api_ms, wall_ms, by_model, by_project, by_day, since, generated_at }
}

// --- "What's contributing to your limits usage?" (local, approximate) -------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUsage {
    name: String,
    pct: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Insights {
    total_tokens: u64,
    high_context_pct: f64,   // share of tokens at >150k context
    subagent_pct: f64,       // share of tokens from sessions that used subagents
    long_session_pct: f64,   // share of tokens from sessions active 8h+
    skills: Vec<SkillUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    since: Option<String>,
    generated_at: String,
}

pub fn compute_insights(days: i64) -> Insights {
    let generated_at = now_iso();
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let (cutoff_day, since) = if days > 0 {
        let cutoff_ms = now_ms.saturating_sub((days as u128) * 86_400_000);
        let iso = iso_from_ms(cutoff_ms);
        (iso.chars().take(10).collect::<String>(), Some(iso))
    } else {
        (String::new(), None)
    };

    let recs = records();
    let mut total: u64 = 0;
    let mut high_context: u64 = 0;
    let mut by_session: HashMap<String, (u64, bool, i64, i64)> = HashMap::new(); // tokens, sidechain, min_ts, max_ts
    let mut by_skill: HashMap<String, u64> = HashMap::new();

    for r in recs.iter() {
        if !cutoff_day.is_empty() && !r.day.is_empty() && r.day < cutoff_day {
            continue;
        }
        let tokens = r.tokens();
        total += tokens;
        if r.context > 150_000 {
            high_context += tokens;
        }
        let e = by_session.entry(r.session.clone()).or_insert((0, false, i64::MAX, i64::MIN));
        e.0 += tokens;
        e.1 = e.1 || r.sidechain;
        if r.ts_ms > 0 {
            e.2 = e.2.min(r.ts_ms);
            e.3 = e.3.max(r.ts_ms);
        }
        if let Some(s) = &r.skill {
            *by_skill.entry(s.clone()).or_insert(0) += tokens;
        }
    }

    let subagent: u64 = by_session.values().filter(|(_, sc, _, _)| *sc).map(|(t, ..)| *t).sum();
    let long: u64 = by_session
        .values()
        .filter(|(_, _, min, max)| *min != i64::MAX && *max - *min >= 8 * 3_600_000)
        .map(|(t, ..)| *t)
        .sum();

    let pct = |x: u64| if total > 0 { x as f64 / total as f64 * 100.0 } else { 0.0 };
    let mut skills: Vec<SkillUsage> = by_skill.into_iter().map(|(name, t)| SkillUsage { name, pct: pct(t) }).collect();
    skills.sort_by(|a, b| b.pct.partial_cmp(&a.pct).unwrap_or(std::cmp::Ordering::Equal));
    skills.truncate(8);

    Insights {
        total_tokens: total,
        high_context_pct: pct(high_context),
        subagent_pct: pct(subagent),
        long_session_pct: pct(long),
        skills,
        since,
        generated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(model: &str, input: u64, output: u64, cache_read: u64, cache5m: u64, cache1h: u64) -> Record {
        Record {
            day: "2024-01-01".into(),
            model: model.into(),
            slug: "s".into(),
            session: "x".into(),
            ts_ms: 0,
            duration_ms: 0,
            context: 0,
            sidechain: false,
            skill: None,
            fast: false,
            input,
            output,
            cache_read,
            cache5m,
            cache1h,
        }
    }

    #[test]
    fn rates_match_model_family() {
        assert_eq!(rates("claude-fable-5-1", false), (10.0, 50.0, 0.25));
        assert_eq!(rates("claude-fable-5", false), (10.0, 50.0, 1.0));
        assert_eq!(rates("mythos-mini", false), (10.0, 50.0, 1.0));
        assert_eq!(rates("claude-opus-5", false), (5.0, 25.0, 0.5));
        assert_eq!(rates("claude-opus-4-8", false), (5.0, 25.0, 0.5));
        assert_eq!(rates("claude-sonnet-5", false), (2.0, 10.0, 0.2));
        assert_eq!(rates("claude-sonnet-4-6", false), (3.0, 15.0, 3.0 * 0.1));
        assert_eq!(rates("claude-haiku-4-5", false), (1.0, 5.0, 0.1));
    }

    // Sonnet stopped being one rate: Sonnet 5 bills 2/10, Sonnet 4.6 still bills 3/15, and a
    // substring match on `sonnet` alone cannot tell them apart.
    #[test]
    fn rates_split_sonnet_by_version_and_carry_point_releases() {
        assert_eq!(rates("claude-sonnet-5", false).0, 2.0);
        assert_eq!(rates("claude-sonnet-4-6", false).0, 3.0);
        // A dated id and a future point release both inherit the Sonnet 5 tier without a new row.
        assert_eq!(rates("claude-sonnet-5-20260101", false).0, 2.0);
        assert_eq!(rates("claude-sonnet-5-1", false).0, 2.0);
    }

    // The ambiguous case, answered deliberately: an unversioned alias takes the HIGHER rate.
    // Over-reporting is recoverable; a cost view that quietly under-reports is not.
    #[test]
    fn rates_bare_sonnet_alias_takes_the_higher_rate() {
        assert_eq!(rates("sonnet", false), (3.0, 15.0, 3.0 * 0.1));
    }

    // $0.25/Mtok is documented for Fable 5.1 specifically — as something it ADDS over Fable 5 —
    // so the older id and the mythos ids keep the 0.1x default rather than take it on assumption.
    #[test]
    fn rates_cache_read_is_flat_only_for_fable_5_1() {
        assert_eq!(rates("claude-fable-5-1", false).2, 0.25);
        assert_eq!(rates("claude-fable-5", false).2, 1.0);
        assert_eq!(rates("claude-mythos-5-1", false).2, 1.0);
        // Everything else is exactly a tenth of its own input rate, never a hand-copied constant.
        for m in ["claude-opus-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-4-5", "gpt-4o"] {
            let (input, _, cache_read) = rates(m, false);
            assert!((cache_read - input * 0.1).abs() < 1e-12, "{m}: {cache_read} != {input} * 0.1");
        }
    }

    // Fast mode is the same model at up to 2.5x output speed, billed at a premium. Only Opus has
    // it, so no other family consults the flag.
    #[test]
    fn rates_opus_fast_mode_bills_at_the_premium() {
        assert_eq!(rates("claude-opus-5", true), (10.0, 50.0, 1.0));
        assert_eq!(rates("claude-opus-4-8", true), (10.0, 50.0, 1.0));
        assert_eq!(rates("claude-sonnet-5", true), rates("claude-sonnet-5", false));
        assert_eq!(rates("claude-haiku-4-5", true), rates("claude-haiku-4-5", false));
    }

    #[test]
    fn rates_unknown_model_falls_back_to_opus_pricing() {
        assert_eq!(rates("gpt-4o", false), (5.0, 25.0, 0.5));
        assert_eq!(rates("", false), (5.0, 25.0, 0.5));
    }

    #[test]
    fn cost_sums_every_token_tier_with_correct_multipliers() {
        // opus rates (5/25 per Mtok); one million of every tier.
        let r = rec("claude-opus-4", 1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000);
        // 5 + 25 + 0.5(cache_read .1x) + 6.25(cache5m 1.25x) + 10(cache1h 2x)
        assert!((r.cost() - 46.75).abs() < 1e-9, "got {}", r.cost());
    }

    // The largest distortion the old flat 0.1x produced: 1M cache-read tokens on Fable 5.1 cost
    // $0.25, not the $1.00 that 0.1 x $10 claimed. A 4x over-report on an agent session's bulk.
    #[test]
    fn cost_uses_the_per_model_cache_read_rate() {
        assert!((rec("claude-fable-5-1", 0, 0, 1_000_000, 0, 0).cost() - 0.25).abs() < 1e-9);
        assert!((rec("claude-fable-5", 0, 0, 1_000_000, 0, 0).cost() - 1.0).abs() < 1e-9);
        assert!((rec("claude-opus-5", 0, 0, 1_000_000, 0, 0).cost() - 0.5).abs() < 1e-9);
        assert!((rec("claude-sonnet-5", 0, 0, 1_000_000, 0, 0).cost() - 0.2).abs() < 1e-9);
    }

    #[test]
    fn cost_bills_a_fast_opus_turn_at_double() {
        let mut r = rec("claude-opus-5", 1_000_000, 1_000_000, 0, 0, 0);
        assert!((r.cost() - 30.0).abs() < 1e-9, "standard: {}", r.cost());
        r.fast = true;
        assert!((r.cost() - 60.0).abs() < 1e-9, "fast: {}", r.cost());
    }

    #[test]
    fn cost_is_zero_with_no_tokens() {
        assert_eq!(rec("claude-opus-4", 0, 0, 0, 0, 0).cost(), 0.0);
    }

    #[test]
    fn tokens_sums_all_tiers() {
        assert_eq!(rec("x", 1, 2, 3, 4, 5).tokens(), 15);
        assert_eq!(rec("x", 0, 0, 0, 0, 0).tokens(), 0);
    }

    #[test]
    fn days_from_civil_known_anchors() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(2000, 1, 1), 10957);
        assert_eq!(days_from_civil(2000, 3, 1), 11017); // leap-year Feb handled
    }

    #[test]
    fn parse_iso_ms_basic_and_subsecond() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01Z"), 1000);
        assert_eq!(parse_iso_ms("1970-01-02T00:00:00Z"), 86_400_000);
        // Fractional seconds are intentionally dropped (whole-second precision).
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.999Z"), 0);
    }

    #[test]
    fn parse_iso_ms_tolerates_garbage_and_missing_time() {
        assert_eq!(parse_iso_ms("not-a-date"), 0);
        assert_eq!(parse_iso_ms(""), 0);
        // No 'T' → time defaults to 00:00:00, date still parsed.
        assert_eq!(parse_iso_ms("1970-01-02"), 86_400_000);
    }

    #[test]
    fn parse_iso_ms_round_trips_through_iso_from_ms() {
        let s = "2024-03-15T12:34:56.000Z";
        let ms = parse_iso_ms(s);
        assert_eq!(iso_from_ms(ms as u128), s);
    }

    #[test]
    fn project_name_takes_last_nonempty_segment() {
        assert_eq!(project_name("foo-bar-baz"), "baz");
        assert_eq!(project_name("-Users-me-Developer-operator"), "operator");
        assert_eq!(project_name("single"), "single");
        assert_eq!(project_name("trailing-"), "trailing");
        assert_eq!(project_name(""), "");
    }
}
