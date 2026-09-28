// Regression net for src/lib/wallpaper.js — the Week tab's desktop wallpaper.
// Run: node sync/verify-wallpaper.mjs   (exit 0 = all green)
// Fixtures are name-free on purpose (public repo): labels like "Learner A", "MOD101".
//
// The bug this file exists for (s39): the first wallpaper was a photo of the page, the photo lost
// the fonts, and every name and time lost its last letter. So the checks below are about TEXT:
// whatever is drawn is the whole label, or a label that ends in an ellipsis, and a time is never
// drawn with a piece missing.
import {
  FRAME, FALLBACK_SIZE, pageZoom, wallpaperSize, wallpaperFileName, mix,
  ellipsize, wrapLines, fitTime, buildWallpaper,
} from '../src/lib/wallpaper.js'
import { layoutDay } from '../src/lib/planner.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

// Node has no canvas, so widths are estimated: half the font size per letter, plus the spacing.
// A WIDE estimate on purpose (the real fonts are narrower), so the checks see the tight cases.
const measure = (text, font) => String(text).length * (font.size * 0.5 + (font.spacing || 0))
const f17 = { family: 'body', size: 17, weight: 700, spacing: 0 }
const f13 = { family: 'body', size: 13, weight: 600, spacing: 0 }

// ---- the size of the screen ----
check('size: her laptop, 1920 screen at 125%', wallpaperSize({ width: 1536, height: 864, dpr: 1.25, outerWidth: 1552, innerWidth: 1536 }), { w: 1920, h: 1080 })
check('size: the same laptop with the page zoomed to 110%', wallpaperSize({ width: 1536, height: 864, dpr: 1.375, outerWidth: 1552, innerWidth: 1396 }), { w: 1920, h: 1080 })
check('size: the same laptop with the page zoomed to 90%', wallpaperSize({ width: 1536, height: 864, dpr: 1.125, outerWidth: 1552, innerWidth: 1707 }), { w: 1920, h: 1080 })
check('size: a plain 1920 screen at 100%', wallpaperSize({ width: 1920, height: 1080, dpr: 1, outerWidth: 1936, innerWidth: 1920 }), { w: 1920, h: 1080 })
check('size: a 2560 screen at 150%', wallpaperSize({ width: 1707, height: 960, dpr: 1.5, outerWidth: 1723, innerWidth: 1707 }), { w: 2560, h: 1440 })
check('size: no window widths given, the ratio is used as it is', wallpaperSize({ width: 1536, height: 864, dpr: 1.25 }), { w: 1920, h: 1080 })
check('size: an odd screen keeps its own numbers', wallpaperSize({ width: 2000, height: 1300, dpr: 1 }), { w: 2000, h: 1300 })
check('size: nothing that looks like a screen falls back', wallpaperSize({ width: 0, height: 0, dpr: 1 }), FALLBACK_SIZE)
check('size: no input at all falls back', wallpaperSize(), FALLBACK_SIZE)
check('zoom: a panel docked beside the page is not a zoom', pageZoom(1552, 1100), 1)
check('zoom: 125%', pageZoom(1552, 1229), 1.25)

check('file name', wallpaperFileName('2026-09-28'), 'hub-week-2026-09-28.png')
check('mix: none of the colour is the ground', mix('#ffffff', '#05070f', 0), '#05070f')
check('mix: all of the colour is the colour', mix('#22a55b', '#05070f', 1), '#22a55b')

// ---- text that fits ----
check('ellipsize: a label that fits is untouched', ellipsize('Learner A', 200, measure, f17), 'Learner A')
check('ellipsize: a label that does not fit ends in an ellipsis', ellipsize('Learner Alphabetical', 100, measure, f17).endsWith('…'), true)
check('ellipsize: and it fits', measure(ellipsize('Learner Alphabetical', 100, measure, f17), f17) <= 100, true)
check('wrap: short label, one line', wrapLines('Learner A', 150, 3, measure, f17), ['Learner A'])
check('wrap: breaks between words', wrapLines('MOD101 semester practice test', 150, 3, measure, f17), ['MOD101 semester', 'practice test'])
check('wrap: out of lines, the last one ends in an ellipsis', wrapLines('MOD101 semester practice test and revision', 150, 2, measure, f17).at(-1).endsWith('…'), true)
check('wrap: a word wider than the line is broken, no letter lost', wrapLines('Supercalifragilistic', 80, 5, measure, f17).join(''), 'Supercalifragilistic')
check('time: the full form when it fits', fitTime('10:00', '10:45', 150, measure, f13), '10:00 - 10:45')
check('time: the tight form next', fitTime('10:00', '10:45', 75, measure, f13), '10:00-10:45')
check('time: the start alone next', fitTime('10:00', '10:45', 40, measure, f13), '10:00')
check('time: nothing rather than half a time', fitTime('10:00', '10:45', 20, measure, f13), null)

