// THE ARTIFACT PLANE'S SERVER — `operator__report` and `operator__task_status`, phase 1.
//
// A minimal stdio MCP server, run as `operator --mcp-serve`. It is THE SAME BINARY as the app:
// Operator is already signed and notarized, already on disk, and already knows where
// `~/.operator` is — shipping a second executable (or requiring node) would add a runtime to
// notarize and a path to resolve, for a process whose whole job is to insert one row.
//
// LANE → OPERATOR ONLY. Both tools are calls a lane makes about itself. Nothing here pushes into
// a lane, and `operator__dispatch` is deliberately absent: the spike holds it until the push/pull
// question is answered honestly, and this brief is explicit that it must not be built here.
//
// IT RUNS BESIDE THE SENTINELS, not instead of them. `OPERATOR-DISPATCH` / `OPERATOR-REPLY` and
// `*-RESULT.md` are untouched — a lane whose charter has not been updated keeps working exactly
// as it does today.
//
// PROTOCOL: JSON-RPC 2.0 over stdio, one message per line. Implemented by hand rather than with an
// SDK because the surface is three methods (`initialize`, `tools/list`, `tools/call`) and adding a
// dependency to the app's binary to serve them would be the larger change.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

use crate::artifacts;

const PROTOCOL_VERSION: &str = "2024-11-05";

/// WHO IS CALLING — and a call that cannot answer this is refused.
///
/// `OPERATOR_TERMINAL_ID` is exported into every lane's environment at spawn (`lib.rs`), and this
/// is what stops it being vestigial. Project and role are then resolved from `sessions.json`,
/// which is keyed by terminal id already.
///
/// REFUSING IS THE POINT (decision 3). An unattributable report is worse than no report: it lands
/// in the store looking like data, and Operator cannot tell whose it is, which task it closes, or
/// whether to believe it. The failure has to be loud at the call site, where the lane can still
/// say something about it, rather than silent in a table.
struct Caller {
    terminal_id: String,
    project_id: Option<String>,
    role_id: Option<String>,
}

fn resolve_caller() -> Result<Caller, String> {
    let terminal_id = std::env::var("OPERATOR_TERMINAL_ID")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            "unattributable call: OPERATOR_TERMINAL_ID is not set in this environment. This tool is \
             only available to a lane Operator launched."
                .to_string()
        })?;

    // sessions.json maps terminal id → project and role. A lane that exists but is not in the
    // snapshot yet is still attributable BY TERMINAL — the row is written with what is known
    // rather than rejected, because the terminal id alone is enough to find the lane.
    let (project_id, role_id) = lookup_session(&terminal_id);
    Ok(Caller { terminal_id, project_id, role_id })
}

fn lookup_session(terminal_id: &str) -> (Option<String>, Option<String>) {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = std::path::Path::new(&home).join(".operator").join("sessions.json");
    let Ok(raw) = std::fs::read_to_string(path) else { return (None, None) };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else { return (None, None) };
    let list = v.as_array().cloned().or_else(|| v.get("sessions")?.as_array().cloned());
    let Some(list) = list else { return (None, None) };
    for s in list {
        if s.get("terminalId").and_then(Value::as_str) == Some(terminal_id) {
            return (
                s.get("projectId").and_then(Value::as_str).map(str::to_string),
                s.get("roleId").and_then(Value::as_str).map(str::to_string),
            );
        }
    }
    (None, None)
}

fn now() -> String {
    // Seconds since the epoch, ISO-ish via chrono-free arithmetic is not worth it here: the store
    // only needs a sortable stamp, and the app renders it. `SystemTime` → RFC3339 without a new
    // dependency.
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm), so the stamp is a real date and sorts as text.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d_ = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d_, rem / 3600, (rem % 3600) / 60, rem % 60
    )
}

fn tool_defs() -> Value {
    json!([
        {
            "name": "operator__report",
            "description":
                "Hand your result to Operator directly. Use this INSTEAD OF (or as well as) writing a \
                 *-RESULT.md file: a file written inside your worktree is invisible to Operator and to \
                 every other lane. Pass the content itself in `artifacts` — never a path into your own \
                 checkout, which is exactly what gets lost.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "summary": { "type": "string", "description": "What you did and what came of it, in prose." },
                    "taskId": { "type": "string", "description": "The task this answers, if it came from one." },
                    "artifacts": {
                        "type": "array",
                        "description": "Named blobs of CONTENT (not paths).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "content": { "type": "string" }
                            },
                            "required": ["name", "content"]
                        }
                    }
                },
                "required": ["summary"]
            }
        },
        {
            "name": "operator__task_status",
            "description":
                "Tell Operator a task's status changed — call it with 'done' the moment you finish one, \
                 without waiting for your session to end. Operator otherwise cannot tell a finished task \
                 from a running one until the lane dies, which is why tasks pile up in 'running'.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "The task id." },
                    "status": {
                        "type": "string",
                        "enum": ["queued", "running", "done", "blocked"],
                        "description": "The task's new status."
                    }
                },
                "required": ["id", "status"]
            }
        }
    ])
}

