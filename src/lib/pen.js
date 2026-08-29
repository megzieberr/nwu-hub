// Summary pen — dependency-free text-quote anchoring (PLAN-summary-pen.md).
//
// Anchors WORDS, not coordinates: a highlight is {quote, prefix, suffix} — the exact text plus
// ~32 chars of context either side (Hypothesis/Kindle-style text-quote anchor). That means a
// highlight still finds its place after the iframe reflows or the summary is re-seeded with
// minor edits; only a genuinely removed passage goes orphaned. `position` (the flat-text start
// offset at save time) is a reading-order sort key only — it is never used to relocate a quote.

export const CONTEXT_LEN = 32

function isSpace(ch) {
  return /\s/.test(ch)
}

// Flatten every text node under `root` into one normalised string, plus a `segments` map from
// flat-string ranges back to (node, domOffset) so a match in the flat string can become a Range.
// Adjacent text-node segments always get exactly one joining space in the flat text — real prose
// reads correctly whether the gap was actual whitespace (inline tags) or a skipped block boundary
// (bullets, paragraphs) that carries no text node of its own.
function buildIndex(root) {
  const segments = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const orig = node.nodeValue
    if (!orig || !orig.trim()) continue
    let norm = ''
    const map = [] // map[k] = index into `orig` that produced the k-th char of `norm`
    let sp = false
    for (let i = 0; i < orig.length; i++) {
      const ch = orig[i]
      if (isSpace(ch)) { sp = true; continue }
      if (sp && norm.length) { norm += ' '; map.push(i) }
      norm += ch
      map.push(i)
      sp = false
    }
    if (!norm) continue
    if (text.length) text += ' '
    const start = text.length
    text += norm
    segments.push({ node, start, end: start + norm.length, map })
  }
  return { text, segments }
}

// flat offset -> {node, offset}. Offsets that land in the single-space gap between two segments
// snap forward to the start of the next segment — either boundary is a valid Range endpoint.
function locate(segments, offset) {
  for (const seg of segments) {
    if (offset < seg.start) return { node: seg.node, offset: 0 }
    if (offset <= seg.end) {
      const k = offset - seg.start
      const domOffset = k < seg.map.length ? seg.map[k] : seg.node.nodeValue.length
      return { node: seg.node, offset: domOffset }
    }
  }
  const last = segments[segments.length - 1]
  return last ? { node: last.node, offset: last.node.nodeValue.length } : null
}

function toRange(segments, startOffset, endOffset) {
  const s = locate(segments, startOffset)
  const e = locate(segments, endOffset)
  if (!s || !e) return null
  const range = document.createRange()
  range.setStart(s.node, s.offset)
  range.setEnd(e.node, e.offset)
  return range
}

// A Selection's boundary can land on an element (childIndex) rather than a text node
// (charOffset) — e.g. a triple-click select-paragraph. Walk to the nearest text node so
// flatOffset() always has something to look up.
function textBoundary(node, offset) {
  if (node.nodeType === Node.TEXT_NODE) return [node, offset]
  const forward = node.childNodes[offset]
  if (forward) {
    const w = document.createTreeWalker(forward, NodeFilter.SHOW_TEXT)
    const first = forward.nodeType === Node.TEXT_NODE ? forward : w.nextNode()
    if (first) return [first, 0]
  }
  const back = node.childNodes[offset - 1]
  if (back) {
    const w = document.createTreeWalker(back, NodeFilter.SHOW_TEXT)
    let last = back.nodeType === Node.TEXT_NODE ? back : null
    let t
    while ((t = w.nextNode())) last = t
    if (last) return [last, last.nodeValue.length]
  }
  return [node, offset]
}

function flatOffset(segments, node, domOffset) {
  const seg = segments.find((s) => s.node === node)
  if (!seg) return null
  let k = seg.map.findIndex((m) => m >= domOffset)
  if (k === -1) k = seg.map.length
  return seg.start + k
}

