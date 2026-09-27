// Pure date/time/block logic behind the hub's Week tab (plan_blocks). No Supabase, no DOM, no
// window/localStorage — every function that needs "today" or "now" takes it as a parameter, so
// sync/verify-planner.mjs can run this under plain Node with no live day involved.
//
// Local dates only. NEVER toISOString() a date here: it reads UTC, which gives the wrong day
// between 00:00 and 02:00 in South Africa (UTC+2) — the exact bug App.jsx:280/1790 still carries
// for the Classes window (do not copy it). A "date" is always a 'YYYY-MM-DD' string built from a
// Date's LOCAL getters. Times are 'HH:MM' or 'HH:MM:SS' as Postgres returns them; '24:00' is a
// valid Postgres time meaning midnight at the end of the day.
//
// A block is a plain object shaped like a plan_blocks row:
//   { id, block_date, start_time, end_time, module_id, kind, label, done, series_id, source, source_key }

// ---------- local dates ----------

export function localDateStr(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function parseLocalDate(str) {
  const [y, m, d] = String(str).split('-').map(Number)
  return new Date(y, m - 1, d)
}

// Correct across month ends, year ends and negative n: JS normalises an out-of-range day-of-month
// on a LOCAL Date, so this never needs its own carry logic.
export function addDays(dateStr, n) {
  const d = parseLocalDate(dateStr)
  d.setDate(d.getDate() + n)
  return localDateStr(d)
}

// 0 = Monday … 6 = Sunday (the same numbering App.jsx:84-86 uses, just off a local Date instead
// of a UTC-noon anchor). Not exported: callers only need mondayOf/weekDates/classMarkersForWeek.
function weekdayMon0(dateStr) {
  return (parseLocalDate(dateStr).getDay() + 6) % 7
}

// A Sunday belongs to the week that STARTED the Monday before it, so it maps 6 days back, not
// forward to the next Monday.
export function mondayOf(dateStr) {
  return addDays(dateStr, -weekdayMon0(dateStr))
}

export function weekDates(mondayStr) {
  const out = []
  for (let i = 0; i < 7; i++) out.push(addDays(mondayStr, i))
  return out
}

// ---------- times ----------

export function timeToMin(t) {
  const [h, m] = String(t).split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

export function minToTime(m) {
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

export function snap15(m) {
  return Math.round(m / 15) * 15
}

// Same block_date and the time ranges actually overlap — touching ends (one 12:00, next 12:00)
// is NOT an overlap, so this is strict '<' both ways, never '<='.
export function overlaps(a, b) {
  if (a.block_date !== b.block_date) return false
  const aStart = timeToMin(a.start_time)
  const aEnd = timeToMin(a.end_time)
  const bStart = timeToMin(b.start_time)
  const bEnd = timeToMin(b.end_time)
  return aStart < bEnd && bStart < aEnd
}

// ---------- grid placement ----------

// 1-based CSS grid lines for a 15-minute-row grid where line 1 sits at dayStartMin. A block that
// sticks out of the visible hours is clamped to them; a block entirely outside gives null so the
// caller can skip rendering it rather than draw a zero/negative-height row.
export function gridRows(block, dayStartMin, dayEndMin) {
  const start = timeToMin(block.start_time)
  const end = timeToMin(block.end_time)
  if (end <= dayStartMin || start >= dayEndMin) return null
  const clampedStart = Math.max(start, dayStartMin)
  const clampedEnd = Math.min(end, dayEndMin)
  return {
    rowStart: Math.round((clampedStart - dayStartMin) / 15) + 1,
    rowEnd: Math.round((clampedEnd - dayStartMin) / 15) + 1,
  }
}

// Free gaps for ONE day's blocks (they may overlap each other), inside the visible hours, in time
// order. Gaps under 15 minutes are left out — too short to offer as a "+ free" slot.
export function freeGaps(blocks, dayStartMin, dayEndMin) {
  const intervals = (blocks || [])
    .map((b) => [Math.max(timeToMin(b.start_time), dayStartMin), Math.min(timeToMin(b.end_time), dayEndMin)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0])

  const merged = []
  for (const [s, e] of intervals) {
    const last = merged[merged.length - 1]
    if (last && s <= last[1]) last[1] = Math.max(last[1], e)
    else merged.push([s, e])
  }

  const gaps = []
  let cursor = dayStartMin
  for (const [s, e] of merged) {
    if (s - cursor >= 15) gaps.push({ start: cursor, end: s })
    cursor = Math.max(cursor, e)
  }
  if (dayEndMin - cursor >= 15) gaps.push({ start: cursor, end: dayEndMin })
  return gaps
}

// ---------- deadlines strip ----------

// Groups assessments (rows with due_date/title) by each date in `dates`. Days with nothing get an
// empty array — the caller renders one cell per day regardless. Stable, plain title compare, same
// idea as week.js's collapse(): identity must not depend on fetch order.
export function dueByDay(assessments, dates) {
  const out = {}
  for (const d of dates) out[d] = []
  for (const a of assessments || []) {
    if (a && a.due_date && Object.prototype.hasOwnProperty.call(out, a.due_date)) {
      out[a.due_date].push(a)
    }
  }
  for (const d of dates) {
    out[d].sort((x, y) => String(x.title || '').localeCompare(String(y.title || '')))
  }
  return out
}

// ---------- repeat weekly ----------

// New rows (without id) for the weeks AFTER block.block_date, one per week at the same times, up
// to and including untilDateStr, at most maxWeeks rows RETURNED (a skipped week does not use up
// the cap — it just isn't in the result). Skips any week where an existingBlocks row she made
// herself (source == null) already overlaps that slot on that date; a source='whenworks' row
// never blocks a repeat. Every returned row carries series_id, done:false, source/source_key null.
export function expandRepeat(block, untilDateStr, existingBlocks, seriesId, maxWeeks = 26) {
  const rows = []
  let date = addDays(block.block_date, 7)
  while (date <= untilDateStr && rows.length < maxWeeks) {
    const candidate = {
      block_date: date,
      start_time: block.start_time,
      end_time: block.end_time,
      module_id: block.module_id,
      kind: block.kind,
      label: block.label,
      done: false,
      series_id: seriesId,
      source: null,
      source_key: null,
    }
    const taken = (existingBlocks || []).some((eb) => eb.source == null && overlaps(eb, candidate))
    if (!taken) rows.push(candidate)
    date = addDays(date, 7)
  }
  return rows
}

// ---------- move / swap / copy ----------

// Two copies with block_date/start_time/end_time exchanged; everything else (label, module_id,
// id, kind, done, ...) stays as it was on that row. Inputs are never mutated.
export function swapBlocks(a, b) {
  const a2 = { ...a, block_date: b.block_date, start_time: b.start_time, end_time: b.end_time }
  const b2 = { ...b, block_date: a.block_date, start_time: a.start_time, end_time: a.end_time }
  return [a2, b2]
}

// New rows (without id) moving one week's hand-made blocks (source == null — a WhenWorks row is
// never copied, it gets re-synced instead) onto the same weekday/time in targetMondayStr's week.
// A row that would overlap something already in targetWeekBlocks is skipped rather than stacked.
export function copyWeek(blocks, targetMondayStr, targetWeekBlocks) {
  const rows = []
  for (const b of blocks || []) {
    if (b.source != null) continue
    const offset = weekdayMon0(b.block_date)
    const candidate = {
      block_date: addDays(targetMondayStr, offset),
      start_time: b.start_time,
      end_time: b.end_time,
      module_id: b.module_id,
      kind: b.kind,
      label: b.label,
      done: false,
      series_id: null,
      source: null,
      source_key: null,
    }
    const taken = (targetWeekBlocks || []).some((tb) => overlaps(tb, candidate))
    if (!taken) rows.push(candidate)
  }
  return rows
}

// ---------- NWU class markers ----------

// Same recurring/one-off rule as App.jsx:280-294, re-implemented on local dates: a one-off class
// (recurring=false) shows only in the week its own target_date falls in; a recurring class always
// shows, placed on its weekday for the given week. `dates` is one week, Monday..Sunday (weekDates
// output). end is always start+60; a goal with no target_time comes back untimed with null times.
export function classMarkersForWeek(goals, dates) {
  const weekStart = dates[0]
  const weekEnd = dates[dates.length - 1]
  const out = []
  for (const g of goals || []) {
    if (!g || g.kind !== 'class') continue
    const showDate = g.recurring && g.target_date
      ? addDays(weekStart, weekdayMon0(g.target_date))
      : g.target_date
    const inWeek = g.recurring || (showDate && showDate >= weekStart && showDate <= weekEnd)
    if (!inWeek) continue
    if (!g.target_time) {
      out.push({ goal: g, date: showDate, start: null, end: null, untimed: true })
    } else {
      const start = timeToMin(g.target_time)
      out.push({ goal: g, date: showDate, start, end: start + 60, untimed: false })
    }
  }
  return out
}