fn text_result(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

fn error_result(text: &str) -> Value {
    // An MCP tool error is reported IN the result with `isError`, not as a JSON-RPC error — that
    // is what puts the message in front of the model so it can react, instead of failing the call
    // somewhere the lane never sees.
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn call_tool(name: &str, args: &Value) -> Value {
    let caller = match resolve_caller() {
        Ok(c) => c,
        Err(e) => return error_result(&e),
    };
    let conn = match artifacts::open() {
        Ok(c) => c,
        Err(e) => return error_result(&format!("artifact store unavailable: {e}")),
    };
    let at = now();

    match name {
        "operator__report" => {
            let summary = args.get("summary").and_then(Value::as_str).unwrap_or("").trim();
            if summary.is_empty() {
                return error_result("`summary` is required — a report with nothing in it is the silence this tool exists to remove.");
            }
            let task_id = args.get("taskId").and_then(Value::as_str);
            let artifacts_json = args
                .get("artifacts")
                .filter(|v| v.is_array())
                .map(|v| v.to_string())
                .unwrap_or_else(|| "[]".to_string());
            match artifacts::insert_report(
                &conn, &at, &caller.terminal_id,
                caller.project_id.as_deref(), caller.role_id.as_deref(),
                task_id, summary, &artifacts_json,
            ) {
                Ok(id) => text_result(&format!(
                    "Reported to Operator (#{id}). It is readable outside your worktree; you do not need to relay it."
                )),
                Err(e) => error_result(&format!("could not store the report: {e}")),
            }
        }
        "operator__task_status" => {
            let id = args.get("id").and_then(Value::as_str).unwrap_or("").trim();
            let status = args.get("status").and_then(Value::as_str).unwrap_or("").trim();
            if id.is_empty() || status.is_empty() {
                return error_result("`id` and `status` are both required.");
            }
            if !matches!(status, "queued" | "running" | "done" | "blocked") {
                return error_result("`status` must be one of: queued, running, done, blocked.");
            }
            match artifacts::insert_status(
                &conn, &at, &caller.terminal_id, caller.project_id.as_deref(), id, status,
            ) {
                Ok(_) => text_result(&format!("Task {id} marked {status}.")),
                Err(e) => error_result(&format!("could not record the status: {e}")),
            }
        }
        other => error_result(&format!("unknown tool: {other}")),
    }
}

/// Handle one request. Returns `None` for a notification (no `id`), which must not be answered.
pub fn handle(req: &Value) -> Option<Value> {
    let id = req.get("id").cloned();
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    // A notification has no id. `notifications/initialized` is the common one and answering it
    // with a result is a protocol error.
    id.as_ref()?;

    let result = match method {
        "initialize" => json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "operator", "version": env!("CARGO_PKG_VERSION") }
        }),
        "tools/list" => json!({ "tools": tool_defs() }),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            call_tool(name, &args)
        }
        "ping" => json!({}),
        _ => {
            return Some(json!({
                "jsonrpc": "2.0", "id": id,
                "error": { "code": -32601, "message": format!("method not found: {method}") }
            }))
        }
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// The stdio loop. One JSON object per line in, one per line out.
pub fn serve() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(line) else {
            // Malformed input is not worth killing the server for — the client may recover.
            let _ = writeln!(
                stdout,
                "{}",
                json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}})
            );
            let _ = stdout.flush();
            continue;
        };
        if let Some(resp) = handle(&req) {
            let _ = writeln!(stdout, "{resp}");
            let _ = stdout.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_and_tools_list_answer_with_the_two_phase_one_tools() {
        let init = handle(&json!({"jsonrpc":"2.0","id":1,"method":"initialize"})).unwrap();
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);

        let list = handle(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"})).unwrap();
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap()
            .iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["operator__report", "operator__task_status"]);
        // `operator__dispatch` is deliberately NOT here — the spike holds it, and this brief
        // forbids it. A test so nobody adds it without reading why.
        assert!(!names.contains(&"operator__dispatch"));
    }

    #[test]
    fn a_notification_is_never_answered() {
        assert!(handle(&json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
    }

    #[test]
    fn an_unknown_method_is_a_jsonrpc_error_not_a_panic() {
        let r = handle(&json!({"jsonrpc":"2.0","id":9,"method":"nope"})).unwrap();
        assert_eq!(r["error"]["code"], -32601);
    }

    // ATTRIBUTION. These manipulate a process-wide env var, so they run in one test to keep them
    // ordered — cargo runs tests in parallel threads within a process.
    #[test]
    fn an_unattributable_call_is_refused_and_a_report_with_no_summary_too() {
        // Safety: single-threaded within this test; no other test reads this var.
        unsafe { std::env::remove_var("OPERATOR_TERMINAL_ID") };
        let r = call_tool("operator__report", &json!({"summary":"anything"}));
        assert_eq!(r["isError"], true);
        assert!(r["content"][0]["text"].as_str().unwrap().contains("unattributable"));

        // …and an empty id is not attribution either.
        unsafe { std::env::set_var("OPERATOR_TERMINAL_ID", "   ") };
        let r = call_tool("operator__report", &json!({"summary":"anything"}));
        assert_eq!(r["isError"], true);
        unsafe { std::env::remove_var("OPERATOR_TERMINAL_ID") };
    }

    #[test]
    fn status_rejects_a_value_outside_the_enum() {
        // Attribution fails first for an unset id, so this asserts the ORDER too: a bad status on
        // an unattributable call reports the attribution problem, which is the more important one.
        unsafe { std::env::remove_var("OPERATOR_TERMINAL_ID") };
        let r = call_tool("operator__task_status", &json!({"id":"t","status":"banana"}));
        assert_eq!(r["isError"], true);
    }
}
