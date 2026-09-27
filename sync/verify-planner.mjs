// Regression net for src/lib/planner.js — the Week tab's date/time/block logic.
// Run: node sync/verify-planner.mjs   (exit 0 = all green)
// Fixtures are name-free on purpose (public repo): labels like "block A", "MOD101".
import {
  localDateStr, parseLocalDate, addDays, mondayOf, weekDates,
  timeToMin, minToTime, snap15, overlaps, gridRows, freeGaps,
  dueByDay, expandRepeat, swapBlocks, copyWeek, classMarkersForWeek,
  rowInHour, hourBoxes, isWholeHours, isHardDeadline,
} from '../src/lib/planner.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

// ---- local date maths ----
// The 00:00-02:00 SAST case: a UTC-based helper would read this as the previous day. This is the
// bug the whole file exists to avoid, so it gets checked first.
check('localDateStr: 00:30 local stays on its own day', localDateStr(new Date(2026, 8, 28, 0, 30)), '2026-09-28')
check('localDateStr: 23:59 local stays on its own day', localDateStr(new Date(2026, 8, 28, 23, 59)), '2026-09-28')
check('parseLocalDate/localDateStr round trip', localDateStr(parseLocalDate('2026-09-28')), '2026-09-28')

check('addDays: across a 30-day month end', addDays('2026-09-30', 1), '2026-10-01')
check('addDays: across a year end', addDays('2026-12-31', 1), '2027-01-01')
check('addDays: negative n across a month start', addDays('2026-10-01', -1), '2026-09-30')
check('addDays: negative n across a year start', addDays('2027-01-01', -1), '2026-12-31')

check('mondayOf: a Monday maps to itself', mondayOf('2026-09-28'), '2026-09-28')
check('mondayOf: a Wednesday maps back to its Monday', mondayOf('2026-09-30'), '2026-09-28')
// Her spec example: Sunday 4 Oct 2026 belongs to the week that started Monday 28 Sep.
check('mondayOf: a Sunday belongs to the week that STARTED the Monday before it', mondayOf('2026-10-04'), '2026-09-28')

const wd = weekDates('2026-09-28')
check('weekDates: 7 entries', wd.length, 7)
check('weekDates: starts Monday, ends Sunday', [wd[0], wd[6]], ['2026-09-28', '2026-10-04'])

// ---- time maths ----
check('timeToMin: HH:MM', timeToMin('16:15'), 975)
check('timeToMin: HH:MM:SS', timeToMin('16:15:00'), 975)
check('timeToMin: 24:00 is valid (end of day)', timeToMin('24:00'), 1440)
check('minToTime: 975 -> 16:15', minToTime(975), '16:15')
check('minToTime: 1440 -> 24:00', minToTime(1440), '24:00')
check('time round trip', minToTime(timeToMin('09:05')), '09:05')
check('snap15: rounds down to nearest 15', snap15(7), 0)
check('snap15: rounds up to nearest 15', snap15(8), 15)
check('snap15: already on a 15 boundary stays put', snap15(990), 990)

// ---- overlaps ----
const blockA = { block_date: '2026-09-28', start_time: '10:00', end_time: '11:00' }
const blockB = { block_date: '2026-09-28', start_time: '10:30', end_time: '11:30' }
const blockTouch = { block_date: '2026-09-28', start_time: '11:00', end_time: '12:00' }
const blockOtherDay = { block_date: '2026-09-29', start_time: '10:00', end_time: '11:00' }
check('overlaps: genuinely overlapping same-day blocks', overlaps(blockA, blockB), true)
check('overlaps: touching ends is NOT an overlap', overlaps(blockA, blockTouch), false)
check('overlaps: same times, different dates', overlaps(blockA, blockOtherDay), false)

