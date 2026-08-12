// Regression net for the Quest Log window (questWindow / daysUntil in src/lib/quests.js).
//
// The bug this guards: the window only had an UPPER bound ("due within 21 days"), and nothing in
// the app ever moves an assessment off status='upcoming'. So every deadline ever seeded stayed on
// the dashboard forever. On 2026-08-12 the log was showing a 24 July test, a 26 July assessment
// and a 7 August test above the actually-next one.
//
// Imported from the same module the app imports, so the test exercises the code that ships (Node
// cannot load .jsx — that is why this logic lives in src/lib/quests.js). `today` is injected, so
// these assertions never rot.
//
// Run: node sync/verify-quest-window.mjs
import { questWindow, daysUntil, QUEST_AHEAD_DAYS, QUEST_OVERDUE_GRACE_DAYS } from '../src/lib/quests.js';

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`); }
}

const TODAY = '2026-08-12';
const row = (id, due) => ({ id, due_date: due, title: id });
const ids = (rows) => rows.map((r) => r.id);

console.log('daysUntil (calendar days, not instants):');
ok('today = 0', daysUntil('2026-08-12', TODAY) === 0, daysUntil('2026-08-12', TODAY));
ok('tomorrow = 1', daysUntil('2026-08-13', TODAY) === 1);
ok('yesterday = -1', daysUntil('2026-08-11', TODAY) === -1);
ok('11 days out', daysUntil('2026-08-23', TODAY) === 11, daysUntil('2026-08-23', TODAY));
ok('across a month boundary', daysUntil('2026-09-11', TODAY) === 30, daysUntil('2026-09-11', TODAY));
ok('garbage date -> null', daysUntil('not-a-date', TODAY) === null);

console.log('\nquestWindow boundaries:');
ok('due today is IN and not overdue', (() => {
  const r = questWindow([row('today', '2026-08-12')], TODAY);
  return r.length === 1 && r[0].overdue === false;
})());
ok(`last day ahead (+${QUEST_AHEAD_DAYS}) is IN`, questWindow([row('edge', '2026-09-02')], TODAY).length === 1);
ok(`one day past the window (+${QUEST_AHEAD_DAYS + 1}) is OUT`, questWindow([row('far', '2026-09-03')], TODAY).length === 0);
ok(`last overdue day (-${QUEST_OVERDUE_GRACE_DAYS}) is IN and flagged`, (() => {
  const r = questWindow([row('grace', '2026-08-08')], TODAY);
  return r.length === 1 && r[0].overdue === true;
})());
ok(`one day older (-${QUEST_OVERDUE_GRACE_DAYS + 1}) is OUT`, questWindow([row('stale', '2026-08-07')], TODAY).length === 0);
ok('date-TBC (null due_date) is OUT', questWindow([{ id: 'tbc', due_date: null }], TODAY).length === 0);
ok('empty / missing input is safe', questWindow([], TODAY).length === 0 && questWindow(null, TODAY).length === 0);

console.log('\nthe real 2026-08-12 dashboard (the reported bug):');
// Exactly what the live rows looked like, after the EDCC125 guessed dates were cleared.
const live = [
  row('EDCC125 Test 1 (24 Jul, was showing)', '2026-07-24'),
  row('ALDE122 A1 (26 Jul, was showing)', '2026-07-26'),
  row('EDCC125 Test 2 (7 Aug, was showing)', '2026-08-07'),
  row('EDCC125 Test 3 (21 Aug)', '2026-08-21'),
  row('ENGV121 Assignment 1 (23 Aug)', '2026-08-23'),
  row('ALDE122 A2 (30 Aug)', '2026-08-30'),
  row('ENGV121 Assignment 2 (11 Sep, too far out)', '2026-09-11'),
];
const got = questWindow(live, TODAY);
ok('the three stale July/early-Aug items are gone', !ids(got).some((s) => /was showing/.test(s)), ids(got));
ok('the three genuinely upcoming ones remain', got.length === 3, ids(got));
ok('nothing further than 3 weeks out leaks in', !ids(got).some((s) => /too far out/.test(s)));
ok('soonest first', ids(got)[0] === 'EDCC125 Test 3 (21 Aug)', ids(got));
ok('none flagged overdue (all future)', got.every((d) => !d.overdue));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
