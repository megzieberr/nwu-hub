// Regression net for src/lib/shelf.js — folded docs and the Training Grounds tabs.
// Run: node sync/verify-shelf.mjs   (exit 0 = all green)
// Titles here are made up (public repo).
import {
  isFoldedTitle, splitFolded, paperTab, paperTopic, paperNumber, paperLabel, groupByTopic,
  buildTrainingGrounds, pickPaperTab, PAPER_TABS,
} from '../src/lib/shelf.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

// ---- folding ----
check('fold: "van Hiele" folds', isFoldedTitle('S.S. 3.1 · van Hiele 1999 (original)'), true)
check('fold: "Van Hiele" folds', isFoldedTitle('Assignment 1 · Van Hiele brief'), true)
check('fold: "van Hieles" folds', isFoldedTitle('van Hieles 1984 · Selected Writings'), true)
check('fold: "van  Hiele" (two spaces) folds', isFoldedTitle('van  Hiele'), true)
check('fold: trig does not fold', isFoldedTitle('S.S. 1.4: The law of Sines'), false)
check('fold: empty does not fold', isFoldedTitle(''), false)
check('fold: undefined does not fold', isFoldedTitle(undefined), false)

const docs = [
  { id: 'a', title: 'S.S. 1.4 · Explainer: The Sine Rule' },
  { id: 'b', title: 'S.S. 3.1 · Crowley 1987 — The van Hiele Model' },
  { id: 'c', title: 'Van de Walle Ch 20 - Developing Geometric Thinking' },
]
check('split: by title only', splitFolded(docs, 'S.S. 1.4: The law of Sines').shown.map((d) => d.id), ['a', 'c'])
check('split: folded by title', splitFolded(docs, 'S.S. 1.4: The law of Sines').folded.map((d) => d.id), ['b'])
check('split: a folded unit folds everything under it', splitFolded(docs, 'S.S. 3.1: The van Hiele Model').folded.map((d) => d.id), ['a', 'b', 'c'])
check('split: no unit title', splitFolded(docs).folded.map((d) => d.id), ['b'])
check('split: empty list', splitFolded([], 'x'), { shown: [], folded: [] })

// ---- paper tabs ----
check('tab: past kind', paperTab({ kind: 'past', title: 'December 2024 · Paper 1' }), 'past')
check('tab: practice test', paperTab({ kind: 'practice', title: 'Practice Test 2 · Trigonometry' }), 'practice')
check('tab: worksheet', paperTab({ kind: 'practice', title: 'Worksheet · Geometry 2.2 (Quadrilaterals)' }), 'worksheet')
check('tab: workbook', paperTab({ kind: 'practice', title: 'Workbook · SU1 Trigonometry (write-on)' }), 'worksheet')
check('tab: lowercase worksheet', paperTab({ kind: 'practice', title: 'worksheet 3' }), 'worksheet')
check('tab: "Worksheets" plural still a worksheet', paperTab({ kind: 'practice', title: 'Worksheets · pack' }), 'worksheet')
check('tab: a past paper titled Worksheet stays past', paperTab({ kind: 'past', title: 'Worksheet 2019' }), 'past')
check('tab: no title → practice', paperTab({ kind: 'practice' }), 'practice')

// ---- topics + numbers ----
check('topic: Geometry', paperTopic({ title: 'Practice Test · Geometry 1 (60 marks)' }), 'Geometry')
check('topic: Trigonometry', paperTopic({ title: 'Practice Test 1 · Trigonometry' }), 'Trigonometry')
check('topic: trig abbreviation', paperTopic({ title: 'Trig drill 2' }), 'Trigonometry')
check('topic: van Hiele', paperTopic({ title: 'Practice · van Hiele levels' }), 'van Hiele')
check('topic: Other', paperTopic({ title: 'December 2024 · Paper 1' }), 'Other')
check('number: after the word', paperNumber({ title: 'Practice Test 4 · Trigonometry (100 marks)' }), 4)
check('number: after the topic', paperNumber({ title: 'Practice Test · Geometry 6 (60 marks, book round two)' }), 6)
check('number: decimal', paperNumber({ title: 'Worksheet · Geometry 2.3 (Transformations)' }), 2.3)
check('number: none → Infinity (sorts last)', paperNumber({ title: 'Practice Test · Geometry' }), Infinity)

// ---- short labels ----
check('label: geometry test with detail', paperLabel({ kind: 'practice', title: 'Practice Test · Geometry 4 (60 marks, proofs)' }), 'G4 · 60 marks, proofs')
check('label: trig test, no detail', paperLabel({ kind: 'practice', title: 'Practice Test 1 · Trigonometry' }), 'T1')
check('label: trig test with marks', paperLabel({ kind: 'practice', title: 'Practice Test 4 · Trigonometry (100 marks)' }), 'T4 · 100 marks')
check('label: worksheet decimal', paperLabel({ kind: 'practice', title: 'Worksheet · Geometry 2.3 (Transformations)' }), 'G2.3 · Worksheet · Transformations')
check('label: workbook', paperLabel({ kind: 'practice', title: 'Workbook · SU1 Trigonometry (write-on)' }), 'T1 · Workbook · write-on')
check('label: worksheet, no detail', paperLabel({ kind: 'practice', title: 'Worksheet · SU1 Trigonometry' }), 'T1 · Worksheet')
check('label: past paper keeps its title', paperLabel({ kind: 'past', title: 'December 2024 · Paper 1' }), 'December 2024 · Paper 1')
check('label: unknown topic keeps its title', paperLabel({ kind: 'practice', title: 'Mixed revision 3' }), 'Mixed revision 3')
check('label: no number keeps its title', paperLabel({ kind: 'practice', title: 'Practice Test · Geometry' }), 'Practice Test · Geometry')
check('label: empty brackets ignored', paperLabel({ kind: 'practice', title: 'Practice Test · Geometry 2 ()' }), 'G2')
check('label: no title', paperLabel({ kind: 'practice' }), '')

