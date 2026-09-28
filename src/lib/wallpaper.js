// The Week tab's wallpaper: her week as a picture for her desktop.
//
// DRAWN, not photographed. The first version (s38) took a picture of the page with html-to-image.
// That copy lost the hub's fonts, so every label was laid out for one font and drawn in another,
// and the last letter of each name and each time fell off the end. Here the picture is worked out
// from the week's data, the way WhenWorks makes its wallpaper, and every piece of text is measured
// with the same font it is drawn with (`measure` comes from the canvas that does the drawing). If
// a font fails to load, the text is measured AND drawn in the fallback, so nothing is ever cut.
//
// Three things it takes from WhenWorks (whenworks app/admin/render/wallpaper.js):
//   • the picture is made at the REAL size of her screen, so Windows never stretches it;
//   • the grid sits in a centred band: her desktop keeps icons down both sides and the taskbar
//     along the bottom;
//   • a name that does not fit gets an ellipsis, never a silent cut.
// The look itself stays the hub's (her Shovel look, 27 Sep): same colours, same fonts.
//
// Like the rest of src/lib this file touches no DOM: it returns a list of draw instructions and
// lib/wallpaperPaint.js carries them out. Checks: node sync/verify-wallpaper.mjs

import { inkFor, liftForDark } from './planner.js'

// Room left clear around the grid, as a share of the screen. WhenWorks' "Standard" frame, the one
// she uses there: about three icon columns each side, and the taskbar.
export const FRAME = { side: 0.16, top: 0.055, bottom: 0.09 }

export const FALLBACK_SIZE = { w: 1920, h: 1080 }

// The hub palette (src/index.css :root), as fixed values: a canvas cannot read CSS variables.
export const WP = {
  bg: '#05070f',
  ink: '#eaf4ff',
  muted: '#8195bd',
  cyan: '#38e1ff',
  green: '#34f5c5',
  line: 'rgba(80, 140, 255, 0.28)',
  panel: 'rgba(13, 22, 46, 0.72)',
  day: 'rgba(10, 18, 40, 0.55)',
  hour: 'rgba(80, 140, 255, 0.16)',
  half: 'rgba(80, 140, 255, 0.08)',
  notime: 'rgba(2, 8, 22, 0.4)',
}

// ---------- the size of her screen ----------

const SCREENS = [
  [1280, 720], [1366, 768], [1600, 900], [1920, 1080], [2560, 1440], [3840, 2160],
  [1280, 800], [1440, 900], [1680, 1050], [1920, 1200], [2560, 1600], [2880, 1800],
]
const ZOOMS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]

// How far the page is zoomed in the browser (Ctrl +), from the window's outer and inner widths.
// Anything that is not close to a real zoom step (a panel docked beside the page) reads as 100%.
export function pageZoom(outerWidth, innerWidth) {
  const raw = Number(outerWidth) / Number(innerWidth)
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const near = ZOOMS.reduce((a, z) => (Math.abs(z - raw) < Math.abs(a - raw) ? z : a), 1)
  return Math.abs(near - raw) / raw <= 0.04 ? near : 1
}

// Her screen in REAL pixels. `screen.width` counts in scaled units: on a laptop set to 125% a
// 1920 screen reports 1536, and only the pixel ratio turns that back into 1920. The ratio also
// grows when the page is zoomed, so the zoom is taken out again. A result within a hair of a
// standard screen snaps to it; anything that is not a screen at all falls back to 1920 x 1080.
export function wallpaperSize({ width, height, dpr = 1, outerWidth = 0, innerWidth = 0 } = {}) {
  const scale = (Number(dpr) || 1) / pageZoom(outerWidth, innerWidth)
  const w = Math.round((Number(width) || 0) * scale)
  const h = Math.round((Number(height) || 0) * scale)
  if (!(w >= 800 && h >= 600 && w <= 8000 && h <= 8000)) return { ...FALLBACK_SIZE }
  const near = SCREENS.find(([sw, sh]) => Math.abs(sw - w) <= sw * 0.015 && Math.abs(sh - h) <= sh * 0.015)
  return near ? { w: near[0], h: near[1] } : { w, h }
}

