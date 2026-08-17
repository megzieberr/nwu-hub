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
  const upcoming = new Map()
  const missed = new Map()
  for (const d of deadlines || []) {
    if (!d || !d.due_date) continue
    const days = daysUntil(d.due_date, today)
    if (days === null) continue
    const key = d.modules?.code || d.module_id
    if (days >= 0) {
      const prev = upcoming.get(key)
      if (!prev || days < prev.days) upcoming.set(key, { ...d, days })
    } else if (days >= -QUEST_OVERDUE_GRACE_DAYS) {
      const prev = missed.get(key)
      if (!prev || days > prev.days) missed.set(key, { ...d, days }) // most recently missed
    }
  }
  return [
    ...[...missed.values()].map((d) => ({ ...d, overdue: true, thisWeek: false })),
    ...[...upcoming.values()].map((d) => ({ ...d, overdue: false, thisWeek: d.days <= WEEK_AHEAD_DAYS })),
  ].sort((a, b) => a.days - b.days ||
    String(a.modules?.code || '').localeCompare(String(b.modules?.code || '')))
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