// ---- the picture ----
const b = (label, start, end, extra = {}) => ({ id: label + start, label, start_time: start, end_time: end, colour: '#22a55b', solid: false, done: false, ...extra })
const hours = { start: 8, end: 22 }
const dayRows = [
  [b('MOD101', '09:00', '10:30', { solid: true, colour: '#34f5c5' }), b('MOD102', '10:30', '12:00', { solid: true }),
    b('Learner A', '12:00', '12:45', { colour: '#8a94a8' }), b('Learner A', '13:00', '13:45', { colour: '#8a94a8' }),
    b('MOD103 lesson 9 + the online class', '19:00', '21:00', { colour: '#4d7cff' })],
  [b('Record MOD103 Assignment 2', '14:00', '16:00'), b('MOD104 semester practice test + revision with tutor', '16:00', '18:00')],
  [b('Learner Bravo', '12:00', '12:45'), b('Essay outline', '14:00', '15:00'), b('Lesson prep', '14:30', '15:30'),
    b('Walk', '19:30', '20:00'), b('Quarter', '20:15', '20:30')],
  [b('Gr12 HSK', '10:00', '10:45'), b('Gr12 HSK', '11:00', '11:45'), b('Reading log', '12:00', '13:30', { done: true })],
  [b('Grade 11', '14:00', '14:45', { colour: '#ef4444' }), b('Grade 11', '15:00', '15:45', { colour: '#ef4444' })],
  [],
  [b('Plan next week', '10:00', '11:00'), b('MOD104 semester test study with tutor', '11:00', '14:00')],
]
const NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const model = {
  title: '28 Sep - 4 Oct',
  hours,
  days: dayRows.map((rows, i) => ({
    name: NAMES[i],
    num: i < 3 ? 28 + i : i - 2,
    blocks: layoutDay(rows, hours.start * 60, hours.end * 60).map((p) => ({
      label: p.row.label, start: p.row.start_time, end: p.row.end_time, colour: p.row.colour,
      solid: p.row.solid, done: p.row.done, top: p.top, height: p.height, lane: p.lane, lanes: p.lanes,
    })),
    exams: i === 4 ? [{ label: 'Gr12 HSK: Maths P1', colour: '#22a55b' }] : [],
    untimed: i === 3 ? [{ label: 'MOD102 online session', colour: '#9a6bff' }] : [],
  })),
}

const squash = (s) => String(s).replace(/\s+/g, '')
const timeForms = (blk) => [`${blk.start} - ${blk.end}`, `${blk.start}-${blk.end}`, `${blk.start}`, null]

