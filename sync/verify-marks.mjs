// Regression net for src/lib/marks.js — mark parsing and the participation pie.
// Run: node sync/verify-marks.mjs   (exit 0 = all green)
// Every number here is made up (public repo): ids/titles like "a1", "Task 1", "MOD101".
import {
  SLICE_COLOUR_COUNT, parseMarkInput, buildPie, formatNumber, wedgePath, ringDash, shortLabel, pieLabels,
} from '../src/lib/marks.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}
// For floats: equal to within 1e-9 (or both null).
function near(name, got, want) {
  const ok = (got === null && want === null) ||
    (typeof got === 'number' && typeof want === 'number' && Math.abs(got - want) < 1e-9)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${got}\n    want ${want}`) }
}

// ---- constants ----
check('SLICE_COLOUR_COUNT is 6', SLICE_COLOUR_COUNT, 6)

// ---- parseMarkInput: accepted ----
check('parse: 88', parseMarkInput('88'), { ok: true, mark: 88, raw: '88' })
check('parse: 88%', parseMarkInput('88%'), { ok: true, mark: 88, raw: '88%' })
check('parse: 88.5', parseMarkInput('88.5'), { ok: true, mark: 88.5, raw: '88.5' })
check('parse: 88,5 (comma decimal)', parseMarkInput('88,5'), { ok: true, mark: 88.5, raw: '88,5' })
check('parse: 22/25 gives 88', parseMarkInput('22/25'), { ok: true, mark: 88, raw: '22/25' })
check('parse: raw keeps the typed text, trimmed, with its inner spaces', parseMarkInput(' 22 / 25 '), { ok: true, mark: 88, raw: '22 / 25' })
check('parse: 17,5/20 gives 87.5', parseMarkInput('17,5/20'), { ok: true, mark: 87.5, raw: '17,5/20' })
check('parse: 1/3 rounds to 2 decimals', parseMarkInput('1/3'), { ok: true, mark: 33.33, raw: '1/3' })
check('parse: 0 is a mark, not a clear', parseMarkInput('0'), { ok: true, mark: 0, raw: '0' })
check('parse: 0/25 is a mark of 0', parseMarkInput('0/25'), { ok: true, mark: 0, raw: '0/25' })
check('parse: 100 is allowed', parseMarkInput('100'), { ok: true, mark: 100, raw: '100' })
check('parse: 25/25 is allowed', parseMarkInput('25/25'), { ok: true, mark: 100, raw: '25/25' })
check('parse: a number with a space before %', parseMarkInput('88 %'), { ok: true, mark: 88, raw: '88 %' })
check('parse: 88.456 rounds to 2 decimals', parseMarkInput('88.456').mark, 88.46)

// ---- parseMarkInput: clear ----
check('parse: empty string clears', parseMarkInput(''), { ok: true, clear: true })
check('parse: whitespace only clears', parseMarkInput('   \t '), { ok: true, clear: true })
check('parse: null clears', parseMarkInput(null), { ok: true, clear: true })
check('parse: undefined clears', parseMarkInput(undefined), { ok: true, clear: true })

// ---- parseMarkInput: rejected ----
const bad = {
  'a negative number': '-5',
  'a negative fraction numerator': '-1/25',
  'more than 100': '101',
  'a decimal over 100': '100.5',
  'a/b with b = 0': '5/0',
  '0/0': '0/0',
  'a/b with a negative b': '5/-2',
  'a > b': '26/25',
  'letters': 'abc',
  'digits then a letter': '88a',
  'a missing denominator': '22/',
  'a missing numerator': '/25',
  'two slashes': '1/2/3',
  'a bare %': '%',
  'NaN': 'NaN',
  'Infinity': 'Infinity',
  'a double sign': '--5',
  'a space inside a number': '8 8',
  'a doubled percent': '88%%',
  'two decimal commas': '1,2,3',
  'exponent notation': '1e2',
}
for (const [what, text] of Object.entries(bad)) {
  check(`parse rejects ${what}: "${text}"`, parseMarkInput(text), { ok: false })
}

// ---- fixtures ----
const A = (id, title, due, weight, type = 'assignment') => ({ id, title, type, due_date: due, weight_pct: weight, status: 'open' })
const M = (id, mark, raw = null) => ({ assessment_id: id, mark, raw })
const MOD = (p) => ({ code: 'MOD101', participation_pct: p })

// ---- a 6-slice module summing to 100 ----
const six = [
  A('a1', 'Task 1', '2026-03-01', 15),
  A('a2', 'Task 2', '2026-03-15', 20),
  A('a3', 'Task 3', '2026-04-01', 10),
  A('a4', 'Task 4', '2026-04-20', 20),
  A('a5', 'Task 5', '2026-05-10', 20),
  A('a6', 'Task 6', '2026-05-30', 15),
]
// Task 5 has no mark yet. Marked weights: 15 + 20 + 10 + 20 + 15 = 80.
// Sum of weight * mark: 15*80 + 20*60 + 10*100 + 20*50 + 15*70 = 1200 + 1200 + 1000 + 1000 + 1050 = 5450.
//   average = 5450 / 80  = 68.125     banked = 5450 / 100 = 54.5
const sixMarks = [M('a1', 80, '80'), M('a2', 60, '12/20'), M('a3', 100), M('a4', 50), M('a6', 70)]
const p6 = buildPie(six, sixMarks, MOD(null))
check('six: six slices in due order', p6.slices.map((s) => s.id), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
check('six: shares equal the weights', p6.slices.map((s) => s.share), [15, 20, 10, 20, 20, 15])
check('six: scale 1, gap 0', [p6.scale, p6.gap], [1, 0])
check('six: first slice starts at 0', p6.slices[0].startAngle, 0)
check('six: last slice ends at exactly 360', p6.slices[5].endAngle, 360)
check('six: start angles', p6.slices.map((s) => s.startAngle), [0, 54, 126, 162, 234, 306])
check('six: end angles', p6.slices.map((s) => s.endAngle), [54, 126, 162, 234, 306, 360])
check('six: each slice starts where the last ended (tiles, no overlap)', p6.slices.every((s, i) => i === 0 || s.startAngle === p6.slices[i - 1].endAngle), true)
check('six: each span is share * 3.6', p6.slices.every((s) => Math.abs((s.endAngle - s.startAngle) - s.share * 3.6) < 1e-9), true)
check('six: stored weight is kept on the slice', p6.slices.map((s) => s.weight), [15, 20, 10, 20, 20, 15])
near('six: average 68.125', p6.average, 68.125)
near('six: banked 54.5', p6.banked, 54.5)
check('six: raw text is passed through', [p6.slices[0].raw, p6.slices[1].raw, p6.slices[2].raw], ['80', '12/20', null])
check('six: the unmarked slice has mark null and fill null', [p6.slices[4].mark, p6.slices[4].fill], [null, null])
check('six: no unweighted rows', p6.unweighted, [])

// ---- four equal slices, all marked ----
// 25 * (100 + 80 + 60 + 40) / 100 = 70 for both the average and what is banked.
const four = [A('b1', 'T1', '2026-03-01', 25), A('b2', 'T2', '2026-03-02', 25), A('b3', 'T3', '2026-03-03', 25), A('b4', 'T4', '2026-03-04', 25)]
const p4 = buildPie(four, [M('b1', 100), M('b2', 80), M('b3', 60), M('b4', 40)], MOD(null))
check('four: end angles 90/180/270/360', p4.slices.map((s) => s.endAngle), [90, 180, 270, 360])
near('four: average 70', p4.average, 70)
near('four: banked 70', p4.banked, 70)
check('four: gap 0', p4.gap, 0)

// ---- the module that stores weights against the final mark ----
// 20 + 20 + 10 with participation_pct 50, plus an exam worth 50: slices must read 40 / 40 / 20.
// Marks 90, 60, 80: banked = 40*.9 + 40*.6 + 20*.8 = 36 + 24 + 16 = 76; average = 76.
const finalShare = [
  A('c1', 'Test 1', '2026-04-01', 20),
  A('c2', 'Test 2', '2026-05-01', 20),
  A('c3', 'Assignment', '2026-06-01', 10),
  A('cx', 'Final exam', '2026-11-01', 50, 'exam'),
]
const pf = buildPie(finalShare, [M('c1', 90), M('c2', 60), M('c3', 80), M('cx', 99)], MOD(50))
check('final-share: the exam is absent from the slices', pf.slices.map((s) => s.id), ['c1', 'c2', 'c3'])
check('final-share: the exam is absent from unweighted too', pf.unweighted, [])
check('final-share: shares 40/40/20', pf.slices.map((s) => s.share), [40, 40, 20])
check('final-share: stored weights are untouched', pf.slices.map((s) => s.weight), [20, 20, 10])
check('final-share: scale 2, gap 0', [pf.scale, pf.gap], [2, 0])
check('final-share: angles tile to 360', pf.slices.map((s) => [s.startAngle, s.endAngle]), [[0, 144], [144, 288], [288, 360]])
near('final-share: average 76', pf.average, 76)
near('final-share: banked 76', pf.banked, 76)
check('final-share: the exam mark never reaches the average', pf.average < 90, true)

// ---- weights that do not reach 100 and match nothing: an honest gap ----
const sixty = [A('d1', 'Task 1', '2026-03-01', 30), A('d2', 'Task 2', '2026-03-02', 20), A('d3', 'Task 3', '2026-03-03', 10)]
const pg = buildPie(sixty, [M('d1', 50)], MOD(null))
check('gap: gap 40, scale 1', [pg.gap, pg.scale], [40, 1])
check('gap: shares equal weights', pg.slices.map((s) => s.share), [30, 20, 10])
check('gap: last endAngle is 216, not 360', pg.slices[2].endAngle, 216)
check('gap: angles', pg.slices.map((s) => [s.startAngle, s.endAngle]), [[0, 108], [108, 180], [180, 216]])
near('gap: average of the one marked slice', pg.average, 50)
near('gap: banked is 30 * 50%', pg.banked, 15)
const pg2 = buildPie(sixty, [], MOD(70))
check('gap: a participation_pct that does not match changes nothing', [pg2.gap, pg2.scale, pg2.slices[2].endAngle], [40, 1, 216])
// 60 of participation_pct 60 DOES match: scale 100 / 60, so 50 / 33.33 / 16.67, no gap.
const pg3 = buildPie(sixty, [], MOD(60))
check('gap: total equal to participation_pct scales instead', [pg3.gap, pg3.slices[2].endAngle], [0, 360])
near('gap: scaled first share is 50', pg3.slices[0].share, 50)
near('gap: scaled second share is 33.33..', pg3.slices[1].share, 100 / 3)
near('gap: scale is 100 / 60', pg3.scale, 100 / 60)

// ---- total over 100 is normalised ----
// 40 + 40 + 20 + 20 = 120, scale 100/120: shares 33.33 / 33.33 / 16.67 / 16.67. Marks all 60: average 60, banked 60.
const over = [A('e1', 'T1', '2026-03-01', 40), A('e2', 'T2', '2026-03-02', 40), A('e3', 'T3', '2026-03-03', 20), A('e4', 'T4', '2026-03-04', 20)]
const po = buildPie(over, [M('e1', 60), M('e2', 60), M('e3', 60), M('e4', 60)], MOD(null))
near('over: scale is 100 / 120', po.scale, 100 / 120)
check('over: gap 0', po.gap, 0)
near('over: first share', po.slices[0].share, 100 / 3)
near('over: shares add up to 100', po.slices.reduce((s, x) => s + x.share, 0), 100)
check('over: last endAngle is exactly 360', po.slices[3].endAngle, 360)
near('over: average 60', po.average, 60)
near('over: banked 60', po.banked, 60)

// ---- unweighted rows ----
// A row with no weight (null or 0) lands in `unweighted` with its mark and never moves the average.
const mixed = [
  A('f1', 'Task 1', '2026-03-01', 50),
  A('f2', 'Task 2', '2026-03-02', 50),
  A('f3', 'Reflection', '2026-02-01', null),
  A('f4', 'Quiz', '2026-02-15', 0),
  A('f5', 'Pending thing', null, null),
  A('fx', 'Exam', '2026-11-01', null, 'exam'),
]
const pm = buildPie(mixed, [M('f1', 80), M('f2', 40), M('f3', 5, '1/20'), M('f4', 100), M('fx', 100)], MOD(null))
check('unweighted: two weighted slices only', pm.slices.map((s) => s.id), ['f1', 'f2'])
check('unweighted: null/zero weights kept, due order, nulls last, exam gone', pm.unweighted.map((u) => u.id), ['f3', 'f4', 'f5'])
check('unweighted: marks and raw are carried', pm.unweighted, [
  { id: 'f3', title: 'Reflection', mark: 5, raw: '1/20' },
  { id: 'f4', title: 'Quiz', mark: 100, raw: null },
  { id: 'f5', title: 'Pending thing', mark: null, raw: null },
])
near('unweighted: average ignores them (60, not pulled by 5 or 100)', pm.average, 60)
near('unweighted: banked ignores them', pm.banked, 60)
const pmNoUn = buildPie(mixed.filter((a) => a.weight_pct), [M('f1', 80), M('f2', 40)], MOD(null))
check('unweighted: result identical to the same module without those rows', [pm.average, pm.banked, pm.slices], [pmNoUn.average, pmNoUn.banked, pmNoUn.slices])

// ---- nothing marked ----
const pn = buildPie(six, [], MOD(null))
check('nothing marked: average null', pn.average, null)
check('nothing marked: banked 0', pn.banked, 0)
check('nothing marked: every fill and mark is null', pn.slices.every((s) => s.fill === null && s.mark === null), true)
check('nothing marked: the circle is still laid out', pn.slices.length, 6)
// A mark row with a null mark (cleared) counts as not marked.
check('a mark row holding null is not a mark', buildPie(four, [M('b1', null, 'x')], MOD(null)).average, null)

// ---- no weighted rows at all ----
check('no weighted rows: empty pie', buildPie([A('g1', 'Task', '2026-03-01', null)], [], MOD(null)),
  { slices: [], unweighted: [{ id: 'g1', title: 'Task', mark: null, raw: null }], average: null, banked: 0, scale: 1, gap: 100 })
check('no assessments at all', buildPie([], [], MOD(null)), { slices: [], unweighted: [], average: null, banked: 0, scale: 1, gap: 100 })
check('exam-only module', buildPie([A('h1', 'Exam', null, 100, 'exam')], [], MOD(null)).slices, [])

// ---- a mark of 0 is a mark ----
const pz = buildPie([A('z1', 'T1', '2026-03-01', 50), A('z2', 'T2', '2026-03-02', 50)], [M('z1', 0, '0'), M('z2', 100)], MOD(null))
check('zero: fill is 0, not null', pz.slices[0].fill, 0)
check('zero: mark is 0, not null', pz.slices[0].mark, 0)
near('zero: it counts in the average (0 and 100 give 50)', pz.average, 50)
near('zero: banked 50', pz.banked, 50)
near('zero alone: average is 0, not null', buildPie([A('z1', 'T1', '2026-03-01', 50), A('z2', 'T2', '2026-03-02', 50)], [M('z1', 0)], MOD(null)).average, 0)

// ---- fill follows the AREA ----
near('fill: mark 25 gives 0.5', buildPie([A('q1', 'T', '2026-03-01', 100)], [M('q1', 25)], MOD(null)).slices[0].fill, 0.5)
near('fill: mark 100 gives 1', buildPie([A('q1', 'T', '2026-03-01', 100)], [M('q1', 100)], MOD(null)).slices[0].fill, 1)
near('fill: mark 50 gives sqrt(0.5)', buildPie([A('q1', 'T', '2026-03-01', 100)], [M('q1', 50)], MOD(null)).slices[0].fill, Math.sqrt(0.5))

// ---- input order never matters ----
// Includes a null due_date, two rows with the same date, and two with the same date AND title.
const jumble = [
  A('j1', 'Beta', '2026-03-10', 20),
  A('j2', 'Alpha', '2026-03-10', 20),
  A('j3', 'Gamma', null, 10),
  A('j4', 'Same', '2026-03-01', 25),
  A('j5', 'Same', '2026-03-01', 25),
  A('j6', 'Loose', null, null),
  A('j7', 'Ab', '2026-02-01', null),
]
const jumbleMarks = [M('j1', 70), M('j2', 90), M('j4', 55), M('j5', 65), M('j7', 33)]
const base = buildPie(jumble, jumbleMarks, MOD(null))
check('order: slices by due date, then title, then id, nulls last', base.slices.map((s) => s.id), ['j4', 'j5', 'j2', 'j1', 'j3'])
check('order: unweighted by the same rule', base.unweighted.map((u) => u.id), ['j7', 'j6'])
check('order: reversed input gives the identical result', buildPie([...jumble].reverse(), [...jumbleMarks].reverse(), MOD(null)), base)
const rotated = [...jumble.slice(3), ...jumble.slice(0, 3)]
check('order: rotated input gives the identical result', buildPie(rotated, jumbleMarks, MOD(null)), base)
check('order: input arrays are not mutated', jumble.map((a) => a.id), ['j1', 'j2', 'j3', 'j4', 'j5', 'j6', 'j7'])

// ---- colour index wraps after six ----
const eight = Array.from({ length: 8 }, (_, i) => A(`k${i}`, `T${i}`, `2026-03-0${i + 1}`, 12.5))
const p8 = buildPie(eight, [], MOD(null))
check('colourIndex: wraps after six', p8.slices.map((s) => s.colourIndex), [0, 1, 2, 3, 4, 5, 0, 1])
check('colourIndex: 8 x 12.5 closes the circle at 360', p8.slices[7].endAngle, 360)

// ---- formatNumber ----
check('formatNumber: whole number has no .0', formatNumber(88), '88')
check('formatNumber: 78.8', formatNumber(78.8), '78.8')
check('formatNumber: rounds to one decimal', formatNumber(68.125), '68.1')
check('formatNumber: rounds up', formatNumber(78.86), '78.9')
check('formatNumber: 0', formatNumber(0), '0')
check('formatNumber: 99.96 becomes 100, not 100.0', formatNumber(99.96), '100')
check('formatNumber: null is empty', formatNumber(null), '')
check('formatNumber: undefined is empty', formatNumber(undefined), '')
check('formatNumber: NaN is empty', formatNumber(NaN), '')
check('formatNumber: a tiny negative is not "-0"', formatNumber(-0.01), '0')

// ---- wedgePath ----
check('wedge: 90 degrees at r 100, centre 100,100', wedgePath(100, 100, 100, 0, 90), 'M100 100 L100 0 A100 100 0 0 1 200 100 Z')
check('wedge: 90 degrees starts its arc at (100,0)', wedgePath(100, 100, 100, 0, 90).includes('L100 0 '), true)
check('wedge: 90 degrees ends at (200,100)', wedgePath(100, 100, 100, 0, 90).endsWith(' 200 100 Z'), true)
check('wedge: 270 degrees sets the large-arc flag', wedgePath(100, 100, 100, 0, 270), 'M100 100 L100 0 A100 100 0 1 1 0 100 Z')
check('wedge: exactly 180 is not "large"', wedgePath(100, 100, 100, 0, 180), 'M100 100 L100 0 A100 100 0 0 1 100 200 Z')
check('wedge: a wedge that does not start at 0', wedgePath(100, 100, 100, 90, 180), 'M100 100 L200 100 A100 100 0 0 1 100 200 Z')
check('wedge: full circle is non-empty', wedgePath(100, 100, 100, 0, 360).length > 0, true)
check('wedge: full circle is two arcs and closed', (wedgePath(100, 100, 100, 0, 360).match(/A/g) || []).length, 2)
check('wedge: full circle has no centre line', wedgePath(100, 100, 100, 0, 360).includes('M100 100 '), false)
check('wedge: zero span is empty', wedgePath(100, 100, 100, 90, 90), '')
check('wedge: reversed span is empty', wedgePath(100, 100, 100, 90, 0), '')
check('wedge: r 0 is empty', wedgePath(100, 100, 0, 0, 90), '')
check('wedge: negative r is empty', wedgePath(100, 100, -5, 0, 90), '')
check('wedge: coordinates are rounded to 2 decimals', wedgePath(100, 100, 100, 0, 30), 'M100 100 L100 0 A100 100 0 0 1 150 13.4 Z')
check('wedge: no "-0" ever appears in a path', wedgePath(0, 0, 50, 0, 90).includes('-0'), false)

// ---- ringDash ----
check('ringDash: circumference is 2*pi*r', ringDash(50, 10).circumference, 2 * Math.PI * 10)
near('ringDash: 50 is half the circumference', ringDash(50, 10).filled, ringDash(50, 10).circumference / 2)
near('ringDash: 25 is a quarter', ringDash(25, 8).filled, ringDash(25, 8).circumference / 4)
check('ringDash: null gives filled 0', ringDash(null, 10).filled, 0)
check('ringDash: null still reports the circumference', ringDash(null, 10).circumference, 2 * Math.PI * 10)
check('ringDash: 0 gives filled 0', ringDash(0, 10).filled, 0)
near('ringDash: 100 fills the ring', ringDash(100, 10).filled, ringDash(100, 10).circumference)
near('ringDash: over 100 is clamped', ringDash(140, 10).filled, ringDash(100, 10).circumference)
check('ringDash: below 0 is clamped', ringDash(-20, 10).filled, 0)

// ---- shortLabel ----
check('label: a plain title is kept', shortLabel('Task 1'), 'Task 1')
check('label: cut at the middle dot', shortLabel('Test 1 · Chapter 1 (opens 3 Aug)'), 'Test 1')
check('label: cut at a long dash', shortLabel('Ass 2 — Video recording (50)'), 'Ass 2')
check('label: cut at a bracket', shortLabel('Quiz (open book)'), 'Quiz')
check('label: cut at a colon', shortLabel('Essay: draft one'), 'Essay')
check('label: module code and year dropped', shortLabel('MODU 101  Assignment 1  2026 · Topic'), 'Assignment 1')
check('label: a title that is only a code is kept', shortLabel('MODU 101 '), 'MODU 101')
check('label: long front part is cut with an ellipsis', shortLabel('A very long assessment name here'), 'A very long asses…')
check('label: null gives an empty string', shortLabel(null), '')

// ---- pieLabels ----
const sl = (weights, title = (i) => `Task ${i + 1}`) => {
  let cum = 0
  return weights.map((w, i) => {
    const s = { id: `s${i}`, title: title(i), startAngle: cum * 3.6, endAngle: (cum + w) * 3.6, colourIndex: i % 6 }
    cum += w
    return s
  })
}
const quarters = pieLabels(sl([25, 25, 25, 25]), 100, 100, 90)
check('labels: one per slice', quarters.labels.length, 4)
check('labels: short names in quarter slices all sit inside', quarters.labels.every((l) => !l.outside && l.anchor === 'middle'), true)
check('labels: nothing outside leaves the viewBox at the plain 200 square', quarters.box, { x: 0, y: 0, w: 200, h: 200 })
check('labels: an inside label is one line when it fits', quarters.labels[0].lines, ['Task 1'])
const thin = pieLabels(sl([5, 95], (i) => `Assignment ${i + 1}`), 100, 100, 90)
check('labels: a 5% slice puts its name outside', thin.labels[0].outside, true)
check('labels: an outside name breaks at the last space', thin.labels[0].lines, ['Assignment', '1'])
check('labels: the big slice keeps its name inside', thin.labels[1].outside, false)
check('labels: the viewBox grows upwards for a name above the rim', thin.box.y < 0, true)
check('labels: a whole-circle slice is labelled at the centre', pieLabels(sl([100]), 100, 100, 90).labels[0].x, 100)
check('labels: no slices, no labels', pieLabels([], 100, 100, 90).labels, [])

console.log(`${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