export function wallpaperFileName(monday) {
  return `hub-week-${monday}.png`
}

// ---------- colour ----------

function hexRgb(hex) {
  const h = String(hex || '').trim().replace(/^#/, '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

// `t` parts of `hex` over the rest of `onto`, as a plain hex colour.
export function mix(hex, onto, t) {
  const a = hexRgb(hex)
  const b = hexRgb(onto)
  if (!a || !b) return String(onto || '#000000')
  const k = Math.min(Math.max(t, 0), 1)
  return '#' + a.map((v, i) => Math.round(b[i] + (v - b[i]) * k).toString(16).padStart(2, '0')).join('')
}

// ---------- text that fits ----------

// `text` shortened until it fits, with an ellipsis whenever anything was dropped.
export function ellipsize(text, maxW, measure, font) {
  const s = String(text ?? '')
  if (measure(s, font) <= maxW) return s
  for (let n = s.length - 1; n > 0; n -= 1) {
    const cut = `${s.slice(0, n).trimEnd()}…`
    if (measure(cut, font) <= maxW) return cut
  }
  return '…'
}

// Word wrap. A word wider than the line on its own is broken by letters, the only case in which a
// line ends inside a word. Each line remembers what joined it to the next: a space, or nothing.
function wrapAll(text, maxW, measure, font) {
  const words = String(text ?? '').trim().split(/\s+/).filter(Boolean)
  const lines = []
  let cur = ''
  const flush = (join) => { lines.push({ text: cur, join }); cur = '' }
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word
    if (measure(next, font) <= maxW) { cur = next; continue }
    if (cur) flush(' ')
    let rest = word
    while (rest.length > 1 && measure(rest, font) > maxW) {
      let n = rest.length - 1
      while (n > 1 && measure(rest.slice(0, n), font) > maxW) n -= 1
      cur = rest.slice(0, n)
      flush('')
      rest = rest.slice(n)
    }
    cur = rest
  }
  if (cur) flush('')
  return lines
}

// The label on at most `maxLines` lines. When it needs more, the last line carries the rest and
// ends in an ellipsis.
export function wrapLines(text, maxW, maxLines, measure, font) {
  const all = wrapAll(text, maxW, measure, font)
  if (all.length <= maxLines) return all.map((l) => l.text)
  const kept = all.slice(0, maxLines - 1).map((l) => l.text)
  const tail = all.slice(maxLines - 1).map((l, i, a) => l.text + (i < a.length - 1 ? l.join : '')).join('')
  kept.push(ellipsize(tail, maxW, measure, font))
  return kept
}

// A block's time, in the longest form that fits: "10:00 - 10:45", "10:00-10:45", "10:00", or
// nothing. Never a time with a digit missing: half a time is a wrong time.
export function fitTime(start, end, maxW, measure, font) {
  const forms = [`${start} - ${end}`, `${start}-${end}`, `${start}`]
  return forms.find((f) => measure(f, font) <= maxW) || null
}

// ---------- the picture ----------

const body = (size, weight = 700, spacing = 0) => ({ family: 'body', size, weight, spacing })
const display = (size, weight = 700, spacing = 0) => ({ family: 'display', size, weight, spacing })
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * The whole picture.
 *
 * `model` is the week on screen, already placed by lib/planner.js layoutDay:
 *   { title, hours: { start, end },
 *     days: [{ name, num,
 *              blocks: [{ label, start, end, colour, solid, done, top, height, lane, lanes }],
 *              exams: [{ label, colour }], untimed: [{ label, colour }] }] }
 * `measure(text, font)` returns a width in pixels for a font `{ family, size, weight, spacing }`.
 */
export function buildWallpaper({ size, model, measure, frame = FRAME }) {
  const page = { w: size.w, h: size.h }
  const u = page.w / 1920
  const px = (n) => Math.round(n * u)
  const ops = []
  const text = (o) => ops.push({ op: 'text', ...o, x: Math.round(o.x), y: Math.round(o.y), width: measure(o.text, o.font) })

  // Nothing is drawn outside this box (the checks pin it).
  const left = Math.round(page.w * frame.side)
  const right = page.w - left
  const top = Math.round(page.h * frame.top)
  const bottom = page.h - Math.round(page.h * frame.bottom)

  // The hub's own dark ground with its two soft glows.
  ops.push({ op: 'rect', x: 0, y: 0, w: page.w, h: page.h, radius: 0, fill: WP.bg })
  ops.push({
    op: 'radial', cx: page.w * 0.5, cy: page.h * -0.1, rx: 1200 * u, ry: 700 * u, fade: 0.6,
    color: 'rgba(77, 124, 255, 0.18)', colorEnd: 'rgba(77, 124, 255, 0)',
  })
  ops.push({
    op: 'radial', cx: page.w, cy: page.h, rx: 900 * u, ry: 600 * u, fade: 0.55,
    color: 'rgba(154, 107, 255, 0.14)', colorEnd: 'rgba(154, 107, 255, 0)',
  })

  // The dates, reading upward down the left edge, with a thin line beside them.
  const sideSize = px(24)
  const sideW = px(32)
  text({
    x: left + px(4) + sideSize * 0.72, y: (top + bottom) / 2, rotate: -90, align: 'center',
    font: display(sideSize, 900, px(4)), color: WP.cyan, text: String(model.title || '').toUpperCase(),
    glow: { color: 'rgba(56, 225, 255, 0.4)', blur: px(18) },
  })
  ops.push({ op: 'line', x1: left + sideW, y1: top, x2: left + sideW, y2: bottom, color: WP.line, width: 1 })

  const days = model.days || []
  const gridLeft = left + sideW + px(14)
  const axisW = px(50)
  const gap = px(6)
  const colsLeft = gridLeft + axisW + gap
  const colW = (right - colsLeft - gap * (days.length - 1)) / days.length
  const colX = (i) => colsLeft + i * (colW + gap)
  const axisRight = gridLeft + axisW - px(6)

  const meta = {
    size: page, frame: { left, right, top, bottom }, colW,
    days: days.map((d) => ({ name: d.name, num: d.num, blocks: [], exams: [], untimed: [] })),
  }

  // A small label in the hour column, right-aligned, centred on its row.
  const rowLabel = (label, y, h) => {
    const font = body(px(11), 700, px(1))
    const lines = wrapLines(label, axisW - px(6), 3, measure, font)
    const lh = Math.round(font.size * 1.1)
    const y0 = y + (h - lines.length * lh) / 2
    lines.forEach((line, i) => text({
      x: axisRight, y: y0 + i * lh + font.size * 0.82, align: 'right', font, color: WP.muted, text: line,
    }))
  }

  // Row 1: the day names.
  let y = top
  const headH = px(40)
  days.forEach((d, i) => {
    ops.push({ op: 'rect', x: colX(i), y, w: colW, h: headH, radius: px(6), fill: WP.panel, stroke: WP.line, strokeWidth: 1 })
    const nameFont = display(px(13), 700, px(1))
    const numFont = display(px(12), 700, 0)
    const nameW = measure(d.name, nameFont)
    const numW = measure(String(d.num), numFont)
    const x0 = colX(i) + (colW - (nameW + px(6) + numW)) / 2
    const base = y + headH / 2 + nameFont.size * 0.36
    text({ x: x0, y: base, font: nameFont, color: WP.ink, text: d.name })
    text({ x: x0 + nameW + px(6), y: base, font: numFont, color: WP.muted, text: String(d.num) })
  })
  y += headH + gap

  // Row 2, only in a week that has them: learners' maths exam papers, a solid bar each.
  const mostExams = days.reduce((m, d) => Math.max(m, (d.exams || []).length), 0)
  if (mostExams) {
    const barH = px(28)
    const barGap = px(3)
    const rowH = mostExams * barH + (mostExams - 1) * barGap
    rowLabel('EXAMS', y, rowH)
    const font = body(px(14), 700)
    days.forEach((d, i) => (d.exams || []).forEach((ex, k) => {
      const by = y + k * (barH + barGap)
      const label = ellipsize(ex.label, colW - px(16), measure, font)
      ops.push({ op: 'rect', x: colX(i), y: by, w: colW, h: barH, radius: px(6), fill: ex.colour })
      text({ x: colX(i) + px(8), y: by + barH / 2 + font.size * 0.32, font, color: inkFor(ex.colour), text: label })
      meta.days[i].exams.push({ label: ex.label, drawn: label })
    }))
    y += rowH + gap
  }

  // Row 3, only in a week that has them: NWU classes with no time set.
  const mostUntimed = days.reduce((m, d) => Math.max(m, (d.untimed || []).length), 0)
  if (mostUntimed) {
    const lineH = px(18)
    const rowH = Math.max(px(28), mostUntimed * lineH + px(8))
    rowLabel('NO TIME SET', y, rowH)
    const font = body(px(13), 600)
    days.forEach((d, i) => {
      ops.push({
        op: 'rect', x: colX(i), y, w: colW, h: rowH, radius: px(6),
        fill: WP.notime, stroke: WP.line, strokeWidth: 1, dash: [px(4), px(3)],
      })
      const list = d.untimed || []
      const y0 = y + (rowH - list.length * lineH) / 2
      list.forEach((it, k) => {
        const ly = y0 + k * lineH
        const label = ellipsize(it.label, colW - px(20), measure, font)
        ops.push({ op: 'rect', x: colX(i) + px(5), y: ly + px(2), w: Math.max(2, px(2)), h: lineH - px(4), radius: 0, fill: it.colour })
        text({ x: colX(i) + px(12), y: ly + lineH / 2 + font.size * 0.32, font, color: WP.muted, text: label })
        meta.days[i].untimed.push({ label: it.label, drawn: label })
      })
    })
    y += rowH + gap
  }

  // The timeline itself fills what is left of the band.
  const bodyTop = y
  const bodyH = bottom - bodyTop
  const hourCount = Math.max(1, model.hours.end - model.hours.start)
  const hourH = bodyH / hourCount
  Object.assign(meta, { bodyTop, bodyH, hourH })

  // Hour labels: the first sits under its line, the rest are centred on theirs.
  const hourFont = body(px(14), 600)
  for (let i = 0; i < hourCount; i += 1) {
    const lineY = bodyTop + i * hourH
    text({
      x: axisRight, y: i === 0 ? lineY + hourFont.size * 0.8 : lineY + hourFont.size * 0.33,
      align: 'right', font: hourFont, color: WP.muted, text: `${pad2(model.hours.start + i)}:00`,
    })
  }

  const nameFont = body(px(17), 700)
  const timeFont = body(px(13), 600)
  const nameLH = Math.round(nameFont.size * 1.15)
  const timeLH = Math.round(timeFont.size * 1.2)
  const padX = px(7)
  const padY = px(4)
  const tightPad = px(3)
  const seam = Math.max(1, px(1))   // a hair of air, so two blocks back to back read as two

  days.forEach((d, i) => {
    const x = colX(i)
    ops.push({ op: 'rect', x, y: bodyTop, w: colW, h: bodyH, radius: px(8), fill: WP.day, stroke: WP.line, strokeWidth: 1 })
    for (let r = 0; r < hourCount; r += 1) {
      const ly = bodyTop + r * hourH
      if (r > 0) ops.push({ op: 'line', x1: x + 1, y1: ly, x2: x + colW - 1, y2: ly, color: WP.hour, width: 1 })
      ops.push({
        op: 'line', x1: x + 1, y1: ly + hourH / 2, x2: x + colW - 1, y2: ly + hourH / 2,
        color: WP.half, width: 1, dash: [px(4), px(4)],
      })
    }

    for (const b of d.blocks || []) {
      const laneW = colW / Math.max(b.lanes || 1, 1)
      const bx = x + (b.lane || 0) * laneW + px(2)
      const bw = laneW - px(4)
      const by = bodyTop + (b.top / 100) * bodyH + seam
      const bh = Math.max((b.height / 100) * bodyH, px(18)) - seam * 2

      // SOLID (a fixed time) or OUTLINE with a faint fill (a study block she can move).
      const edge = b.solid ? b.colour : liftForDark(b.colour)
      const sw = b.solid ? Math.max(1, px(1)) : Math.max(2, px(2))
      ops.push({
        op: 'rect', x: bx + sw / 2, y: by + sw / 2, w: bw - sw, h: bh - sw, radius: px(6),
        fill: b.solid ? b.colour : mix(b.colour, WP.bg, 0.18), stroke: edge, strokeWidth: sw,
      })

      const ink = b.solid ? inkFor(b.colour) : WP.ink
      const alpha = b.done ? 0.6 : 1
      const innerW = bw - padX * 2 - (b.done ? px(13) : 0)
      const label = String(b.label ?? '')
      const drawn = { label, lines: [], time: null, x: bx, y: by, w: bw, h: bh }

      // How much the type must shrink for name and time to sit one above the other with no air
      // to spare. A 45-MINUTE class is her everyday block and must carry both, also on a day
      // that shows 06:00 to 22:00 with an exam row on top; under 0.8 it is a short block.
      const snug = (bh - tightPad * 2) / (nameFont.size + timeFont.size * 1.05)

      if (bh - padY * 2 >= nameLH + timeLH) {
        // Tall enough: the name on as many lines as the block has room for, the time under it.
        const room = Math.max(1, Math.floor((bh - padY * 2 - timeLH) / nameLH))
        drawn.lines = wrapLines(label, innerW, room, measure, nameFont)
        drawn.lines.forEach((line, k) => text({
          x: bx + padX, y: by + padY + k * nameLH + nameFont.size * 0.86,
          font: nameFont, color: ink, alpha, strike: !!b.done, text: line,
        }))
        drawn.time = fitTime(b.start, b.end, innerW, measure, timeFont)
        if (drawn.time) text({
          x: bx + padX, y: by + padY + drawn.lines.length * nameLH + timeFont.size * 0.86,
          font: timeFont, color: ink, alpha: alpha * 0.85, strike: !!b.done, text: drawn.time,
        })
      } else if (snug >= 0.8) {
        // Just tall enough: one line of name, the time under it, packed close.
        const k = Math.min(1, snug)
        const font = body(Math.floor(nameFont.size * k * 10) / 10, 700)
        const small = body(Math.floor(timeFont.size * k * 10) / 10, 600)
        const y0 = by + (bh - (font.size + small.size * 1.05)) / 2
        drawn.lines = [ellipsize(label, innerW, measure, font)]
        text({ x: bx + padX, y: y0 + font.size * 0.82, font, color: ink, alpha, strike: !!b.done, text: drawn.lines[0] })
        drawn.time = fitTime(b.start, b.end, innerW, measure, small)
        if (drawn.time) text({
          x: bx + padX, y: y0 + font.size + small.size * 0.82,
          font: small, color: ink, alpha: alpha * 0.85, strike: !!b.done, text: drawn.time,
        })
      } else {
        // A short block: name and time share one line, and the TIME gives way first.
        const font = body(Math.max(px(9), Math.min(nameFont.size, Math.floor(bh - px(3)))), 700)
        const small = body(Math.min(timeFont.size, font.size), 600)
        const line = ellipsize(label, innerW, measure, font)
        const base = by + bh / 2 + font.size * 0.32
        drawn.lines = [line]
        text({ x: bx + padX, y: base, font, color: ink, alpha, strike: !!b.done, text: line })
        const used = measure(line, font) + px(6)
        drawn.time = fitTime(b.start, b.end, innerW - used, measure, small)
        if (drawn.time) text({
          x: bx + padX + used, y: base, font: small, color: ink, alpha: alpha * 0.85, strike: !!b.done, text: drawn.time,
        })
      }

      if (b.done) text({
        x: bx + bw - px(6), y: by + Math.min(bh / 2 + px(5), px(16)), align: 'right',
        font: body(px(13), 700), color: WP.green, text: '✓',
      })
      meta.days[i].blocks.push(drawn)
    }
  })

  return { page, ops, meta }
}
