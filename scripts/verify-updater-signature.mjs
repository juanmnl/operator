#!/usr/bin/env node
// Verify a Tauri updater `.sig` against the public key baked into `src-tauri/tauri.conf.json`,
// INDEPENDENTLY of the tool that produced it.
//
// WHY THIS EXISTS. `tauri signer sign` exiting 0 proves a signature was written, not that the
// installed app will accept it. The plugin's ONLY content check on a downloaded payload is this
// verification (`verify_signature`, tauri-plugin-updater/src/updater.rs) — if the key ids drift
// or the wrong key is in CI, the failure surfaces on the user's machine as "Signature error",
// after the download, on a release that cannot be taken back. The swap release moves every
// installed copy at once, so the check belongs in CI, before publish.
//
// The format is minisign: base64 of a small text file whose payload line decodes to
// `2-byte algorithm || 8-byte key id || 64-byte ed25519 signature`. Algorithm `ED` means the
// signature is over a blake2b-512 prehash of the file; legacy `Ed` signs the bytes directly.
//
// Usage: node scripts/verify-updater-signature.mjs <file> <file.sig> [tauri.conf.json]
import { createHash, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [, , filePath, sigPath, confPath = 'src-tauri/tauri.conf.json'] = process.argv
if (!filePath || !sigPath) {
  console.error('usage: node scripts/verify-updater-signature.mjs <file> <file.sig> [tauri.conf.json]')
  process.exit(2)
}

const fail = (msg) => { console.error(`::error::${msg}`); process.exit(1) }

/** minisign files are `untrusted comment: …\n<base64 payload>\n…`; take the first non-comment line. */
function payloadLine(text) {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('untrusted comment:'))
  if (!line) fail('minisign blob has no payload line')
  return line
}

const conf = JSON.parse(readFileSync(confPath, 'utf8'))
const pubkeyB64 = conf?.plugins?.updater?.pubkey
if (!pubkeyB64) fail(`${confPath} has no plugins.updater.pubkey`)

// The conf holds the whole minisign *public key file*, base64'd once more.
const pub = Buffer.from(payloadLine(Buffer.from(pubkeyB64, 'base64').toString('utf8')), 'base64')
if (pub.length !== 42) fail(`public key payload is ${pub.length} bytes, expected 42`)
const pubAlg = pub.subarray(0, 2).toString('utf8')
const pubKeyId = pub.subarray(2, 10)
const pubKey = pub.subarray(10)

const sig = Buffer.from(payloadLine(Buffer.from(readFileSync(sigPath, 'utf8'), 'base64').toString('utf8')), 'base64')
if (sig.length !== 74) fail(`signature payload is ${sig.length} bytes, expected 74`)
const sigAlg = sig.subarray(0, 2).toString('utf8')
const sigKeyId = sig.subarray(2, 10)
const sigBytes = sig.subarray(10)

// A key-id mismatch means CI signed with a DIFFERENT key than the one installed copies trust —
// the exact way to strand every user, and silent without this check.
if (!pubKeyId.equals(sigKeyId)) {
  fail(`key id mismatch: tauri.conf.json has ${pubKeyId.toString('hex')}, the signature has ${sigKeyId.toString('hex')}`)
}

const bytes = readFileSync(filePath)
const message = sigAlg === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes

// Node's verify() wants a key object; wrap the raw 32-byte ed25519 point in a DER SPKI header.
const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubKey])
const ok = verify(null, message, createPublicKey({ key: spki, format: 'der', type: 'spki' }), sigBytes)

console.log(`  file        ${filePath} (${bytes.length} bytes)`)
console.log(`  pubkey alg  ${pubAlg}  ·  sig alg ${sigAlg}${sigAlg === 'ED' ? ' (blake2b-512 prehash)' : ' (legacy, direct)'}`)
console.log(`  key id      ${pubKeyId.toString('hex')} (matches)`)
console.log(`  ed25519     ${ok ? 'VERIFIED' : 'FAILED'}`)

if (!ok) fail('the updater signature does NOT verify against the pubkey in tauri.conf.json')
