// Usage & cost (port of usage.ts). Parses ~/.claude/projects/<slug>/*.jsonl and
// aggregates token usage + cost per model/project/day from public rates.

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::backend::{iso_from_ms, now_iso};

// $/MTok (input, output) per model family. Cache write 5m = 1.25x, 1h = 2x,
// read = 0.1x input.
fn rates(model: &str) -> (f64, f64) {
    if model.contains("fable") || model.contains("mythos") {
        (10.0, 50.0)
    } else if model.contains("opus") {
        (5.0, 25.0)
    } else if model.contains("sonnet") {
        (3.0, 15.0)
    } else if model.contains("haiku") {
        (1.0, 5.0)
    } else {
        (5.0, 25.0)
    }
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
pub struct ModelUsage {
    model: String,
    input_tokens: u64,
    output_tokens: u64,
    cache_write_tokens: u64,
    cache_read_tokens: u64,
    cost: f64,
    messages: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    slug: String,
    name: String,
    cost: f64,
    tokens: u64,
    messages: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    date: String,
    cost: f64,
    tokens: u64,
}

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

fn line_cost(model: &str, input: u64, output: u64, cache_read: u64, cache5m: u64, cache1h: u64) -> f64 {
    let (ri, ro) = rates(model);
    let per_in = ri / 1e6;
    let per_out = ro / 1e6;
    input as f64 * per_in
        + output as f64 * per_out
        + cache_read as f64 * per_in * 0.1
        + cache5m as f64 * per_in * 1.25
        + cache1h as f64 * per_in * 2.0
}

fn project_name(slug: &str) -> String {
    slug.split('-').filter(|s| !s.is_empty()).next_back().unwrap_or(slug).to_string()
}

pub fn compute_usage(days: i64) -> UsageStats {
    let generated_at = now_iso();
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
    let cutoff_ms = if days > 0 { now_ms.saturating_sub((days as u128) * 86_400_000) } else { 0 };
    let since = if days > 0 { Some(iso_from_ms(cutoff_ms)) } else { None };

    let home = std::env::var("HOME").unwrap_or_default();
    let projects_dir = std::path::Path::new(&home).join(".claude").join("projects");

    let mut by_model: HashMap<String, Acc> = HashMap::new();
    let mut by_project: HashMap<String, Acc> = HashMap::new();
    let mut by_day: HashMap<String, (f64, u64)> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut total_cost = 0.0;
    let mut total_tokens: u64 = 0;

    let Ok(dirs) = std::fs::read_dir(&projects_dir) else {
        return UsageStats { total_cost: 0.0, total_tokens: 0, by_model: vec![], by_project: vec![], by_day: vec![], since, generated_at };
    };

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
            if cutoff_ms > 0 {
                if let Ok(meta) = f.metadata() {
                    if let Ok(modified) = meta.modified() {
                        let m = modified.duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
                        if m < cutoff_ms {
                            continue;
                        }
                    }
                }
            }
            let Ok(raw) = std::fs::read_to_string(&path) else { continue };
            for line in raw.lines() {
                if line.is_empty() {
                    continue;
                }
                let Ok(obj) = serde_json::from_str::<Value>(line) else { continue };
                let msg = match obj.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let usage = match msg.get("usage") {
                    Some(u) => u,
                    None => continue,
                };
                let model = match msg.get("model").and_then(|v| v.as_str()) {
                    Some(m) if m != "<synthetic>" => m,
                    _ => continue,
                };
                if let Some(id) = msg.get("id").and_then(|v| v.as_str()) {
                    let key = format!("{id}:{}", obj.get("requestId").and_then(|v| v.as_str()).unwrap_or(""));
                    if !seen.insert(key) {
                        continue;
                    }
                }
                let u64f = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let input = u64f(usage, "input_tokens");
                let output = u64f(usage, "output_tokens");
                let cache_read = u64f(usage, "cache_read_input_tokens");
                let cc_total = u64f(usage, "cache_creation_input_tokens");
                let (cache5m, cache1h) = match usage.get("cache_creation") {
                    Some(cc) if cc.get("ephemeral_5m_input_tokens").is_some() || cc.get("ephemeral_1h_input_tokens").is_some() => {
                        (u64f(cc, "ephemeral_5m_input_tokens"), u64f(cc, "ephemeral_1h_input_tokens"))
                    }
                    _ => (cc_total, 0),
                };
                let cost = line_cost(model, input, output, cache_read, cache5m, cache1h);
                let cache_write = cache5m + cache1h;
                let tokens = input + output + cache_read + cache_write;
                total_cost += cost;
                total_tokens += tokens;

                let m = by_model.entry(model.to_string()).or_default();
                m.input += input; m.output += output; m.cache_write += cache_write; m.cache_read += cache_read; m.cost += cost; m.messages += 1;

                let p = by_project.entry(slug.clone()).or_default();
                p.input += input; p.output += output; p.cache_write += cache_write; p.cache_read += cache_read; p.cost += cost; p.messages += 1;

                let day = obj.get("timestamp").and_then(|v| v.as_str()).map(|s| s.chars().take(10).collect::<String>()).unwrap_or_else(|| generated_at.chars().take(10).collect());
                let d = by_day.entry(day).or_insert((0.0, 0));
                d.0 += cost; d.1 += tokens;
            }
        }
    }

    let mut model_list: Vec<ModelUsage> = by_model.into_iter().map(|(model, a)| ModelUsage {
        model, input_tokens: a.input, output_tokens: a.output, cache_write_tokens: a.cache_write, cache_read_tokens: a.cache_read, cost: a.cost, messages: a.messages,
    }).collect();
    model_list.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    let mut project_list: Vec<ProjectUsage> = by_project.into_iter().map(|(slug, a)| ProjectUsage {
        name: project_name(&slug), slug, cost: a.cost, tokens: a.input + a.output + a.cache_read + a.cache_write, messages: a.messages,
    }).collect();
    project_list.sort_by(|a, b| b.cost.partial_cmp(&a.cost).unwrap_or(std::cmp::Ordering::Equal));

    let mut day_list: Vec<DayUsage> = by_day.into_iter().map(|(date, (cost, tokens))| DayUsage { date, cost, tokens }).collect();
    day_list.sort_by(|a, b| a.date.cmp(&b.date));

    UsageStats { total_cost, total_tokens, by_model: model_list, by_project: project_list, by_day: day_list, since, generated_at }
}