// ---- grouping: newest first in, 1-2-3 per topic out, topic order = first seen ----
const practice = [
  { id: 'g6', kind: 'practice', title: 'Practice Test · Geometry 6 (60 marks, book round two)' },
  { id: 'g4', kind: 'practice', title: 'Practice Test · Geometry 4 (60 marks, proofs)' },
  { id: 'g3', kind: 'practice', title: 'Practice Test · Geometry 3 (60 marks)' },
  { id: 'g2', kind: 'practice', title: 'Practice Test · Geometry 2 (60 marks)' },
  { id: 'g1', kind: 'practice', title: 'Practice Test · Geometry 1 (60 marks)' },
  { id: 't6', kind: 'practice', title: 'Practice Test 6 · Trigonometry (targeted)' },
  { id: 't5', kind: 'practice', title: 'Practice Test 5 · Trigonometry (100 marks)' },
  { id: 't1', kind: 'practice', title: 'Practice Test 1 · Trigonometry' },
]
const g = groupByTopic(practice)
check('group: topic order = first seen', g.map((x) => x.topic), ['Geometry', 'Trigonometry'])
check('group: geometry runs 1,2,3,4,6', g[0].items.map((p) => p.id), ['g1', 'g2', 'g3', 'g4', 'g6'])
check('group: trig runs 1,5,6', g[1].items.map((p) => p.id), ['t1', 't5', 't6'])
check('group: empty', groupByTopic([]), [])
const tie = groupByTopic([
  { id: 'x', title: 'Worksheet · SU1 Trigonometry' },
  { id: 'y', title: 'Workbook · SU1 Trigonometry (write-on)' },
])
check('group: equal numbers keep input order', tie[0].items.map((p) => p.id), ['x', 'y'])
check('group: unnumbered sorts last', groupByTopic([
  { id: 'n', title: 'Practice Test · Geometry' },
  { id: '2', title: 'Practice Test · Geometry 2' },
])[0].items.map((p) => p.id), ['2', 'n'])

// ---- the whole section ----
const all = [
  ...practice,
  { id: 'w3', kind: 'practice', title: 'Worksheet · Geometry 2.3 (Transformations)' },
  { id: 'w1', kind: 'practice', title: 'Worksheet · Geometry 2.1 (Triangles)' },
  { id: 'ws', kind: 'practice', title: 'Worksheet · SU1 Trigonometry' },
  { id: 'wb', kind: 'practice', title: 'Workbook · SU1 Trigonometry (write-on)' },
  { id: 'p25', kind: 'past', title: 'Assignment 2 2025 (class test, decoded)' },
  { id: 'p24', kind: 'past', title: 'December 2024 · Paper 1' },
  { id: 'p22', kind: 'past', title: 'December 2022 · Paper 1' },
]
const tg = buildTrainingGrounds(all)
check('tg: three tabs in order', tg.map((t) => t.key), ['practice', 'worksheet', 'past'])
check('tg: counts', tg.map((t) => t.count), [8, 4, 3])
check('tg: worksheet topics', tg[1].groups.map((x) => x.topic), ['Geometry', 'Trigonometry'])
check('tg: worksheet geometry 2.1 before 2.3', tg[1].groups[0].items.map((p) => p.id), ['w1', 'w3'])
check('tg: past = one heading-less group in input order', tg[2].groups.map((x) => [x.topic, x.items.map((p) => p.id)]), [[null, ['p25', 'p24', 'p22']]])
check('tg: every paper lands in exactly one tab', tg.reduce((n, t) => n + t.count, 0), all.length)
const none = buildTrainingGrounds([])
check('tg: empty papers → three empty tabs', none.map((t) => [t.count, t.groups.length]), [[0, 0], [0, 0], [0, 0]])

// ---- which tab opens ----
check('pick: remembered tab with papers', pickPaperTab(tg, 'past'), 'past')
check('pick: remembered tab now empty → first non-empty', pickPaperTab(buildTrainingGrounds(practice), 'past'), 'practice')
check('pick: nothing remembered → first non-empty', pickPaperTab(tg, null), 'practice')
check('pick: only past papers → past', pickPaperTab(buildTrainingGrounds(all.filter((p) => p.kind === 'past')), null), 'past')
check('pick: no papers at all → first tab', pickPaperTab(none, 'nonsense'), PAPER_TABS[0].key)

console.log(`${pass}/${pass + fail} verify-shelf`)
process.exit(fail ? 1 : 0)
