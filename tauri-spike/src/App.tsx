import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface HookReq { id: string; body: string }

function App() {
  const termRef = useRef<HTMLDivElement>(null);
  const [requests, setRequests] = useState<HookReq[]>([]);

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'SF Mono', Menlo, monospace",
      fontSize: 13,
      theme: { background: "#1b1b1f" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    if (termRef.current) {
      term.open(termRef.current);
      fit.fit();
    }

    // Risk #2: raw pty bytes -> xterm (no UTF-8 corruption).
    const unlistenData = listen<number[]>("pty-data", (e) => term.write(new Uint8Array(e.payload)));
    const unlistenExit = listen("pty-exit", () => term.write("\r\n[process exited]\r\n"));
    term.onData((d) => { void invoke("pty_write", { data: d }); });
    term.onResize(({ cols, rows }) => { void invoke("pty_resize", { cols, rows }); });
    void invoke("pty_spawn");
    void invoke("pty_resize", { cols: term.cols, rows: term.rows });

    // Risk #1: blocking hook server pushes requests here; respond() unblocks it.
    const unlistenHook = listen<HookReq>("hook-request", (e) => setRequests((r) => [...r, e.payload]));

    const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* */ } });
    if (termRef.current) ro.observe(termRef.current);
    term.focus();

    return () => {
      unlistenData.then((f) => f());
      unlistenExit.then((f) => f());
      unlistenHook.then((f) => f());
      ro.disconnect();
      term.dispose();
    };
  }, []);

  const respond = (id: string, approve: boolean) => {
    void invoke("respond", { id, approve });
    setRequests((r) => r.filter((x) => x.id !== id));
  };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <div ref={termRef} style={{ flex: 1, minWidth: 0, background: "#1b1b1f", padding: 6 }} />
      <div style={{ width: 300, flexShrink: 0, background: "#222", color: "#eee", padding: 14, overflow: "auto", borderLeft: "1px solid #333" }}>
        <h3 style={{ fontSize: 13, margin: "0 0 4px" }}>Hook requests (:47822)</h3>
        <p style={{ fontSize: 11, opacity: 0.5, margin: "0 0 12px", lineHeight: 1.5 }}>
          Spike. Terminal runs a login shell (type <code>claude</code>). Test the blocking flow
          with a POST to <code>localhost:47822/hook</code> — it hangs until you click below.
        </p>
        {requests.length === 0 && <p style={{ fontSize: 11, opacity: 0.4 }}>No pending requests.</p>}
        {requests.map((r) => (
          <div key={r.id} style={{ border: "1px solid #444", borderRadius: 6, padding: 8, marginBottom: 8 }}>
            <pre style={{ fontSize: 10, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "0 0 8px", opacity: 0.8 }}>{r.body.slice(0, 200)}</pre>
            <button onClick={() => respond(r.id, true)} style={{ marginRight: 6 }}>Approve</button>
            <button onClick={() => respond(r.id, false)}>Deny</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