// ---- gridRows ----
const dayStart = timeToMin('10:00') // 600
const dayEnd = timeToMin('22:00')   // 1320
check('gridRows: 16:15-17:00 block, day start 10:00', gridRows({ start_time: '16:15', end_time: '17:00' }, dayStart, dayEnd), { rowStart: 26, rowEnd: 29 })
check('gridRows: clamped at the top of the visible range', gridRows({ start_time: '09:00', end_time: '10:30' }, dayStart, dayEnd), { rowStart: 1, rowEnd: 3 })
check('gridRows: clamped at the bottom of the visible range', gridRows({ start_time: '21:30', end_time: '23:00' }, dayStart, dayEnd), { rowStart: 47, rowEnd: 49 })
check('gridRows: fully outside the visible hours gives null', gridRows({ start_time: '07:00', end_time: '08:00' }, dayStart, dayEnd), null)
check('gridRows: touching the top edge exactly gives null', gridRows({ start_time: '09:00', end_time: '10:00' }, dayStart, dayEnd), null)

// ---- hour boxes: which rows sit in which hour box ----
const odd = { id: 'r1', label: 'locked class', start_time: '16:15:00', end_time: '17:00:00' }
const twoHour = { id: 'r2', label: 'block A', start_time: '10:00', end_time: '12:00' }
const oneHour = { id: 'r3', label: 'block B', start_time: '14:00', end_time: '15:00' }
const halfPast = { id: 'r4', label: 'block C', start_time: '14:30', end_time: '15:30' }
check('rowInHour: 16:15-17:00 sits in the 16:00 box', rowInHour(odd, 16), true)
check('rowInHour: 16:15-17:00 is NOT in the 17:00 box (ends exactly on the hour)', rowInHour(odd, 17), false)
check('rowInHour: 16:15-17:00 is NOT in the 15:00 box', rowInHour(odd, 15), false)
check('rowInHour: a row starting at 17:00 is NOT in the 16:00 box', rowInHour({ start_time: '17:00', end_time: '18:00' }, 16), false)
check('rowInHour: 24:00 end sits in the 23:00 box', rowInHour({ start_time: '23:00', end_time: '24:00' }, 23), true)
const boxes = hourBoxes([halfPast, odd, twoHour, oneHour], 6, 22)
check('hourBoxes: 16 boxes for 06:00 to 22:00', Object.keys(boxes).length, 16)
check('hourBoxes: empty box is an empty list', boxes[6], [])
check('hourBoxes: a 2-hour block fills both of its boxes', [boxes[10].map((r) => r.id), boxes[11].map((r) => r.id)], [['r2'], ['r2']])
check('hourBoxes: a block ending exactly on 12:00 is not in the 12:00 box', boxes[12], [])
check('hourBoxes: two rows in one box, both kept, in start order', boxes[14].map((r) => r.id), ['r3', 'r4'])
check('hourBoxes: the half-past row also sits in the next box', boxes[15].map((r) => r.id), ['r4'])
check('hourBoxes: 16:15-17:00 in the 16:00 box only', [boxes[16].map((r) => r.id), boxes[17]], [['r1'], []])
check('hourBoxes: rows outside the visible hours are left out', hourBoxes([{ id: 'x', start_time: '05:00', end_time: '06:00' }], 6, 22)[6], [])
check('hourBoxes: same start, shorter first, then label', hourBoxes([
  { id: 'b', label: 'Z', start_time: '09:00', end_time: '10:00' },
  { id: 'a', label: 'A', start_time: '09:00', end_time: '10:00' },
  { id: 'c', label: 'M', start_time: '09:00', end_time: '09:30' },
], 9, 10)[9].map((r) => r.id), ['c', 'a', 'b'])
check('isWholeHours: 10:00-12:00', isWholeHours(twoHour), true)
check('isWholeHours: 16:15-17:00', isWholeHours(odd), false)
check('isHardDeadline: ww:own: row', isHardDeadline({ source: 'whenworks', source_key: 'ww:own:2026-10-01:t1' }), true)
check('isHardDeadline: a class row from the scheduler is not', isHardDeadline({ source: 'whenworks', source_key: 'ww:x:2026-10-01' }), false)
check('isHardDeadline: her own block is not', isHardDeadline({ source: null, source_key: null }), false)

