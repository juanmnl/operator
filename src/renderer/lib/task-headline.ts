// WHAT A TASK CARD IS CALLED.
//
// `ProjectTask.text` is the message we SENT, not the task. For anything created by a dispatch it
// is an instruction written to an agent — "read <abs path>/brief.md in full and do it; write your
// result to <abs path>" — so the identity a human needs is buried mid-string behind boilerplate
// that repeats on every card. Measured over the real store: 177 tasks, median 651 characters, p90
// 1288, max 2790; 166 of them over 200. In `operator`'s Running column, 15 of 23 cards open with
// the same `Read /Users/…/briefs/….md` prefix, so the first ~90 characters are identical across
// the column — which is exactly where truncation lands. The board is unscannable by construction.
//
// So: derive a headline, and keep the full text one click away.
//
// A `title` field on ProjectTask is the better long-term answer and should win over this when it
// exists — but it fixes nothing for the 177 tasks already in the store, so the deriver is needed
// either way. Build it first; adding the field later is a one-line change at the call site.
//
// Pure and exported, same shape as `partitionBoard` and `landingFor`: the rule is one testable
// thing rather than a regex smeared across a component.

/** A long absolute path in a headline says WHERE, never WHAT. The basename carries the same
 *  identity in a tenth of the budget; the full path is in the opened card, verbatim. */
const SHORTEN = /(?:~|\/Users\/[\w.-]+)(?:\/[\w.-]+)*\/([\w.-]+)/g

/** Leading noise that is about urgency or location, not about the work. */
const PREFIX = [
  /^(?:HIGH|URGENT|BLOCKER|P[012])\b[,:]?\s*(?:do this first)?[,:]?\s*/i,
  /^(?:In|Inside|Under|Within)\s+[~/`][^,]{0,60},\s*/i,
  /^On\s+https?:\/\/\S+\s+/i,
]

/** An agent's status report — "code done: …", "review blocked: …". These arrive as tasks through
 *  the unassigned-dispatch path, and their real subject follows the colon. */
const AGENT = /^(\w+)\s+(done|blocked|finding|report|note)\s*:\s*(.+)$/i

/** The dispatch wrapper, with an em dash handing over to the actual instruction. */
const WRAP = /^.{0,70}?\bread\s+(\S*?([^/\s]+)\.md)\b[^—–]{0,80}?[—–]\s*/i
/** Same, without the dash — a wrapper that runs straight into its instruction. */
const WRAP_BARE = /^.{0,70}?\bread\s+(\S*?([^/\s]+)\.md)\b[^;:]{0,80}/i

/** Trailing delivery instructions. Where the answer goes is not what the task is. */
const DELIV = /\s+as\s+(?:one|a|an)\s+[^,;]*?\S+\.(?:md|html|json|tsx?|css)\b.*$/i
const TAIL = /\s*[;,—–]?\s*(?:and\s+)?(?:writ(?:e|ten)|report|deliver|send|put)\s+(?:your\s+)?(?:findings|result|results|answer|notes|it)?\s*(?:back\s+)?(?:to|into|in)\s+\S*\.md\b.*$/i
const TAIL2 = /\s*[;—–]\s*result(?:s)?\s+to\s+\S+.*$/i

/** `review-sidebar-header.md` → "Review sidebar header". When the wrapper WAS the whole message,
 *  the brief's filename is the truest name available. */
const titleiseFile = (n: string): string => {
  const s = n.replace(/^RESULT-/i, '').replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Never end a headline on a dangling "(" — cut back to before it instead. */
const balance = (s: string): string => {
  const o = (s.match(/\(/g) || []).length
  const c = (s.match(/\)/g) || []).length
  if (o > c) {
    const i = s.lastIndexOf('(')
    return s.slice(0, i).trim().replace(/[,:;—–-]+$/, '')
  }
  return s
}

/** Is this mostly paths, URLs and code spans — i.e. does it say only WHERE? */
const pathHeavy = (s: string): boolean =>
  ((s.match(/(?:[~/][\w./-]{6,}|https?:\/\/\S+|`[^`]+`)/g) || []).join('').length > s.length * 0.45)

/** Cut at the WRITER'S punctuation — em dash, colon, semicolon, an opening aside, a sentence end —
 *  never at a character count. A count cuts mid-word and mid-thought; the writer already marked
 *  where the first idea finishes. */
