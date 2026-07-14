// verify-qr.mjs — self-test for src/lib/qr.js. No decoder needed:
//   1. RS correctness — the ecc bytes make the full codeword a valid Reed–Solomon codeword, i.e.
//      every syndrome S_i (evaluated with an INDEPENDENT GF(256) impl here) must be zero.
//   2. Structure — the QR matrix has the three finder patterns, alternating timing rows, the dark
//      module, and the right dimensions; version selection scales with input length.
// Run: node sync/verify-qr.mjs   (exit 0 = all green)
import { qrMatrix, rsEncode } from '../src/lib/qr.js'

let fail = 0
const ok = (name, cond) => { console.log(`${cond ? '✓' : '✗ FAIL'}  ${name}`); if (!cond) fail++ }

// ---- independent GF(256) for the syndrome check (primitive 0x11d) ----
const E = new Array(256), L = new Array(256)
for (let i = 0, x = 1; i < 255; i++) { E[i] = x; L[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d }
E[255] = E[0]
const mul = (a, b) => (a === 0 || b === 0 ? 0 : E[(L[a] + L[b]) % 255])
const powA = (n) => E[((n % 255) + 255) % 255]

function syndromesZero(data, ecLen) {
  const ecc = rsEncode(data, ecLen)
  const full = data.concat(ecc)
  const N = full.length
  for (let i = 0; i < ecLen; i++) {
    let s = 0
    for (let j = 0; j < N; j++) s ^= mul(full[j], powA(i * (N - 1 - j)))
    if (s !== 0) return false
  }
  return true
}

// RS across a spread of ecc lengths and random-ish data.
let rsGood = true
for (const ecLen of [7, 10, 13, 16, 18, 22, 26]) {
  const data = Array.from({ length: 20 }, (_, k) => (k * 31 + ecLen * 7 + 1) & 0xff)
  if (!syndromesZero(data, ecLen)) rsGood = false
}
ok('Reed–Solomon codewords have zero syndromes (GF + ecc correct)', rsGood)

// ---- structure ----
function checkStructure(text, label) {
  const m = qrMatrix(text)
  if (!m) { ok(`${label}: encodes`, false); return }
  const n = m.length
  ok(`${label}: square, size ≡ 17 mod 4 (=${n})`, n >= 21 && (n - 17) % 4 === 0)
  // finder pattern present at a corner: centre 3x3 dark, ring at radius 2 has a light gap
  const finderOK = (r, c) =>
    m[r + 3][c + 3] === true && m[r + 3][c + 1] === false && m[r][c] === true && m[r][c + 6] === true
  ok(`${label}: three finder patterns`,
    finderOK(0, 0) && finderOK(0, n - 7) && finderOK(n - 7, 0))
  // timing row (row 6, between finders) alternates
  let timingOK = true
  for (let c = 8; c < n - 8; c++) if (m[6][c] !== (c % 2 === 0)) timingOK = false
  ok(`${label}: timing pattern alternates`, timingOK)
  ok(`${label}: dark module set`, m[n - 8][8] === true)
  return n
}

const sizeShort = checkStructure('https://efundi.nwu.ac.za/x/EXAMPLE', 'eFundi short URL')
const sizeLong = checkStructure('https://efundi.nwu.ac.za/portal/site/' + 'a'.repeat(60), 'longer URL')
ok('version scales with input length', sizeLong >= sizeShort)
ok('overflow returns null (not a broken code)', qrMatrix('x'.repeat(400)) === null)

console.log(fail ? `\n${fail} check(s) FAILED` : '\nAll QR checks passed.')
process.exit(fail ? 1 : 0)