for (const size of [{ w: 1920, h: 1080 }, { w: 2560, h: 1440 }, { w: 1366, h: 768 }]) {
  const tag = `${size.w}x${size.h}`
  const { page, ops, meta } = buildWallpaper({ size, model, measure })
  check(`${tag}: the picture is the size asked for`, page, size)

  // The band: WhenWorks' standard frame, the same room on both sides.
  const fr = meta.frame
  check(`${tag}: band clears the sides`, [fr.left, page.w - fr.right], [Math.round(size.w * FRAME.side), Math.round(size.w * FRAME.side)])
  check(`${tag}: band clears the taskbar`, page.h - fr.bottom, Math.round(size.h * FRAME.bottom))

  // Nothing but the ground is drawn outside the band.
  const out = []
  for (const o of ops) {
    if (o.op === 'radial') continue
    if (o.op === 'rect') {
      if (o.w === page.w && o.h === page.h) continue
      if (o.x < fr.left - 0.5 || o.x + o.w > fr.right + 0.5 || o.y < fr.top - 0.5 || o.y + o.h > fr.bottom + 0.5) out.push(o)
    } else if (o.op === 'line') {
      if (Math.min(o.x1, o.x2) < fr.left || Math.max(o.x1, o.x2) > fr.right || Math.min(o.y1, o.y2) < fr.top || Math.max(o.y1, o.y2) > fr.bottom + 0.5) out.push(o)
    } else if (o.op === 'text') {
      if (o.rotate) {
        // on its side: its length runs up and down, its capitals stand leftward from x
        if (o.x - o.font.size * 0.8 < fr.left - 0.5 || o.y - o.width / 2 < fr.top || o.y + o.width / 2 > fr.bottom) out.push(o)
        continue
      }
      const x0 = o.align === 'right' ? o.x - o.width : o.align === 'center' ? o.x - o.width / 2 : o.x
      if (x0 < fr.left - 0.5 || x0 + o.width > fr.right + 0.5 || o.y - o.font.size < fr.top - 0.5 || o.y > fr.bottom + 0.5) out.push(o)
    }
  }
  check(`${tag}: nothing drawn outside the band`, out.map((o) => o.text || o.op), [])

  // Every block: the whole label, or a label ending in an ellipsis; never a bare cut.
  const blocks = meta.days.flatMap((d) => d.blocks)
  check(`${tag}: every block is drawn`, blocks.length, dayRows.flat().length)
  const cut = blocks.filter((k) => {
    const drawn = k.lines.join('')
    if (squash(drawn) === squash(k.label)) return false
    return !(k.lines.at(-1).endsWith('…') && squash(k.label).startsWith(squash(drawn.slice(0, -1))))
  })
  check(`${tag}: no label loses letters without an ellipsis`, cut.map((k) => [k.label, k.lines]), [])

  // Text stays inside its own block.
  const spill = blocks.filter((k) => k.lines.some((line) => measure(line, f17) * (size.w / 1920) > k.w + 0.5 && line !== '…'))
  check(`${tag}: no line is wider than its block`, spill.map((k) => [k.label, k.lines]), [])

  // Times: one of the whole forms, or left out.
  const flatModel = model.days.flatMap((d) => d.blocks)
  const badTime = blocks.filter((k, i) => !timeForms(flatModel[i]).includes(k.time))
  check(`${tag}: no time is drawn with a piece missing`, badTime.map((k) => [k.label, k.time]), [])

  // A 45-minute class is her everyday block: it must carry BOTH its name and its whole time.
  const lesson = blocks.find((k) => k.label === 'Learner Bravo')
  check(`${tag}: a 45-minute class shows its whole name`, lesson.lines, ['Learner Bravo'])
  check(`${tag}: a 45-minute class shows its whole time`, lesson.time, '12:00 - 12:45')

  // Roomy blocks show long labels in full.
  const long = blocks.find((k) => k.label === 'MOD104 semester practice test + revision with tutor')
  check(`${tag}: a two-hour block shows a long label in full`, squash(long.lines.join('')), squash(long.label))

  // Exam bar and the no-time row are there, whole or with an ellipsis.
  check(`${tag}: the exam bar is drawn`, meta.days[4].exams.map((e) => e.drawn === e.label || e.drawn.endsWith('…')), [true])
  check(`${tag}: the no-time class is drawn`, meta.days[3].untimed.map((e) => e.drawn === e.label || e.drawn.endsWith('…')), [true])

  // Every instruction is one the painter knows.
  check(`${tag}: only known draw instructions`, [...new Set(ops.map((o) => o.op))].sort(), ['line', 'radial', 'rect', 'text'])
}

// Her longest day (06:00 to 24:00) with the exam row on top: the 45-minute class still has both.
const longDay = { ...model, hours: { start: 6, end: 24 }, days: model.days.map((d, i) => ({
  ...d,
  blocks: layoutDay(dayRows[i], 6 * 60, 24 * 60).map((p) => ({
    label: p.row.label, start: p.row.start_time, end: p.row.end_time, colour: p.row.colour,
    solid: p.row.solid, done: p.row.done, top: p.top, height: p.height, lane: p.lane, lanes: p.lanes,
  })),
})) }
const tight = buildWallpaper({ size: { w: 1920, h: 1080 }, model: longDay, measure }).meta.days.flatMap((d) => d.blocks)
  .find((k) => k.label === 'Learner Bravo')
check('18 hours shown: a 45-minute class still shows name and whole time', [tight.lines, tight.time], [['Learner Bravo'], '12:00 - 12:45'])

// A week with no exams and no untimed classes gives those rows' room to the timeline.
const bare = { ...model, days: model.days.map((d) => ({ ...d, exams: [], untimed: [] })) }
const withRows = buildWallpaper({ size: { w: 1920, h: 1080 }, model, measure }).meta
const without = buildWallpaper({ size: { w: 1920, h: 1080 }, model: bare, measure }).meta
check('no exam or no-time rows: the timeline is taller', without.bodyH > withRows.bodyH, true)

console.log(`\nverify-wallpaper: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
