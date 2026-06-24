// Decode a base64 payload to raw bytes. The pty transport ships base64 (see the
// Rust TerminalDataPayload); the bridge then feeds these bytes to a streaming
// TextDecoder. Extracted as a pure step so the byte conversion has a unit test.

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