// ---- freeGaps ----
check('freeGaps: empty day gives one gap for the whole visible range', freeGaps([], dayStart, dayEnd), [{ start: 600, end: 1320 }])
check('freeGaps: overlapping blocks merge into one busy interval', freeGaps([
  { start_time: '10:00', end_time: '11:00' },
  { start_time: '10:30', end_time: '11:30' },
], dayStart, dayEnd), [{ start: 690, end: 1320 }])
check('freeGaps: a gap under 15 minutes is dropped', freeGaps([
  { start_time: '10:00', end_time: '11:00' },
  { start_time: '11:10', end_time: '11:40' }, // 10-minute gap before this — too short to offer
], dayStart, dayEnd), [{ start: 700, end: 1320 }])
check('freeGaps: a block ending at the day end leaves no trailing gap', freeGaps([
  { start_time: '21:40', end_time: '22:00' },
], dayStart, dayEnd), [{ start: 600, end: 1300 }])

// ---- dueByDay ----
const dates3 = ['2026-09-28', '2026-09-29', '2026-09-30']
const due = dueByDay([
  { title: 'MOD101 Test', due_date: '2026-09-29' },
  { title: 'MOD101 Assignment', due_date: '2026-09-29' },
], dates3)
check('dueByDay: two items on one day sorted by title', due['2026-09-29'].map((a) => a.title), ['MOD101 Assignment', 'MOD101 Test'])
check('dueByDay: empty days present', [due['2026-09-28'], due['2026-09-30']], [[], []])

// ---- expandRepeat ----
const repBlock = { block_date: '2026-09-28', start_time: '16:15', end_time: '17:00', module_id: null, kind: 'study', label: 'block A' }
const rep = expandRepeat(repBlock, '2026-10-19', [], 'series-1')
check('expandRepeat: correct count', rep.length, 3)
check('expandRepeat: correct dates', rep.map((r) => r.block_date), ['2026-10-05', '2026-10-12', '2026-10-19'])
check('expandRepeat: rows carry series_id, done:false, no source', [rep[0].series_id, rep[0].done, rep[0].source, rep[0].source_key], ['series-1', false, null, null])
check('expandRepeat: original block itself is not in the result', rep.some((r) => r.block_date === '2026-09-28'), false)

const takenWeek = [{ block_date: '2026-10-12', start_time: '16:00', end_time: '17:30', source: null }]
const repSkip = expandRepeat(repBlock, '2026-10-19', takenWeek, 'series-2')
check('expandRepeat: a taken week (source null, overlapping) is skipped', repSkip.map((r) => r.block_date), ['2026-10-05', '2026-10-19'])

const repCap = expandRepeat(repBlock, '2028-01-01', [], 'series-3', 4)
check('expandRepeat: maxWeeks caps the number of rows', repCap.length, 4)

const wwTaken = [{ block_date: '2026-10-12', start_time: '16:00', end_time: '17:30', source: 'whenworks', source_key: 'ww:x:2026-10-12' }]
const repWw = expandRepeat(repBlock, '2026-10-19', wwTaken, 'series-4')
check('expandRepeat: a source=whenworks row does NOT cause a skip', repWw.map((r) => r.block_date), ['2026-10-05', '2026-10-12', '2026-10-19'])

// ---- swapBlocks ----
const swapA = { id: 'ida', block_date: '2026-09-28', start_time: '10:00', end_time: '11:00', label: 'block A', kind: 'study' }
const swapB = { id: 'idb', block_date: '2026-09-29', start_time: '14:00', end_time: '15:00', label: 'block B', kind: 'break' }
const swapAcopy = { ...swapA }
const swapBcopy = { ...swapB }
const [swappedA, swappedB] = swapBlocks(swapA, swapB)
check('swapBlocks: dates and times exchanged', [swappedA.block_date, swappedA.start_time, swappedA.end_time], ['2026-09-29', '14:00', '15:00'])
check('swapBlocks: the other side too', [swappedB.block_date, swappedB.start_time, swappedB.end_time], ['2026-09-28', '10:00', '11:00'])
check('swapBlocks: ids and labels kept', [swappedA.id, swappedA.label, swappedB.id, swappedB.label], ['ida', 'block A', 'idb', 'block B'])
check('swapBlocks: inputs are not mutated', [swapA, swapB], [swapAcopy, swapBcopy])

