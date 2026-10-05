// Regression net for src/lib/done.js: own ticks (0024 my_done).
// Run: node sync/verify-done.mjs   (exit 0 = all green)
// Every value here is made up (public repo): ids like "a1", modules like "MOD101".
//
// What it proves:
//   1. owner: behaviour is unchanged for all three statuses (the wrappers reduce to the old calls);
//   2. viewer: the owner's status plays no part at all;
//   3. viewer: her own tick hides a deadline;
//   4. viewer: a past-due unticked row is not listed once it is past the overdue grace;
//   5. undated rows.
import { isDoneFor, seenBy, visibleDeadlinesFor, weekAheadFor, VIEWER_DONE } from '../src/lib/done.js'
import { myWeek, weekAhead } from '../src/lib/week.js'
import { QUEST_OVERDUE_GRACE_DAYS } from '../src/lib/quests.js'

let pass = 0
let fail = 0
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++ } else { fail++; console.error(`✗ ${name}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`) }
}

const TODAY = '2026-10-05'
const STATUSES = ['upcoming', 'submitted', 'graded']
const M1 = { code: 'MOD101', colour: '#111' }
const M2 = { code: 'MOD202', colour: '#222' }
const row = (id, due_date, status, modules = M1, title = id) =>
  ({ id, module_id: modules.code, title, due_date, status, modules })
const ids = (rows) => rows.map((r) => r.id)
const OWNER = { isViewer: false }
const viewer = (...ticked) => ({ isViewer: true, doneIds: new Set(ticked) })

// A mixed set: every status, past, near, far, undated, two modules.
const ALL = [
  row('a1', '2026-10-06', 'upcoming'),
  row('a2', '2026-10-07', 'submitted'),
  row('a3', '2026-10-09', 'graded'),
  row('a4', '2026-10-20', 'upcoming'),
  row('a5', '2026-10-03', 'upcoming'),             // 2 days past: inside the overdue grace
  row('a6', '2026-09-20', 'upcoming'),             // 15 days past: outside the grace
  row('a7', null, 'upcoming'),                     // undated
  row('b1', '2026-10-08', 'submitted', M2),
  row('b2', '2026-10-12', 'upcoming', M2),
]

// ==================================================================
// 1. Owner: unchanged
// ==================================================================
for (const s of STATUSES) {
  const a = row('x', '2026-10-06', s)
  check(`owner isDoneFor, status ${s}, same as the old a.status !== 'upcoming'`, isDoneFor(a, OWNER), s !== 'upcoming')
  check(`owner isDoneFor, status ${s}, ignores any doneIds`, isDoneFor(a, { isViewer: false, doneIds: new Set(['x']) }), s !== 'upcoming')
}
check('owner isDoneFor with no options at all is the owner rule', isDoneFor(row('x', null, 'graded')), true)
check('owner seenBy hands back the SAME array, untouched', seenBy(ALL, OWNER) === ALL, true)
check('owner seenBy leaves every status as it was', ALL.map((a) => a.status), ['upcoming', 'submitted', 'graded', 'upcoming', 'upcoming', 'upcoming', 'upcoming', 'submitted', 'upcoming'])
check('owner visibleDeadlinesFor = myWeek(rows), whole mixed set', visibleDeadlinesFor(ALL, { ...OWNER, today: TODAY }), myWeek(ALL, TODAY))
// The owner's real fetch is status = 'upcoming' only; prove that path too.
const OWNER_FETCH = ALL.filter((a) => a.status === 'upcoming')
check('owner visibleDeadlinesFor = myWeek(rows), owner fetch', visibleDeadlinesFor(OWNER_FETCH, { ...OWNER, today: TODAY }), myWeek(OWNER_FETCH, TODAY))
check('owner weekAheadFor = weekAhead(rows)', weekAheadFor(ALL, { ...OWNER, today: TODAY }), weekAhead(ALL, TODAY))
for (const s of STATUSES) {
  const set = [row('x', '2026-10-06', s), row('y', '2026-10-08', 'upcoming')]
  check(`owner My Week with a ${s} row matches the old call`, visibleDeadlinesFor(set, { ...OWNER, today: TODAY }), myWeek(set, TODAY))
  check(`owner This Week with a ${s} row matches the old call`, weekAheadFor(set, { ...OWNER, today: TODAY }), weekAhead(set, TODAY))
}
check('owner: her submitted row stays off My Week (as before)', ids(visibleDeadlinesFor([row('x', '2026-10-06', 'submitted')], { ...OWNER, today: TODAY })), [])
check('owner: her graded row stays off This Week (as before)', weekAheadFor([row('x', '2026-10-06', 'graded')], { ...OWNER, today: TODAY }).thisWeek.length, 0)