// Given a live Selection inside `root`'s document, capture it as a portable text-quote anchor.
// Returns null for a collapsed/empty/foreign selection.
export function captureSelection(root, sel) {
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (range.collapsed || !root.contains(range.commonAncestorContainer)) return null
  const { text, segments } = buildIndex(root)
  const [sNode, sOff] = textBoundary(range.startContainer, range.startOffset)
  const [eNode, eOff] = textBoundary(range.endContainer, range.endOffset)
  const startOffset = flatOffset(segments, sNode, sOff)
  const endOffset = flatOffset(segments, eNode, eOff)
  if (startOffset == null || endOffset == null || endOffset <= startOffset) return null
  return {
    quote: text.slice(startOffset, endOffset),
    prefix: text.slice(Math.max(0, startOffset - CONTEXT_LEN), startOffset),
    suffix: text.slice(endOffset, endOffset + CONTEXT_LEN),
    position: startOffset,
  }
}

// Find where a saved {quote, prefix, suffix} lives in `root` today. Returns a Range or null.
// When the quote repeats, the candidate whose surrounding text best matches the saved
// prefix/suffix wins — an exact same-side match outscores a merely-contains match.
export function findQuote(root, { quote, prefix, suffix }) {
  const { text, segments } = buildIndex(root)
  const qn = String(quote || '').replace(/\s+/g, ' ').trim()
  if (!qn) return null
  const pn = String(prefix || '').replace(/\s+/g, ' ')
  const sn = String(suffix || '').replace(/\s+/g, ' ')

  const candidates = []
  let from = 0
  while (true) {
    const idx = text.indexOf(qn, from)
    if (idx === -1) break
    candidates.push(idx)
    from = idx + 1
  }
  if (!candidates.length) return null

  let best = candidates[0]
  let bestScore = -1
  for (const c of candidates) {
    const before = text.slice(Math.max(0, c - CONTEXT_LEN), c)
    const after = text.slice(c + qn.length, c + qn.length + CONTEXT_LEN)
    const score =
      (pn && before.endsWith(pn) ? 2 : pn && before.includes(pn) ? 1 : 0) +
      (sn && after.startsWith(sn) ? 2 : sn && after.includes(sn) ? 1 : 0)
    if (score > bestScore) { bestScore = score; best = c }
  }
  return toRange(segments, best, best + qn.length)
}

// Wrap `range` in one or more <mark data-pen-id> elements, all sharing `id`. A range that
// crosses element boundaries (bold, bullets) is split per intersected text node — surroundContents
// only works within a single node's boundary. Returns the marks created (empty if the range was
// empty throughout).
export function wrapRange(range, id, color) {
  const anchor = range.commonAncestorContainer
  const container = anchor.nodeType === Node.TEXT_NODE ? anchor.parentNode : anchor
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes = []
  let n
  while ((n = walker.nextNode())) {
    if (range.intersectsNode(n)) nodes.push(n)
  }
  const marks = []
  for (const node of nodes) {
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.nodeValue.length
    if (start >= end) continue
    const sub = document.createRange()
    sub.setStart(node, start)
    sub.setEnd(node, end)
    const mark = node.ownerDocument.createElement('mark')
    mark.dataset.penId = id
    mark.dataset.penColor = color
    sub.surroundContents(mark)
    marks.push(mark)
  }
  return marks
}

// Remove every mark segment carrying `id`, restoring the plain text (merging text nodes back
// together so a later buildIndex() sees the same flat text it would have before wrapping).
export function unwrap(root, id) {
  const marks = root.querySelectorAll(`mark[data-pen-id="${id}"]`)
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark)
    parent.removeChild(mark)
    parent.normalize()
  })
}

export function recolor(root, id, color) {
  root.querySelectorAll(`mark[data-pen-id="${id}"]`).forEach((m) => { m.dataset.penColor = color })
}

export function scrollToMark(root, id) {
  const mark = root.querySelector(`mark[data-pen-id="${id}"]`)
  mark?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
