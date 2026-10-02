// CONTROL BYTES NEVER REACH A LANE'S PTY AS TEXT. Shared by main (the MCP dispatch/reply bodies,
// the sentinel parser) and the renderer (the submit queue), so every path into a pty applies the
// same rule.
//
// Operator writes a message as a bracketed paste: `ESC[200~ <text> ESC[201~ \r`. Text that carries
// its own `ESC[201~` ends the paste early, and whatever follows arrives as typed keys: `\x15`
// clears the line, `!cmd\r` runs a shell command in Claude Code's bash mode, `ESC[Z` cycles the
// permission mode. The text comes from places Operator does not control (a Preview page, a lane's
// dispatch or reply), so it is filtered here rather than trusted. Security audit 2026-10-01, H2.
//
// What is removed: every C0 control (U+0000–U+001F) except `\t` and `\n`, plus DEL (U+007F) and
// the C1 range (U+0080–U+009F). C1 is in the list because U+009B is the one-character form of
// `ESC[`, so `\x9b201~` is the same paste terminator to any parser that honours 8-bit controls.
// `\r` is not dropped but turned into `\n` (a `\r\n` pair into one `\n`), so text with Windows or
// old Mac line endings keeps its lines instead of having them glued together.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g
// eslint-disable-next-line no-control-regex
const CONTROL_TEST = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/

/** `text` with control characters removed and line endings normalised to `\n`. */
export function stripControlChars(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '')
}

/** Whether `text` holds a character `stripControlChars` would remove. `\r` does not count: it is
 *  a line ending, not an attack, and normalising it is not worth refusing a message over. */
export function hasControlChars(text: string): boolean {
  return CONTROL_TEST.test(text)
}

// TEXT THAT DISPLAYS DIFFERENTLY FROM WHAT IT SAYS. A separate rule from the one above: these
// characters do nothing to the pty, but they let text shown for the user's approval read one way
// and say another. The bidi embeddings, overrides and isolates (U+202A–202E, U+2066–2069) reorder
// what follows them on screen; the zero-width space, non-joiner and joiner (U+200B–200D) and the
// BOM (U+FEFF) are invisible. Applied to Preview notes before the confirm card shows them and
// before they are sent, so the card and the lane get the same text. Not part of
// `stripControlChars`, because U+200D also joins emoji sequences and every other message keeps
// those intact. Security review 2026-10-02, R1.
const INVISIBLE = /[\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff]/g

/** `text` with bidi controls and zero-width characters removed. */
export function stripInvisibleChars(text: string): string {
  return text.replace(INVISIBLE, '')
}
