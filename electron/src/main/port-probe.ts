// "Is anything listening on this loopback port?" — asked by a plain TCP connect, never by lsof.
//
// Extracted because two callers now need the same answer and it must stay the SAME answer:
// `sessionPorts` (which ports a lane is serving) and the boot reaper (is a leased port still
// held, and therefore worth signalling for). A second copy that probed only one loopback would
// disagree with this one on exactly the machines the v6 note below is about.
//
// This is the TCC-safe way to ask. `lsof -i :PORT` inspects another process's open file
// descriptors, which is the specific thing macOS gates behind an "access data from other apps"
// prompt; a connect() to a port opens a socket of our own and asks the kernel nothing about
// anyone else.

/** Is something listening on this loopback port?
 *
 *  BOTH loopbacks are probed. Vite (via Node's localhost resolution) binds [::1] ONLY on some
 *  machines, so a v4-only probe reads a live server as down — and the caller then starts a
 *  second one on the v4 side of the same port. */
export async function isPortLive(port: number): Promise<boolean> {
  const { createConnection } = await import('node:net')
  const probe = (host: string) => new Promise<boolean>((resolve) => {
    const sock = createConnection({ port, host })
    const done = (v: boolean) => { sock.destroy(); resolve(v) }
    sock.setTimeout(250)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
  return (await probe('127.0.0.1')) || (await probe('::1'))
}