// ==================================================================
// 2. Viewer: the owner's status is ignored
// ==================================================================
for (const s of STATUSES) {
  const a = row('x', '2026-10-06', s)
  check(`viewer isDoneFor, owner status ${s}, not ticked -> not done`, isDoneFor(a, viewer()), false)
  check(`viewer isDoneFor, owner status ${s}, ticked -> done`, isDoneFor(a, viewer('x')), true)
}
check('viewer isDoneFor with doneIds missing -> not done', isDoneFor(row('x', null, 'graded'), { isViewer: true }), false)
check('viewer seenBy: only her own two values ever come out',
  [...new Set(seenBy(ALL, viewer('a2')).map((a) => a.status))].sort(), [VIEWER_DONE, 'upcoming'].sort())
check('viewer seenBy: never the owner\'s submitted or graded',
  seenBy(ALL, viewer()).some((a) => a.status === 'submitted' || a.status === 'graded'), false)
check('viewer seenBy does not change the input rows', ALL[1].status, 'submitted')
check('viewer seenBy keeps every row, undated ones too', ids(seenBy(ALL, viewer())), ids(ALL))

// Swap every owner status for every other one: the viewer's screens must not move at all.
const flipped = (to) => ALL.map((a) => ({ ...a, status: to }))
const baseWeek = visibleDeadlinesFor(ALL, { ...viewer('a4'), today: TODAY })
const baseAhead = weekAheadFor(ALL, { ...viewer('a4'), today: TODAY })
for (const s of STATUSES) {
  check(`viewer My Week identical when every owner status is ${s}`,
    ids(visibleDeadlinesFor(flipped(s), { ...viewer('a4'), today: TODAY })), ids(baseWeek))
  check(`viewer This Week identical when every owner status is ${s}`,
    ids(weekAheadFor(flipped(s), { ...viewer('a4'), today: TODAY }).thisWeek), ids(baseAhead.thisWeek))
}
check('viewer My Week lists rows the owner submitted (b1 for MOD202)',
  ids(visibleDeadlinesFor(ALL, { ...viewer(), today: TODAY })).includes('b1'), true)
check('viewer This Week lists rows the owner submitted and graded',
  ids(weekAheadFor(ALL, { ...viewer(), today: TODAY }).thisWeek), ['a1', 'a2', 'b1', 'a3', 'b2'])
check('viewer with nothing ticked sees the same My Week as if every row were upcoming',
  visibleDeadlinesFor(ALL, { ...viewer(), today: TODAY }), myWeek(flipped('upcoming'), TODAY))

