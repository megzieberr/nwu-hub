// qr.js — a tiny, self-contained QR encoder (byte mode) that renders to an inline SVG string.
//
// Zero dependencies, no CDN, works offline in the PWA. Used by the Tests & Exams overlay to turn
// an eFundi assessment URL into a scannable code (scan on the phone → open the assessment). We only
// ever encode short URLs, so versions 1–10 (up to 271 bytes at ecc level M) are ample.
//
// Algorithm is the standard QR spec (Reed–Solomon over GF(256), the canonical block/alignment
// tables, all 8 data masks with penalty scoring). Faithful to the well-known qrcode-generator by
// Kazuhiko Arase (MIT). If the text overflows version 10 the encoder throws and the caller falls
// back to showing the plain link — the QR is a bonus, the link is always there.

// ---- GF(256) log/exp tables (primitive polynomial 0x11d) ----
const EXP = new Array(256)
const LOG = new Array(256)
for (let i = 0; i < 8; i++) EXP[i] = 1 << i
for (let i = 8; i < 256; i++) EXP[i] = EXP[i - 4] ^ EXP[i - 5] ^ EXP[i - 6] ^ EXP[i - 8]
for (let i = 0; i < 255; i++) LOG[EXP[i]] = i
const gexp = (n) => { while (n < 0) n += 255; while (n >= 255) n -= 255; return EXP[n] }
const glog = (n) => LOG[n]

// Reed–Solomon: multiply data polynomial by generator, remainder = ECC bytes.
function rsGenerator(len) {
  let poly = [1]
  for (let i = 0; i < len; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= poly[j] ? gexp(glog(poly[j]) + i) : 0
    }
    poly = next
  }
  return poly
}
export function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen)
  const res = data.concat(new Array(ecLen).fill(0))
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]
    if (coef === 0) continue
    const lead = glog(coef)
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gen[j] ? gexp(glog(gen[j]) + lead) : 0
  }
  return res.slice(data.length)
}

// ---- per-version tables (1..10 only — plenty for short URLs) ----
// RS blocks per version, ecc level M: [numBlocks, totalCodewords, dataCodewords] (twice if 2 groups).
const RS_M = {
  1: [1, 26, 16], 2: [1, 44, 28], 3: [1, 70, 44], 4: [2, 50, 32], 5: [2, 67, 43],
  6: [4, 43, 27], 7: [4, 49, 31], 8: [2, 60, 38, 2, 61, 39], 9: [3, 58, 36, 2, 59, 37],
  10: [4, 69, 43, 1, 70, 44],
}
// Alignment-pattern centre coordinates per version.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
}

function blocksFor(version) {
  const t = RS_M[version]
  const out = []
  for (let i = 0; i < t.length; i += 3) {
    for (let n = 0; n < t[i]; n++) out.push({ total: t[i + 1], data: t[i + 2] })
  }
  return out
}
const dataCapacity = (version) => blocksFor(version).reduce((s, b) => s + b.data, 0)
const lengthBits = (version) => (version < 10 ? 8 : 16)   // byte mode

// ---- bit buffer ----
function makeBitBuffer() {
  const bits = []
  return {
    put(num, len) { for (let i = len - 1; i >= 0; i--) bits.push((num >>> i) & 1) },
    get length() { return bits.length },
    bits,
  }
}

// Build the full codeword stream (data + interleaved ECC) for a version.
function createBytes(text, version) {
  const bytes = []
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)) }
    else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)) }
  }
  const buf = makeBitBuffer()
  buf.put(4, 4)                         // byte mode indicator
  buf.put(bytes.length, lengthBits(version))
  for (const b of bytes) buf.put(b, 8)

  const cap = dataCapacity(version) * 8
  if (buf.length > cap) return null     // overflow → try a bigger version
  // terminator + pad to byte boundary
  for (let i = 0; i < 4 && buf.length < cap; i++) buf.bits.push(0)
  while (buf.length % 8 !== 0) buf.bits.push(0)
  // pad codewords
  const pad = [0xec, 0x11]
  let pi = 0
  while (buf.length < cap) { buf.put(pad[pi++ % 2], 8) }

  // to bytes
  const dataCodewords = []
  for (let i = 0; i < buf.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j]
    dataCodewords.push(v)
  }

  // split into RS blocks, compute ecc
  const blocks = blocksFor(version)
  const dataBlocks = [], eccBlocks = []
  let off = 0
  for (const b of blocks) {
    const d = dataCodewords.slice(off, off + b.data); off += b.data
    dataBlocks.push(d)
    eccBlocks.push(rsEncode(d, b.total - b.data))
  }
  // interleave data then ecc
  const out = []
  const maxData = Math.max(...dataBlocks.map((d) => d.length))
  for (let i = 0; i < maxData; i++) for (const d of dataBlocks) if (i < d.length) out.push(d[i])
  const maxEcc = Math.max(...eccBlocks.map((e) => e.length))
  for (let i = 0; i < maxEcc; i++) for (const e of eccBlocks) if (i < e.length) out.push(e[i])
  return out
}

// ---- BCH codes for format & version information ----
function bch(data, poly, bits) {
  let d = data << (bitLen(poly) - 1)
  while (bitLen(d) - bitLen(poly) >= 0) d ^= poly << (bitLen(d) - bitLen(poly))
  return ((data << (bits)) | d)
}
function bitLen(n) { let l = 0; while (n !== 0) { l++; n >>>= 1 } return l }
const FORMAT_POLY = 0b10100110111
const VERSION_POLY = 0b1111100100101
const FORMAT_MASK = 0b101010000010010
function formatInfo(maskPattern) {
  // ecc level M = 0b00; combine with 3-bit mask, BCH(15,5), xor mask.
  const data = (0b00 << 3) | maskPattern
  const bchBits = bch(data, FORMAT_POLY, 10)
  return bchBits ^ FORMAT_MASK
}
function versionInfo(version) {
  return bch(version, VERSION_POLY, 12)
}

