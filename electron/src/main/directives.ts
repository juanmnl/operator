// The orchestration sentinels: `OPERATOR-DISPATCH [<role>] <task>` and
// `OPERATOR-REPLY [<to>] <text>`. Pure, ported from `src-tauri/src/transcript.rs`.
//
// This is the highest-consequence parsing in the app. A dispatch is DELIVERED INTO ANOTHER
// LANE'S PTY and will auto-launch an idle lane to receive it — so a false positive here
// commissions real work off text a lane merely read. Both halves of the tension are ported
// deliberately, and neither can be dropped without reintroducing a known bug:
//
//   TOLERANCE — models decorate protocol lines despite instructions (bullets, bold,
//   backticks, numbering), and a silently dropped dispatch looks exactly like "the
//   coordinator did nothing".
//
//   QUOTATION GUARDS — with that tolerance, a directive a lane merely QUOTED parsed
//   identically to one it authored. `dev/research-chat-pipeline-audit.md` alone holds 15
//   well-formed dispatch lines; asking a lane to summarise it was enough to fire them.

/** Strip markdown decoration hugging a directive, returning the bare line and the wrapper
 *  characters that were removed (so a symmetric tail can be stripped from the body).
 *
 *  `>` IS DELIBERATELY ABSENT from the list markers. A blockquote is the one marker that means
 *  "this text is not mine, I am quoting it" — stripping it is what let a quoted directive fire.
 *  Removing it cannot break an authored directive: no model blockquotes its own protocol line. */
export function stripDirectiveDecoration(line: string): { text: string; wrappers: string[] } {
  let l = line.trim()
  const wrappers: string[] = []
  for (;;) {
    const before = l
    // List markers, only when followed by a space — so a task that legitimately starts with
    // '-' is not misread as a bullet.
    for (const p of ['-', '*', '•']) {
      if (l.startsWith(p) && l.slice(p.length).startsWith(' ')) l = l.slice(p.length).trimStart()
    }
    // "1." / "2)" numbering.
    const digits = l.length - l.replace(/^\d+/, '').length
    if (digits > 0) {
      const after = l.slice(digits)
      if ((after.startsWith('.') || after.startsWith(')')) && after.slice(1).startsWith(' ')) {
        l = after.slice(1).trimStart()
      }
    }
    // Emphasis / inline-code wrappers hugging the directive itself.
    while (l.length && (l[0] === '`' || l[0] === '*' || l[0] === '_')) {
      wrappers.push(l[0])
      l = l.slice(1)
    }
    l = l.trimStart()
    if (l === before) break
  }
  return { text: l, wrappers }
}

/** The shared parser behind both sentinels — written once so the reply half cannot drift from
 *  the dispatch half's hard-won decoration rules. */
export function parseDirectives(text: string, keyword: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let fence: string | null = null

  for (const line of text.split('\n')) {
    const t = line.trimStart()
    // Fence state, tracked across lines. Opens on ``` / ~~~ and closes on the same marker; the
    // info string ("```rust") is irrelevant. A ~~~ inside a ``` block is content, not a close.
    const marker = ['`', '~'].find((c) => {
      let run = 0
      while (run < t.length && t[run] === c) run++
      return run >= 3
    })
    if (marker) {
      fence = fence === null ? marker : fence === marker ? null : fence
      continue // the fence line itself is never a directive
    }
    if (fence !== null) continue // inside a fenced block — quoted, not authored
    // Indented code block: 4+ leading spaces or a tab is markdown for "verbatim".
    if (line.startsWith('    ') || line.startsWith('\t')) continue

    const { text: l, wrappers } = stripDirectiveDecoration(line)
    if (!l.startsWith(keyword)) continue
    const rest = l.slice(keyword.length).trimStart()
    if (!rest.startsWith('[')) continue
    const close = rest.indexOf(']')
    if (close < 0) continue

    const target = rest.slice(1, close).trim()
    let body = rest.slice(close + 1).trim().replace(/^:+/, '').trim()
    // Strip the tail of a symmetric wrapper — one trailing char per leading one.
    for (const c of [...wrappers].reverse()) {
      if (body.endsWith(c)) body = body.slice(0, -1).trimEnd()
    }
    if (target && body) out.push([target, body])
  }
  return out
}

export const parseDispatches = (text: string) => parseDirectives(text, 'OPERATOR-DISPATCH')
export const parseReplies = (text: string) => parseDirectives(text, 'OPERATOR-REPLY')

/** Stable id for a directive, so re-reading the same transcript line does not re-fire it.
 *
 *  FNV-1a over `sessionId|target|body`, and it must stay BYTE-IDENTICAL to the Rust: the
 *  frontend's seen-set and the chat store's upsert both key on it, so an id that differed
 *  across the port would replay every dispatch in every transcript exactly once, into real
 *  ptys. Computed over UTF-8 bytes, not UTF-16 code units, for the same reason. */
export function directiveId(sessionId: string, target: string, body: string): string {
  const bytes = Buffer.from(`${sessionId}|${target}|${body}`, 'utf8')
  // BigInt rather than Number: FNV-1a is 64-bit and JS numbers lose the low bits above 2^53.
  let h = 0xcbf29ce484222325n
  const MASK = 0xffffffffffffffffn
  for (const b of bytes) {
    h ^= BigInt(b)
    h = (h * 0x100000001b3n) & MASK
  }
  return h.toString(16).padStart(16, '0')
}

export const dispatchId = directiveId
export const replyId = directiveId
