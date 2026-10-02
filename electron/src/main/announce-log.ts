// The report announce log: one line per announce pass that found something, from the renderer.
//
// The announce pass runs in the renderer, and when it starved a coordinator for hours on
// 2026-10-02 the only way to see which tab it served, and why it skipped the others, was to attach
// DevTools to the running app (dev/results/lane-signal-back-research-2026-10-02.md, "Not
// verified"). Packaged stderr is not kept, so the lines go to a file.
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { operatorDir } from './store'

export const announceLogFile = (): string => join(operatorDir(), 'logs', 'announce.log')

export const ANNOUNCE_LOG_MAX_BYTES = 512 * 1024

let chain: Promise<void> = Promise.resolve()

/** Append one line, keeping the file under `ANNOUNCE_LOG_MAX_BYTES` by dropping the older half.
 *  Serialised so a trim never races an append. Never throws: a log that cannot be written must not
 *  stop an announcement. */
export function logAnnounce(line: string): Promise<void> {
  const text = String(line).replace(/[\r\n]+/g, ' ')
  chain = chain.then(async () => {
    try {
      const file = announceLogFile()
      await mkdir(join(operatorDir(), 'logs'), { recursive: true })
      const size = await stat(file).then((st) => st.size, () => 0)
      if (size > ANNOUNCE_LOG_MAX_BYTES) {
        const kept = (await readFile(file, 'utf8')).slice(-ANNOUNCE_LOG_MAX_BYTES / 2)
        await writeFile(file, kept.slice(kept.indexOf('\n') + 1))
      }
      await appendFile(file, `${new Date().toISOString()} ${text}\n`)
    } catch { /* nothing to do */ }
  })
  return chain
}
