// Shelf tidying for a module tab (s47, 2026-10-21): which docs fold away, and how the
// Training Grounds papers split into tabs and topic headings. Pure functions, no React,
// so `node sync/verify-shelf.mjs` can check them.

// Docs whose title (or whose study unit's title) matches fold behind one "▸ N docs" line.
// MATH121's van Hiele originals: Assignment 1 is done, the ten colour editions were crowding
// the Maths tab (her ask, 21 Oct 2026). Add a pattern here to fold another topic.
export const FOLD_PATTERNS = [/van\s+hiele/i]

export function isFoldedTitle(title) {
  if (!title) return false
  return FOLD_PATTERNS.some((re) => re.test(title))
}

// Split a list into the ones to show and the ones to fold. `unitTitle` is the owning study
// unit's title (a unit about a folded topic folds everything under it).
export function splitFolded(items, unitTitle) {
  const unitFolds = isFoldedTitle(unitTitle)
  const shown = []
  const folded = []
  items.forEach((it) => {
    if (unitFolds || isFoldedTitle(it.title)) folded.push(it)
    else shown.push(it)
  })
  return { shown, folded }
}

// ---- Training Grounds ----
// Tabs: practice tests · worksheets & workbooks · past papers. A paper's `kind` is 'past'
// or 'practice'; worksheets/workbooks are practice rows whose title starts with that word.
export const PAPER_TABS = [
  { key: 'practice', label: 'Practice tests' },
  { key: 'worksheet', label: 'Worksheets' },
  { key: 'past', label: 'Past papers' },
]

export function paperTab(p) {
  if (p.kind === 'past') return 'past'
  if (/^\s*(worksheet|workbook)s?\b/i.test(p.title || '')) return 'worksheet'
  return 'practice'
}

// Topic heading inside a tab, read off the title. Unknown topics group under 'Other'.
export function paperTopic(p) {
  const t = p.title || ''
  if (/geometr/i.test(t)) return 'Geometry'
  if (/trig/i.test(t)) return 'Trigonometry'
  if (/van\s+hiele/i.test(t)) return 'van Hiele'
  return 'Other'
}

// First number in the title ("Practice Test 4 · …" → 4, "Worksheet · Geometry 2.3" → 2.3).
export function paperNumber(p) {
  const m = (p.title || '').match(/\d+(?:\.\d+)?/)
  return m ? Number(m[0]) : Infinity
}

// Short row label, because a phone cuts "Practice Test · Geome…" before the part that tells
// them apart (her ask, 21 Oct 2026). Topic initial + number, then the bracketed detail:
//   "Practice Test · Geometry 4 (60 marks, proofs)"  → "G4 · 60 marks, proofs"
//   "Practice Test 1 · Trigonometry"                 → "T1"
//   "Worksheet · Geometry 2.3 (Transformations)"     → "G2.3 · Worksheet · Transformations"
// Past papers and anything without a topic or number keep their full title.
export function paperLabel(p) {
  const title = p.title || ''
  if (paperTab(p) === 'past') return title
  const topic = paperTopic(p)
  const n = paperNumber(p)
  if (topic === 'Other' || n === Infinity) return title
  const parts = [`${topic[0].toUpperCase()}${n}`]
  const kindWord = title.match(/^\s*(worksheet|workbook)/i)
  if (kindWord) parts.push(kindWord[1][0].toUpperCase() + kindWord[1].slice(1).toLowerCase())
  const detail = title.match(/\(([^)]*)\)/)
  if (detail && detail[1].trim()) parts.push(detail[1].trim())
  return parts.join(' · ')
}

// Group one tab's papers under topic headings. Topics keep the order they first appear in
// (the app loads papers newest first, so the topic she is busy with comes first); inside a
// topic the papers run 1, 2, 3 … by the number in their title, ties in input order.
export function groupByTopic(papers) {
  const order = []
  const byTopic = {}
  papers.forEach((p, i) => {
    const topic = paperTopic(p)
    if (!byTopic[topic]) { byTopic[topic] = []; order.push(topic) }
    byTopic[topic].push({ p, i })
  })
  return order.map((topic) => ({
    topic,
    items: byTopic[topic]
      .sort((a, b) => (paperNumber(a.p) - paperNumber(b.p)) || (a.i - b.i))
      .map((x) => x.p),
  }))
}

// Everything the Training Grounds section needs: each tab with its count and its topic groups.
// Past papers keep their input order (year, newest first) under a single heading.
export function buildTrainingGrounds(papers) {
  return PAPER_TABS.map((tab) => {
    const items = papers.filter((p) => paperTab(p) === tab.key)
    const groups = tab.key === 'past'
      ? (items.length ? [{ topic: null, items }] : [])
      : groupByTopic(items)
    return { ...tab, count: items.length, groups }
  })
}

// Which tab to open first: the remembered one if it still has papers, else the first non-empty.
export function pickPaperTab(tabs, remembered) {
  const has = (k) => tabs.some((t) => t.key === k && t.count > 0)
  if (remembered && has(remembered)) return remembered
  const first = tabs.find((t) => t.count > 0)
  return first ? first.key : tabs[0].key
}
