// Regression net for src/lib/week.js — the My Week / This Week card decisions.
// Run: node sync/verify-week.mjs   (exit 0 = all green)
import { weekAhead, myWeek, dueLabel, formatDue, WEEK_AHEAD_DAYS } from '../src/lib/week.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

const TODAY = '2026-08-17' // the Monday this feature shipped; CW1 due the coming Sunday

// ---- weekAhead (module page) ----
const alde = [
  { id: 'a1', title: 'A1 MCQ', due_date: '2026-07-26', status: 'upcoming' },            // past → dropped
  { id: 'cw1', title: 'Class Work 1', due_date: '2026-08-23', status: 'upcoming' },     // 6 days → this week
  { id: 'cw23', title: 'Class Work 2 & 3', due_date: '2026-08-30', status: 'upcoming' },// 13 days → next
  { id: 'a2', title: 'A2 Group Writing', due_date: '2026-09-20', status: 'upcoming' },
  { id: 'a5', title: 'A5 umbrella', due_date: null, status: 'upcoming' },               // dateless → dropped
  { id: 'done', title: 'Marked done', due_date: '2026-08-20', status: 'done' },         // not upcoming → dropped
]
const wk = weekAhead(alde, TODAY)
check('weekAhead: this week holds exactly CW1', wk.thisWeek.map((a) => a.id), ['cw1'])
check('weekAhead: CW1 counted at 6 days', wk.thisWeek[0].days, 6)
check('weekAhead: next beyond the week is CW2&3, not A2', wk.next?.id, 'cw23')

// due exactly on day 7 still counts as this week (boundary)
const boundary = weekAhead([{ id: 'b', title: 'B', due_date: '2026-08-24', status: 'upcoming' }], TODAY)
check(`weekAhead: day ${WEEK_AHEAD_DAYS} is inside the week`, boundary.thisWeek.map((a) => a.id), ['b'])
check('weekAhead: nothing beyond → next is null', boundary.next, null)

// quiet module: nothing this week, next surfaces
const quiet = weekAhead([{ id: 'far', title: 'Far', due_date: '2026-10-07', status: 'upcoming' }], TODAY)
check('weekAhead: quiet module → empty week + a next', [quiet.thisWeek.length, quiet.next?.id], [0, 'far'])

// today itself counts (days = 0), and ordering is soonest-first
const twoNow = weekAhead([
  { id: 'later', title: 'L', due_date: '2026-08-22', status: 'upcoming' },
  { id: 'now', title: 'N', due_date: '2026-08-17', status: 'upcoming' },
], TODAY)
check('weekAhead: due today included, soonest first', twoNow.thisWeek.map((a) => a.id), ['now', 'later'])

// ---- myWeek (dashboard) ----
const dash = [
  { id: '1', title: 'CW1', due_date: '2026-08-23', modules: { code: 'ALDE122', colour: '#6ba8ff' } },
  { id: '2', title: 'CW2&3', due_date: '2026-08-30', modules: { code: 'ALDE122', colour: '#6ba8ff' } }, // 2nd ALDE row → folded away
  { id: '3', title: 'Test 1', due_date: '2026-10-07', modules: { code: 'EDCC125', colour: '#ffd76b' } },
  { id: '4', title: 'Old thing', due_date: '2026-07-01', modules: { code: 'ENGV121', colour: '#c39bff' } }, // past-only module → off the list
  { id: '5', title: 'Dateless', due_date: null, modules: { code: 'MATH121' } },                              // dateless-only module → off the list
]
const mw = myWeek(dash, TODAY)
check('myWeek: one line per module, soonest module first', mw.map((d) => d.modules.code), ['ALDE122', 'EDCC125'])
check('myWeek: ALDE line is its SOONEST deadline (CW1)', mw[0].id, '1')
check('myWeek: this-week flag on ALDE, not on EDCC', mw.map((d) => d.thisWeek), [true, false])
check('myWeek: empty input → empty list', myWeek([], TODAY), [])

// same-day tie between modules breaks alphabetically so the order is stable, not fetch-order
const tie = myWeek([
  { id: 'x', title: 'X', due_date: '2026-08-20', modules: { code: 'SECL121' } },
  { id: 'y', title: 'Y', due_date: '2026-08-20', modules: { code: 'ALDE122' } },
], TODAY)
check('myWeek: same-day tie breaks by module code', tie.map((d) => d.modules.code), ['ALDE122', 'SECL121'])

// ---- the inherited overdue grace (Quest Log retirement, s19) ----
// A deadline missed 2 days ago must STAY visible (red) while one missed 5 days ago has aged out —
// the s18 both-ends rule, now living in My Week. The overdue row sorts above the upcoming ones.
const grace = myWeek([
  { id: 'm2', title: 'Missed recently', due_date: '2026-08-15', modules: { code: 'ALDE122' } }, // -2
  { id: 'm5', title: 'Missed long ago', due_date: '2026-08-12', modules: { code: 'ENGV121' } }, // -5 → gone
  { id: 'up', title: 'Coming up', due_date: '2026-08-23', modules: { code: 'ALDE122' } },
], TODAY)
check('grace: 2-days-missed shows, 5-days-missed aged out', grace.map((d) => d.id), ['m2', 'up'])
check('grace: missed row tagged overdue, upcoming not', grace.map((d) => d.overdue), [true, false])
check('grace: a module can carry BOTH an overdue and an upcoming line', grace.filter((d) => d.modules.code === 'ALDE122').length, 2)
// exactly at the grace boundary (-4) still shows; the module keeps only its MOST RECENT miss
const edge = myWeek([
  { id: 'e4', title: 'Edge', due_date: '2026-08-13', modules: { code: 'SECL121' } },            // -4 → last day shown
  { id: 'older', title: 'Older miss', due_date: '2026-08-14', modules: { code: 'MATH121' } },    // -3
  { id: 'oldest', title: 'Oldest miss', due_date: '2026-08-13', modules: { code: 'MATH121' } },  // -4 → folded away
], TODAY)
check('grace: day -4 boundary still shows; one overdue line per module (most recent miss)',
  edge.map((d) => d.id), ['e4', 'older'])

// ---- labels ----
check('dueLabel: today', dueLabel(0), 'today')
check('dueLabel: tomorrow', dueLabel(1), 'tomorrow')
check('dueLabel: in N days', dueLabel(6), 'in 6 days')
check('formatDue: Sun 23 Aug', formatDue('2026-08-23'), 'Sun 23 Aug')
check('formatDue: Wed 7 Oct', formatDue('2026-10-07'), 'Wed 7 Oct')
check('formatDue: garbage passes through', formatDue('date TBC'), 'date TBC')

console.log(`${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