function firstClause(s: string, min = 24, max = 76): string {
  const marks = [/\s[—–]\s/, /:\s/, /;\s/, /\s\(/, /\.\s+[A-Z]/]
  const cutAt = (from: number): number => {
    let cut = s.length
    for (const re of marks) {
      const m = re.exec(s.slice(from))
      if (m && from + m.index >= min && from + m.index < cut) cut = from + m.index
    }
    return cut
  }
  let out = s.slice(0, cutAt(0)).trim()
  // Extend once if the clause turned out to be only a location.
  if (pathHeavy(out) && out.length < max) out = s.slice(0, cutAt(out.length + 2)).trim()
  if (out.length > max) out = out.replace(/\s*\([^)]{12,}\)/g, '').trim()
  if (out.length > max) {
    const sp = out.lastIndexOf(' ', max)
    out = out.slice(0, sp > min ? sp : max).trim() + '…'
  }
  return balance(out).replace(/[,:;—–-]+$/, '').trim()
}

/** Where a headline came from — shown on the opened card, because derived text a user cannot
 *  trace is text they can neither trust nor correct. */
export type HeadlineSource = 'instruction' | 'brief' | 'report' | 'text' | 'verbatim' | 'empty'

export interface Headline {
  title: string
  from: HeadlineSource
  /** The brief filename, when the task came through a dispatch wrapper. */
  brief?: string
}

/** Derive a card headline from a task's stored text.
 *
 *  Degradation measured over all 177 tasks in the real store: 154 from the first clause, 12 from
 *  the instruction after a wrapper, 7 from an agent report, 3 from a brief filename, 2 returned
 *  verbatim. Lengths 14–77, no unbalanced brackets, no path-only headlines, none empty.
 *
 *  THE GUARD THAT MATTERS: a short hand-typed task ("deploy the landing site so the privacy URL
 *  resolves") comes back untouched. A deriver built for dispatch text must not mangle a task that
 *  is already its own headline. */
/** Derivation is ~10 regex passes over a string whose median is 651 characters, and it runs per
 *  card per render — 23 cards re-rendering on every `session:update` is the exact shape of the
 *  reading-panel freeze (react-markdown re-parsing on each update pegged the WebContent process).
 *  Task text is immutable once written, so the result is cacheable by the text itself.
 *
 *  Bounded because a long-running app sees every task text ever rendered, and an unbounded cache
 *  in a renderer that WebKit already kills under memory pressure would be its own bug. Oldest-out
 *  on overflow via insertion order, which is what a Map iterates in. */
const CACHE = new Map<string, Headline>()
const CACHE_MAX = 500

export function headlineOf(text: string | undefined | null): Headline {
  const key = text ?? ''
  const hit = CACHE.get(key)
  if (hit) return hit
  const out = derive(text)
  if (CACHE.size >= CACHE_MAX) {
    const oldest = CACHE.keys().next().value
    if (oldest !== undefined) CACHE.delete(oldest)
  }
  CACHE.set(key, out)
  return out
}

function derive(text: string | undefined | null): Headline {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return { title: 'Untitled', from: 'empty' }
  const original = t

  t = t.replace(SHORTEN, '$1')
  for (const re of PREFIX) t = t.replace(re, '')

  const report = AGENT.exec(t)
  if (report) return { title: firstClause(report[3]), from: 'report' }

  const strip = (s: string) => s.replace(DELIV, '').replace(TAIL, '').replace(TAIL2, '').trim()

  const wrapped = WRAP.exec(t)
  if (wrapped) {
    const body = strip(t.slice(wrapped[0].length))
    return body.length >= 25
      ? { title: firstClause(body), from: 'instruction', brief: wrapped[2] }
      : { title: titleiseFile(wrapped[2]), from: 'brief', brief: wrapped[2] }
  }

  const bare = WRAP_BARE.exec(t)
  if (bare && /\bread\b/i.test(bare[0])) {
    const rest = strip(t.slice(bare[0].length).replace(/^[\s—–:;,-]+/, ''))
    return rest.length >= 25
      ? { title: firstClause(rest), from: 'instruction', brief: bare[2] }
      : { title: titleiseFile(bare[2]), from: 'brief', brief: bare[2] }
  }

  const body = strip(t)
  // The 25-char floor: a strip that leaves almost nothing has removed the subject, not boilerplate.
  const src = body.length >= 25 ? body : (t.length >= 25 ? t : original)
  return { title: firstClause(src), from: original.length <= 76 ? 'verbatim' : 'text' }
}
