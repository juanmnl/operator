// Usage & cost (port of usage.ts). Parses ~/.claude/projects/<slug>/*.jsonl once
// into a cached in-memory record set, then aggregates per requested range from
// the cache — so switching time filters is instant (no re-scan / re-parse).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::backend::{iso_from_ms, now_iso};

fn rates(model: &str) -> (f64, f64) {
    if model.contains("fable") || model.contains("mythos") { (10.0, 50.0) }
    else if model.contains("opus") { (5.0, 25.0) }
    else if model.contains("sonnet") { (3.0, 15.0) }
    else if model.contains("haiku") { (1.0, 5.0) }
    else { (5.0, 25.0) }
}

// One assistant message's usage, pre-parsed and cached.
struct Record {
    day: String, // YYYY-MM-DD (ISO dates sort lexicographically)
    model: String,
    slug: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache5m: u64,
    cache1h: u64,
}

impl Record {
    fn cost(&self) -> f64 {
        let (ri, ro) = rates(&self.model);
        let per_in = ri / 1e6;
        self.input as f64 * per_in
            + self.output as f64 * (ro / 1e6)
            + self.cache_read as f64 * per_in * 0.1
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
                let day = obj.get("timestamp").and_then(|v| v.as_str()).map(|s| s.chars().take(10).collect::<String>()).unwrap_or_default();
                out.push(Record {
                    day,
                    model,
                    slug: slug.clone(),
                    input: g(usage, "input_tokens"),
                    output: g(usage, "output_tokens"),
                    cache_read: g(usage, "cache_read_input_tokens"),
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

    for r in recs.iter() {
        if !cutoff_day.is_empty() && !r.day.is_empty() && r.day < cutoff_day {
            continue;
        }
        let cost = r.cost();
        let tokens = r.tokens();
        let cache_write = r.cache5m + r.cache1h;
        total_cost += cost;
        total_tokens += tokens;

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

    UsageStats { total_cost, total_tokens, by_model, by_project, by_day, since, generated_at }
}
