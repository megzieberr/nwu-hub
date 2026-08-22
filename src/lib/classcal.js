// classcal.js — helpers for the per-class 📅 "add to Google Calendar" button (ClassRow, App.jsx).
//
// Deliberately reimplements the tiny summary-stripping rule from
// supabase/functions/ics-feed/ics.mjs (summaryFor) rather than importing it — that file is a Deno
// edge function under supabase/functions and isn't reachable from the Vite build. Keep the two in
// sync by hand if either changes (see PLAN-calendar-feed.md §3).

const HUB_URL = 'https://megzieberr.github.io/nwu-hub/'

function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// "CODE: rest — tail" -> "CODE · rest" (same rule as ics.mjs summaryFor: strip a leading
// "CODE:"/"CODE " prefix and a trailing " — …" tail that the objectives agent bakes into `text`).
export function summaryFor(text, code) {
  let rest = text || ''
  if (code) {
    rest = rest.replace(new RegExp(`^${escapeRegExp(code)}[:]?\\s*`), '')
  }
  rest = rest.replace(/\s*—.*$/, '').trim()
  return `${code ? code + ' · ' : ''}${rest || 'class'}`
}

function pad2(n) { return String(n).padStart(2, '0') }

// 'YYYY-MM-DD' -> 'YYYYMMDD'
function compactDate(dateStr) { return String(dateStr).replace(/-/g, '') }

// +1 calendar day on a 'YYYY-MM-DD' string. Noon-UTC anchored so the shift never crosses a date
// boundary early/late (same trick as App.jsx's own addDays / ics.mjs's nextDay).
function nextDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

// 'HH:MM' | 'HH:MM:SS' -> 'HHMMSS'
function compactTime(timeStr) {
  const m = String(timeStr).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return '000000'
  return `${m[1]}${m[2]}${m[3] ?? '00'}`
}

// Same, with the hour advanced by one (wraps 23 -> 00; classes never run long enough to reach
// midnight in practice, so no day-rollover is attempted).
function compactTimePlusHour(timeStr) {
  const m = String(timeStr).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/)
  if (!m) return '000000'
  const h = pad2((Number(m[1]) + 1) % 24)
  return `${h}${m[2]}${m[3] ?? '00'}`
}

// Google Calendar "add event" template URL for one class row. `g` is a class from Dashboard's
// `classes` array — carries text, target_date, target_time, recurring, link, showDate (this
// week's occurrence for a recurring class), and modules.code. Uses showDate (falling back to
// target_date) so the button always adds THIS occurrence, not the originally-stored one.
export function googleAddEventUrl(g) {
  const code = g.modules?.code || ''
  const text = summaryFor(g.text, code)
  const date = g.showDate || g.target_date

  const dates = g.target_time
    ? `${compactDate(date)}T${compactTime(g.target_time)}/${compactDate(date)}T${compactTimePlusHour(g.target_time)}`
    : `${compactDate(date)}/${compactDate(nextDay(date))}`

  const detailsParts = []
  if (g.link) detailsParts.push(`Join: ${g.link}`)
  detailsParts.push(`Hub: ${HUB_URL}`)

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text,
    dates,
    details: detailsParts.join('\n'),
    location: 'Online (Teams)',
    ctz: 'Africa/Johannesburg',
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}
