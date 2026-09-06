// The APP's half, as a separate process — which is what it is in production. The tool call blocks
// its own thread on `Atomics.wait`, so nothing on that thread can ever answer it; only another
// process can, and that is exactly the shape this seam has in the real app.
const Database = require(process.argv[2])
const db = new Database(process.argv[3])
const verdict = JSON.parse(process.argv[4])
const deadline = Date.now() + 10_000
for (;;) {
  const row = db.prepare('SELECT id FROM dispatch_requests WHERE answered_at IS NULL ORDER BY id DESC LIMIT 1').get()
  if (row) {
    db.prepare('UPDATE dispatch_requests SET answered_at=?, outcome=?, address=?, text=?, task_id=?, reason=? WHERE id=?')
      .run(new Date().toISOString(), verdict.outcome, verdict.address ?? null, verdict.text ?? null,
           verdict.taskId ?? null, verdict.reason ?? null, row.id)
    break
  }
  if (Date.now() > deadline) break
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}
db.close()