// ---- module matrix ----
function buildMatrix(version, codewords, maskPattern) {
  const size = version * 4 + 17
  const m = Array.from({ length: size }, () => new Array(size).fill(null))

  const setFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
      const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                 (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                 (r >= 2 && r <= 4 && c >= 2 && c <= 4)
      m[rr][cc] = on
    }
  }
  setFinder(0, 0); setFinder(0, size - 7); setFinder(size - 7, 0)

  // timing patterns
  for (let i = 8; i < size - 8; i++) { m[6][i] = i % 2 === 0; m[i][6] = i % 2 === 0 }

  // alignment patterns
  const pos = ALIGN[version]
  for (const r of pos) for (const c of pos) {
    if (m[r][c] !== null) continue   // skip overlap with finders
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      m[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1
    }
  }

  // dark module
  m[size - 8][8] = true

  // reserve format-info areas so data mapping skips them (filled after)
  const reserve = (r, c) => { if (m[r][c] === null) m[r][c] = 'r' }
  for (let i = 0; i < 9; i++) { reserve(8, i); reserve(i, 8) }
  for (let i = 0; i < 8; i++) { reserve(8, size - 1 - i); reserve(size - 1 - i, 8) }
  // version info areas (v>=7) — none for our range (<=10 has version info at v>=7)
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      reserve(size - 11 + j, i); reserve(i, size - 11 + j)
    }
  }

  // map data with mask
  const maskFn = maskFns[maskPattern]
  let bitIdx = 0
  let dir = -1
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--          // skip vertical timing column
    for (let i = 0; i < size; i++) {
      const row = dir < 0 ? size - 1 - i : i
      for (let c = 0; c < 2; c++) {
        const cc = col - c
        if (m[row][cc] !== null) continue
        let bit = false
        if (bitIdx < codewords.length * 8) {
          const byte = codewords[bitIdx >> 3]
          bit = ((byte >> (7 - (bitIdx & 7))) & 1) === 1
        }
        if (maskFn(row, cc)) bit = !bit
        m[row][cc] = bit
        bitIdx++
      }
    }
    dir = -dir
  }

  // write format info (both copies)
  const fmt = formatInfo(maskPattern)
  for (let i = 0; i < 15; i++) {
    const bit = ((fmt >> i) & 1) === 1
    // around top-left
    if (i < 6) m[i][8] = bit
    else if (i < 8) m[i + 1][8] = bit
    else if (i === 8) m[8][7] = bit
    else m[8][14 - i] = bit
    // around top-right / bottom-left
    if (i < 8) m[8][size - 1 - i] = bit
    else m[size - 15 + i][8] = bit
  }

  // write version info (v>=7)
  if (version >= 7) {
    const vinfo = versionInfo(version)
    for (let i = 0; i < 18; i++) {
      const bit = ((vinfo >> i) & 1) === 1
      const r = Math.floor(i / 3), c = i % 3
      m[r][size - 11 + c] = bit
      m[size - 11 + c][r] = bit
    }
  }

  // clear any leftover 'r' reservations that never got written (shouldn't happen)
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === 'r') m[r][c] = false
  return m
}

const maskFns = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

// Penalty scoring to choose the least-noisy mask (standard rules 1–4).
function penalty(m) {
  const size = m.length
  let score = 0
  // rule 1: runs of ≥5 same-colour in row/col
  const runScore = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) score += 3; else if (run > 5) score++ }
        else run = 1
      }
    }
  }
  runScore((a, b) => m[a][b]); runScore((a, b) => m[b][a])
  // rule 2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = m[r][c]
    if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
  }
  // rule 3: finder-like pattern 1:1:3:1:1
  const patt = [true, false, true, true, true, false, true]
  const hasPatt = (get, a, b) => { for (let k = 0; k < 7; k++) if (get(a, b + k) !== patt[k]) return false; return true }
  for (let a = 0; a < size; a++) for (let b = 0; b < size - 6; b++) {
    if (hasPatt((x, y) => m[x][y], a, b)) score += 40
    if (hasPatt((x, y) => m[y][x], a, b)) score += 40
  }
  // rule 4: dark-module proportion
  let dark = 0
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++
  const ratio = (dark * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

// Public: return the QR module matrix (boolean[][]) for `text`, or null if it won't fit v1..10.
export function qrMatrix(text) {
  let version = 0, codewords = null
  for (let v = 1; v <= 10; v++) {
    const cw = createBytes(text, v)
    if (cw) { version = v; codewords = cw; break }
  }
  if (!version) return null
  let best = null, bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const m = buildMatrix(version, codewords, mask)
    const s = penalty(m)
    if (s < bestScore) { bestScore = s; best = m }
  }
  return best
}

// Public: render `text` as an inline SVG string (crisp black/white, quiet-zone margin).
// Returns null if the text can't be encoded (caller shows the plain link instead).
export function qrSvg(text, { margin = 4, size = 220 } = {}) {
  const m = qrMatrix(String(text || ''))
  if (!m) return null
  const n = m.length
  const total = n + margin * 2
  const cell = size / total
  let rects = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (m[r][c]) {
      const x = ((c + margin) * cell).toFixed(2)
      const y = ((r + margin) * cell).toFixed(2)
      rects += `<rect x="${x}" y="${y}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${rects}</g></svg>`
}
