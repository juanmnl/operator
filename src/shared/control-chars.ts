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
