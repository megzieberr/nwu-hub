// "This week" cards — the pure date decisions behind the dashboard's My Week card and each
// module page's week card (Megan's ask, s19: "I just want to know what I should be doing each
// week"). Same arrangement as quests.js: Node cannot import .jsx, so anything that needs a
// regression net (sync/verify-week.mjs) lives here, with `today` injectable so tests never rot.
import { daysUntil, QUEST_OVERDUE_GRACE_DAYS } from './quests.js' // extension required: Node (the test runner) resolves ESM strictly

export const WEEK_AHEAD_DAYS = 7

// Module page: what's due in the next 7 days (soonest first) — and when that's empty, the single
// next dated deadline beyond the week, so the card can say "nothing this week; next up …" instead
// of going blank. Overdue items are the Quest Log's job, not this card's — days < 0 is dropped.
export function weekAhead(assessments, today = new Date().toISOString().slice(0, 10)) {
  const dated = (assessments || [])
    .filter((a) => a && a.due_date && a.status === 'upcoming')
    .map((a) => ({ ...a, days: daysUntil(a.due_date, today) }))
    .filter((a) => a.days !== null && a.days >= 0)
    .sort((x, y) => x.days - y.days)
  return {
    thisWeek: dated.filter((a) => a.days <= WEEK_AHEAD_DAYS),
    next: dated.find((a) => a.days > WEEK_AHEAD_DAYS) || null,
  }
}

// Dashboard: at most ONE upcoming line per module — its next dated deadline — soonest first.
// A module with nothing coming stays off the list entirely. That's the whole difference from the
// retired Quest Log: the log was a window over every deadline; this is a glance, capped per module,
// so it can never grow past the number of modules. Rows carry the dashboard fetch's modules{} join.
//
// Since s19 retired the Quest Log, My Week also inherits its OTHER end (the s18 decision: a window
// needs both ends when nothing ever closes an item): a module's most recently MISSED deadline stays
// visible as a red `overdue` row for QUEST_OVERDUE_GRACE_DAYS, then ages out on its own. Without
// this, a deadline she missed would vanish at midnight — the exact failure s18 was built to stop.
export function myWeek(deadlines, today = new Date().toISOString().slice(0, 10)) {
  const upcoming = new Map()   // module → the rows sharing its SOONEST upcoming day
  const missed = new Map()     // module → the rows sharing its most recent missed day
  for (const d of deadlines || []) {
    if (!d || !d.due_date) continue
    // A ticked-off deadline leaves the card (s22 — the ✓ writes status='submitted'). The dashboard
    // query already asks only for 'upcoming', so this is the belt to that braces: "ticked = gone"
    // is now true of the decision itself, not just of one caller's .eq() filter. A row with NO
    // status at all still counts — the test fixtures and the pre-s22 callers never set one.
    if (d.status && d.status !== 'upcoming') continue
    const days = daysUntil(d.due_date, today)
    if (days === null) continue
    const key = d.modules?.code || d.module_id
    if (days >= 0) {
      const g = upcoming.get(key)
      if (!g || days < g[0].days) upcoming.set(key, [{ ...d, days }])
      else if (days === g[0].days) g.push({ ...d, days })
    } else if (days >= -QUEST_OVERDUE_GRACE_DAYS) {
      const g = missed.get(key)
      if (!g || days > g[0].days) missed.set(key, [{ ...d, days }])  // most recently missed
      else if (days === g[0].days) g.push({ ...d, days })
    }
  }
  return [
    ...[...missed.values()].map((g) => ({ ...collapse(g), overdue: true, thisWeek: false })),
    ...[...upcoming.values()].map((g) => {
      const r = collapse(g)
      return { ...r, overdue: false, thisWeek: r.days <= WEEK_AHEAD_DAYS }
    }),
  ].sort((a, b) => a.days - b.days ||
    String(a.modules?.code || '').localeCompare(String(b.modules?.code || '')))
}

// Several deadlines can land on ONE day — EDCC125's four tests all close 7 October. My Week has
// room for a single line per module, and it used to keep whichever of them the fetch happened to
// return first: Megan's 2026-08-24 dashboard read "Test 3" when Test 1, 2 and 4 were equally due,
// and a later load could just as well have said "Test 1". Two fixes in one place — sort by title
// so the line's identity is STABLE across loads, and carry `alsoDue` so the row can own up to the
// others instead of silently hiding three of them.
function collapse(group) {
  const sorted = group.slice().sort((a, b) =>
    String(a.title || '').localeCompare(String(b.title || '')))
  return { ...sorted[0], alsoDue: sorted.length - 1 }
}

// 'today' / 'tomorrow' / 'in N days' — the calm relative label next to a date.
export function dueLabel(days) {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${days} days`
}

// 'Sun 23 Aug' — hand-rolled (no toLocaleDateString) so it can't wobble with ICU/locale data
// between the browser and the Node test run. Anchored to noon UTC like daysUntil.
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function formatDue(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00Z')
  if (isNaN(d.getTime())) return String(dateStr)
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`
}
