// Quest Log windowing — the pure date decisions behind the dashboard's "Quest Log · Upcoming".
//
// Lives in its own module (not inline in App.jsx) so sync/verify-quest-window.mjs can import and
// test the exact code that ships — the same arrangement as supabase/functions/send-push/
// reminders.mjs. Node cannot import .jsx, so anything that needs a regression net belongs here.

// Whole days from `today` to a 'YYYY-MM-DD' date (negative = already past, 0 = today). Both sides
// are anchored to noon UTC so the result is a calendar-day count, never an instant difference: a
// deadline dated today must read as 0 all day in SAST, not flip to -1 once the clock passes 02:00.
// `today` is injectable so the tests never rot.
export function daysUntil(dateStr, today = new Date().toISOString().slice(0, 10)) {
  const target = new Date(String(dateStr).slice(0, 10) + 'T12:00:00Z').getTime()
  if (isNaN(target)) return null
  const base = new Date(String(today).slice(0, 10) + 'T12:00:00Z').getTime()
  if (isNaN(base)) return null
  return Math.round((target - base) / 86400000)
}

// Dashboard-only window so the Quest Log reads as "what's actually coming up", not the whole
// semester's dread. The full list (incl. date-TBC ones) still lives on each module's Assessments
// page — this just trims the emotional load of the home screen.
//
// The window has BOTH ends on purpose. It originally had only an upper bound ("due within 21
// days"), and nothing in the app ever flips an assessment off status='upcoming' — so every
// deadline ever seeded stayed on the dashboard forever. By 2026-08-12 the log led with a 24 July
// test and a 26 July assessment, burying the real next one. A just-missed deadline still deserves
// to be seen, so the recent past stays a few days flagged `overdue`, then ages out on its own.
export const QUEST_AHEAD_DAYS = 21
export const QUEST_OVERDUE_GRACE_DAYS = 4

// Returns the rows to show, soonest first, each tagged with `overdue`.
export function questWindow(deadlines, today = new Date().toISOString().slice(0, 10)) {
  return (deadlines || [])
    .map((d) => {
      if (!d || !d.due_date) return null
      const days = daysUntil(d.due_date, today)
      if (days === null) return null
      if (days > QUEST_AHEAD_DAYS || days < -QUEST_OVERDUE_GRACE_DAYS) return null
      return { ...d, overdue: days < 0 }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
}
