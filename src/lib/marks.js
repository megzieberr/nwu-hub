// Pure maths behind the hub's Marks tab: parsing a typed mark, and turning a module's assessments
// into one participation pie. No Supabase, no DOM, no React, no clock: sync/verify-marks.mjs runs
// this under plain Node.
//
// One pie per module, for the PARTICIPATION mark only (exams are left out of everything here).
//   - slice WIDTH  = the assessment's weight, as a share of the whole circle;
//   - slice FILL   = the mark, filling from the centre outwards. The coloured AREA must match the
//     mark, so the fill radius is R * sqrt(mark / 100) — `fill` below is that sqrt (0 to 1);
//   - no mark yet  = `mark: null`, which the UI draws as an empty dashed outline.
//
// Shapes as they come from the database:
//   assessment { id, title, type, due_date, weight_pct, status }   (weight_pct may be null)
//   mark       { assessment_id, mark, raw }   (mark = percentage 0..100; raw = the text typed, or null)
//   module     { code, participation_pct }    (participation_pct may be null)
//
// Angles are degrees, 0 = 12 o'clock, clockwise.

export const SLICE_COLOUR_COUNT = 6

// ---------- typed input ----------

// Plain number or fraction, comma or full-stop decimal (the South African habit: "88,5").
// No sign, no exponent, no bare "%", no "22/" — anything else is simply not a mark.
const NUM = '(\\d+(?:[.,]\\d+)?)'
const PLAIN_RE = new RegExp(`^${NUM}\\s*%?$`)
const FRACTION_RE = new RegExp(`^${NUM}\\s*/\\s*${NUM}$`)

const toNum = (s) => Number(String(s).replace(',', '.'))
const round2 = (n) => Math.round(n * 100) / 100

// -> { ok: true, clear: true }   empty / whitespace: remove the mark
//    { ok: true, mark, raw }     mark = percentage to 2 decimals, raw = the trimmed text as typed
//    { ok: false }               anything else
// 0 and 0/25 are real marks (0), never a clear.
export function parseMarkInput(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return { ok: true, clear: true }

  let value
  const plain = PLAIN_RE.exec(raw)
  if (plain) {
    value = toNum(plain[1])
  } else {
    const frac = FRACTION_RE.exec(raw)
    if (!frac) return { ok: false }
    const a = toNum(frac[1])
    const b = toNum(frac[2])
    if (!(b > 0) || a > b) return { ok: false }
    value = (a * 100) / b
  }
  if (!Number.isFinite(value) || value < 0 || value > 100) return { ok: false }
  return { ok: true, mark: round2(value), raw }
}

// ---------- the pie ----------

// due_date ascending (nulls last), then title, then id — so the result never depends on input order.
function byDueTitleId(a, b) {
  const ad = a.due_date ?? null
  const bd = b.due_date ?? null
  if (ad !== bd) {
    if (ad === null) return 1
    if (bd === null) return -1
    return ad < bd ? -1 : 1
  }
  const at = String(a.title ?? '')
  const bt = String(b.title ?? '')
  if (at !== bt) return at < bt ? -1 : 1
  const ai = String(a.id ?? '')
  const bi = String(b.id ?? '')
  if (ai !== bi) return ai < bi ? -1 : 1
  return 0
}

const isWeight = (w) => typeof w === 'number' && Number.isFinite(w) && w > 0