// ---- copyWeek ----
const weekBlocks = [
  { block_date: '2026-09-28', start_time: '16:00', end_time: '17:00', label: 'block A', kind: 'study', done: true, source: null },
  { block_date: '2026-09-30', start_time: '09:00', end_time: '10:00', label: 'ww class', kind: 'class', done: false, source: 'whenworks', source_key: 'ww:x:2026-09-30' },
  { block_date: '2026-10-01', start_time: '11:00', end_time: '12:00', label: 'block C', kind: 'study', done: false, source: null },
]
const copied = copyWeek(weekBlocks, '2026-10-05', [])
check('copyWeek: only hand-made rows copied (whenworks row skipped)', copied.map((r) => r.label), ['block A', 'block C'])
check('copyWeek: moved to the same weekday/time in the target week', copied.map((r) => r.block_date), ['2026-10-05', '2026-10-08'])
check('copyWeek: done reset to false', copied.every((r) => r.done === false), true)

const targetTaken = [{ block_date: '2026-10-05', start_time: '16:00', end_time: '17:00' }]
const copiedSkip = copyWeek(weekBlocks, '2026-10-05', targetTaken)
check('copyWeek: a slot already taken in the target week is skipped', copiedSkip.map((r) => r.label), ['block C'])

// ---- classMarkersForWeek ----
const weekOct5 = weekDates('2026-10-05') // Mon 5 Oct .. Sun 11 Oct
const goals = [
  // recurring, anchored on some past Wednesday — must land on THIS week's Wednesday (7 Oct)
  { id: 'g1', kind: 'class', recurring: true, target_date: '2026-08-05', target_time: '14:00', title: 'MOD101' },
  // one-off, dated inside this week only
  { id: 'g2', kind: 'class', recurring: false, target_date: '2026-10-06', target_time: '09:00', title: 'MOD102' },
  // one-off, dated in a DIFFERENT week — must not appear here
  { id: 'g3', kind: 'class', recurring: false, target_date: '2026-10-13', target_time: '09:00', title: 'MOD103' },
  // recurring, no target_time at all
  { id: 'g4', kind: 'class', recurring: true, target_date: '2026-08-04', target_time: null, title: 'MOD104' },
  { id: 'g5', kind: 'task', recurring: false, target_date: '2026-10-06', title: 'not a class' },
]
const markers = classMarkersForWeek(goals, weekOct5)
check('classMarkersForWeek: recurring class lands on its weekday this week', markers.find((m) => m.goal.id === 'g1')?.date, '2026-10-07')
check('classMarkersForWeek: one-off shows on its own date', markers.find((m) => m.goal.id === 'g2')?.date, '2026-10-06')
check('classMarkersForWeek: one-off in a different week is absent', markers.some((m) => m.goal.id === 'g3'), false)
check('classMarkersForWeek: untimed class is flagged, times null', [markers.find((m) => m.goal.id === 'g4')?.untimed, markers.find((m) => m.goal.id === 'g4')?.start], [true, null])
check('classMarkersForWeek: end is start+60', markers.find((m) => m.goal.id === 'g2')?.end, 600)
check('classMarkersForWeek: non-class goals are ignored', markers.some((m) => m.goal.id === 'g5'), false)

// A one-off dated in the OTHER week must show when that week is the one asked for.
const weekOct12 = weekDates('2026-10-12')
const markersNextWeek = classMarkersForWeek(goals, weekOct12)
check('classMarkersForWeek: the one-off from g3 appears in ITS OWN week', markersNextWeek.find((m) => m.goal.id === 'g3')?.date, '2026-10-13')
check('classMarkersForWeek: the recurring class also lands on Wednesday next week', markersNextWeek.find((m) => m.goal.id === 'g1')?.date, '2026-10-14')

console.log(`${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
