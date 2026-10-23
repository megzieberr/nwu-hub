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

// "We didn't write it" (s50, her ask 2026-10-23). An extended or second opportunity is optional:
// skipping it must take it off the list without pretending it was handed in, and without the red
// OVERDUE line. The skip button only shows on rows whose title says so. The opportunity pattern is
// anchored at the START of the title on purpose: the EDCC125 exam row mentions "Opp 2 = closed
// book" in its middle, and that row is the first opportunity, not one to skip.
const SKIPPABLE = [
  /\bextended\b/i,
  /\b(2nd|second)\s+opp(ortunity)?\b/i,
  /^\s*opp(ortunity)?\.?\s*2\b/i,
  /\btweede\s+geleentheid\b/i,
]
export function canSkip(a) {
  return !!a && typeof a.title === 'string' && SKIPPABLE.some((re) => re.test(a.title))
}

// Is this row skipped, for the person looking at it?
//   owner:  assessments.status = 'missed' (in the 0001 check list since day one).
//   viewer: her own my_done row with skipped = true (0026). Its id is ALSO in doneIds, so every
//           list drops it exactly like a tick; skippedIds only changes the label.
export function isSkippedFor(a, { isViewer = false, skippedIds } = {}) {
  if (!a) return false
  if (!isViewer) return a.status === 'missed'
  return has(skippedIds, a.id)
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
// QUEST_OVERDUE_GRACE_DAYS and then drops off, and undated rows show only when switched on with
// show_tbc (0025), as a "date TBC" line that a tick removes like any other. That is
// the same window the owner has, so no extra date filter is added here.
export function visibleDeadlinesFor(rows, { isViewer = false, doneIds, today } = {}) {
  return myWeek(seenBy(rows, { isViewer, doneIds }), today)
}

// Module page This Week card, same rule.
export function weekAheadFor(rows, { isViewer = false, doneIds, today } = {}) {
  return weekAhead(seenBy(rows, { isViewer, doneIds }), today)
}