// Returns { slices, unweighted, average, banked, scale, gap }.
//
// scale — what the stored weights are multiplied by to become a share of the circle:
//   total is 100                          -> 1
//   total equals participation_pct (>0)   -> 100 / total  (one module stores weights as a share of
//                                            the FINAL mark: 20 + 20 + 10 with participation 50 must
//                                            read 40 / 40 / 20)
//   total over 100                        -> 100 / total
//   otherwise (under 100, no match)       -> 1, and the rest of the circle is an honest `gap`.
//                                            A weight is never guessed.
// average and banked are unrounded. average = weighted mean of the MARKED slices only (null when
// none); banked = "banked so far: X of 100".
export function buildPie(assessments, marks, module) {
  const markById = new Map()
  for (const m of marks || []) {
    if (m && m.assessment_id != null) markById.set(m.assessment_id, m)
  }
  const markOf = (id) => {
    const m = markById.get(id)
    return m && typeof m.mark === 'number' && Number.isFinite(m.mark) ? m : null
  }

  const rows = (assessments || []).filter((a) => a && a.type !== 'exam').slice().sort(byDueTitleId)
  const weighted = rows.filter((a) => isWeight(a.weight_pct))
  const unweighted = rows
    .filter((a) => !isWeight(a.weight_pct))
    .map((a) => {
      const m = markOf(a.id)
      return { id: a.id, title: a.title, mark: m ? m.mark : null, raw: m ? m.raw ?? null : null }
    })

  if (weighted.length === 0) {
    return { slices: [], unweighted, average: null, banked: 0, scale: 1, gap: 100 }
  }

  const total = weighted.reduce((s, a) => s + a.weight_pct, 0)
  const part = module ? module.participation_pct : null
  const partMatches = typeof part === 'number' && part > 0 && Math.abs(total - part) < 0.01

  let scale = 1
  let gap = 0
  if (Math.abs(total - 100) < 0.01) scale = 1
  else if (partMatches) scale = 100 / total
  else if (total > 100) scale = 100 / total
  else gap = 100 - total

  let cum = 0 // running sum of shares, in percent of the circle
  const slices = weighted.map((a, i) => {
    const share = a.weight_pct * scale
    // x * 360 / 100 (not x * 3.6) so whole-number shares give whole-number degrees exactly.
    const startAngle = (cum * 360) / 100
    cum += share
    let endAngle = (cum * 360) / 100
    if (gap === 0 && i === weighted.length - 1) endAngle = 360 // never trust a float sum to close the circle
    const m = markOf(a.id)
    return {
      id: a.id,
      title: a.title,
      weight: a.weight_pct,
      share,
      startAngle,
      endAngle,
      mark: m ? m.mark : null,
      raw: m ? m.raw ?? null : null,
      fill: m ? Math.sqrt(m.mark / 100) : null,
      colourIndex: i % SLICE_COLOUR_COUNT,
    }
  })

  let markedShare = 0
  let weightedSum = 0
  for (const s of slices) {
    if (s.mark === null) continue
    markedShare += s.share
    weightedSum += s.share * s.mark
  }
  const average = markedShare > 0 ? weightedSum / markedShare : null
  const banked = weightedSum / 100

  return { slices, unweighted, average, banked, scale, gap }
}

// ---------- display helpers ----------

// One decimal, no trailing ".0": 88, 78.8. '' for no value.
export function formatNumber(n) {
  if (n === null || n === undefined || typeof n !== 'number' || !Number.isFinite(n)) return ''
  const s = n.toFixed(1).replace(/\.0$/, '')
  return s === '-0' ? '0' : s
}

// A coordinate rounded to 2 decimals, with no "-0" in the path string.
const c2 = (n) => {
  const v = Math.round(n * 100) / 100
  return v === 0 ? 0 : v
}

// SVG path for a pie wedge: centre, line out, arc, close. 0 degrees = 12 o'clock, clockwise (so the
// SVG sweep flag is 1). A full circle can't be drawn as one arc (start = end), so a span of 360 is
// returned as a circle in two half-arcs. r <= 0 or no span gives ''.
export function wedgePath(cx, cy, r, startAngle, endAngle) {
  const span = endAngle - startAngle
  if (!(r > 0) || !(span > 0)) return ''
  if (span >= 360 - 1e-9) {
    return `M${c2(cx)} ${c2(cy - r)} A${c2(r)} ${c2(r)} 0 1 1 ${c2(cx)} ${c2(cy + r)} A${c2(r)} ${c2(r)} 0 1 1 ${c2(cx)} ${c2(cy - r)} Z`
  }
  const pt = (deg) => {
    const rad = (deg * Math.PI) / 180
    return [c2(cx + r * Math.sin(rad)), c2(cy - r * Math.cos(rad))]
  }
  const [x0, y0] = pt(startAngle)
  const [x1, y1] = pt(endAngle)
  const large = span > 180 ? 1 : 0
  return `M${c2(cx)} ${c2(cy)} L${x0} ${y0} A${c2(r)} ${c2(r)} 0 ${large} 1 ${x1} ${y1} Z`
}

// The small "My year" rings: stroke-dasharray = `${filled} ${circumference}`. Mark is clamped to 0..100;
// no mark gives an empty ring.
export function ringDash(mark, r) {
  const circumference = 2 * Math.PI * r
  const m = typeof mark === 'number' && Number.isFinite(mark) ? Math.min(100, Math.max(0, mark)) : 0
  return { circumference, filled: (circumference * m) / 100 }
}