// ==================================================================
// 3. Viewer: her own tick hides a deadline
// ==================================================================
{
  const set = [row('a1', '2026-10-06', 'upcoming'), row('a2', '2026-10-07', 'upcoming')]
  check('viewer untouched: MOD101 line is a1', ids(visibleDeadlinesFor(set, { ...viewer(), today: TODAY })), ['a1'])
  check('viewer ticks a1: it leaves My Week and a2 takes the line', ids(visibleDeadlinesFor(set, { ...viewer('a1'), today: TODAY })), ['a2'])
  check('viewer ticks both: MOD101 has no line', ids(visibleDeadlinesFor(set, { ...viewer('a1', 'a2'), today: TODAY })), [])
  check('viewer ticks a1: it leaves This Week too', ids(weekAheadFor(set, { ...viewer('a1'), today: TODAY }).thisWeek), ['a2'])
  check('viewer tick of a row the owner never ticked hides it (owner status upcoming)',
    ids(visibleDeadlinesFor([row('z', '2026-10-06', 'upcoming')], { ...viewer('z'), today: TODAY })), [])
  check('viewer tick of a row the owner ticked hides it (owner status graded)',
    ids(visibleDeadlinesFor([row('z', '2026-10-06', 'graded')], { ...viewer('z'), today: TODAY })), [])
  // "+ N more due that day" stays as it was: only her unticked rows on that day count.
  const sameDay = [row('t1', '2026-10-07', 'submitted', M1, 'Test 1'), row('t2', '2026-10-07', 'upcoming', M1, 'Test 2'),
    row('t3', '2026-10-07', 'graded', M1, 'Test 3')]
  const r0 = visibleDeadlinesFor(sameDay, { ...viewer(), today: TODAY })
  check('viewer same-day group: one line, + 2 more, whatever the owner ticked', [ids(r0), r0[0].alsoDue], [['t1'], 2])
  const r1 = visibleDeadlinesFor(sameDay, { ...viewer('t1'), today: TODAY })
  check('viewer ticks Test 1: the line moves to Test 2, + 1 more', [ids(r1), r1[0].alsoDue], [['t2'], 1])
}

// ==================================================================
// 4. Viewer: the past is bounded (myWeek's own overdue window)
// ==================================================================
check('the overdue grace this relies on is still 4 days', QUEST_OVERDUE_GRACE_DAYS, 4)
{
  const v = visibleDeadlinesFor(ALL, { ...viewer(), today: TODAY })
  check('viewer: a row 15 days past, unticked, is not listed', ids(v).includes('a6'), false)
  check('viewer: a row 2 days past, unticked, shows as overdue (same grace as the owner)',
    v.filter((r) => r.id === 'a5').map((r) => r.overdue), [true])
  check('viewer: ticking that overdue row clears it',
    ids(visibleDeadlinesFor(ALL, { ...viewer('a5'), today: TODAY })).includes('a5'), false)
  const edge = [row('p', '2026-10-01', 'graded'), row('q', '2026-09-30', 'upcoming', M2)]
  check('viewer: exactly at the grace edge (4 days) still listed, 5 days not',
    ids(visibleDeadlinesFor(edge, { ...viewer(), today: TODAY })), ['p'])
  check('viewer: a whole semester of old rows lists none of them',
    visibleDeadlinesFor(Array.from({ length: 30 }, (_, i) => row(`o${i}`, `2026-08-${String(i + 1).padStart(2, '0')}`, STATUSES[i % 3])),
      { ...viewer(), today: TODAY }).length, 0)
  check('viewer This Week never lists past rows',
    weekAheadFor(ALL, { ...viewer(), today: TODAY }).thisWeek.some((r) => r.days < 0), false)
}

// ==================================================================
// 5. Undated rows
// ==================================================================
{
  const und = [row('u1', null, 'upcoming'), row('u2', null, 'graded')]
  check('viewer: undated rows are not on My Week (as for the owner)', visibleDeadlinesFor(und, { ...viewer(), today: TODAY }).length, 0)
  check('owner: undated rows are not on My Week (unchanged)', visibleDeadlinesFor(und, { ...OWNER, today: TODAY }).length, 0)
  check('viewer: undated rows are not on This Week', weekAheadFor(und, { ...viewer(), today: TODAY }), { thisWeek: [], next: null })
  check('viewer: an undated row can be ticked and unticked on the module page',
    [isDoneFor(und[0], viewer()), isDoneFor(und[0], viewer('u1')), isDoneFor(und[1], viewer())], [false, true, false])
  check('owner: undated graded row still reads done on the module page', isDoneFor(und[1], OWNER), true)
}

// ---- empty / odd input ----
check('visibleDeadlinesFor(null) for the viewer is []', visibleDeadlinesFor(null, { ...viewer(), today: TODAY }), [])
check('seenBy(null) for the viewer is []', seenBy(null, viewer()), [])
check('isDoneFor(null) is false', isDoneFor(null, viewer('x')), false)

console.log(`${pass}/${pass + fail} checks passed`)
process.exit(fail ? 1 : 0)
