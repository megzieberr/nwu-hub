// "Own ticks": whose done-state a screen shows. The pure decisions behind the module page's
// Assessments list, its This Week card and the dashboard's My Week card.
//
// assessments.status sits on the shared row, so it is the OWNER's state. The owner keeps using it,
// exactly as before. The viewer never sees it: her done-state is her own my_done rows (0024), passed
// in here as `doneIds`, a Set of assessment ids she has ticked.
//
// Lives in src/lib (not App.jsx) so sync/verify-done.mjs can test the code that ships; Node cannot
// import .jsx. Same arrangement as week.js and quests.js.
import { myWeek, weekAhead } from './week.js' // extension required: Node resolves ESM strictly

// The viewer's own state, in the same field name the rest of the app reads. 'done' is never one of
// the owner's values, so nothing downstream can mistake it for her 'submitted' or 'graded'.
export const VIEWER_DONE = 'done'

function has(doneIds, id) {
  return !!doneIds && typeof doneIds.has === 'function' && doneIds.has(id)
}

// Is this assessment ticked off, for the person looking at it?
//   owner:  anything but 'upcoming' counts as done (unchanged from before own ticks).
//   viewer: only her own my_done row counts. The owner's status is ignored completely.
export function isDoneFor(a, { isViewer = false, doneIds } = {}) {
  if (!a) return false
  if (!isViewer) return a.status !== 'upcoming'
  return has(doneIds, a.id)
}

// The rows as this person should see them. For the owner this is the SAME array, untouched, so
// every caller behaves exactly as it did before. For the viewer, each row's `status` is replaced
// with her own state ('done' or 'upcoming'), so weekAhead and myWeek, which filter on status, drop
// what SHE ticked and nothing else.
export function seenBy(rows, { isViewer = false, doneIds } = {}) {
  if (!isViewer) return rows
  return (rows || []).map((a) => (a ? { ...a, status: has(doneIds, a.id) ? VIEWER_DONE : 'upcoming' } : a))
}

// Dashboard My Week rows. The owner's fetch still asks for status = 'upcoming' only; the viewer's
// fetch has no status filter, so her rows come in with whatever the owner set and seenBy swaps it
// for her own state. The past is bounded by myWeek itself: a missed deadline shows as overdue for
// QUEST_OVERDUE_GRACE_DAYS and then drops off, and undated rows never show on this card. That is
// the same window the owner has, so no extra date filter is added here.
export function visibleDeadlinesFor(rows, { isViewer = false, doneIds, today } = {}) {
  return myWeek(seenBy(rows, { isViewer, doneIds }), today)
}

// Module page This Week card, same rule.
export function weekAheadFor(rows, { isViewer = false, doneIds, today } = {}) {
  return weekAhead(seenBy(rows, { isViewer, doneIds }), today)
}
