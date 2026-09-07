// Regression net for the assessment adopt-don't-twin rule (see isSameAssessment in write.js).
//
// The bug this guards: assessments are seeded by hand from the study guide weeks before the
// lecturer opens the matching eFundi assignment. The sync deduped on source_id only, so it could
// not see the hand-seeded row and inserted a twin — ENGV121 carried both "Assignment 1 ·
// Sociolinguistics (pair)" (with its weight and brief) and a bare "Assignment 1".
//
// Run: node sync/verify-assessment-adopt.mjs
import { isSameAssessment } from './write.js';

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`FAIL  ${label}`); }
}

console.log('isSameAssessment — should ADOPT:');
// The real case, from the live duplicate this was written for.
ok('exact eFundi title + descriptive suffix', isSameAssessment('Assignment 1 · Sociolinguistics (pair)', 'Assignment 1'));
ok('identical titles', isSameAssessment('Assignment 1', 'Assignment 1'));
ok('case-insensitive', isSameAssessment('ASSIGNMENT 1 · Sociolinguistics', 'assignment 1'));
ok('eFundi "+" artifacts normalise away', isSameAssessment('MATV 121 Tutorial Task 2', 'MATV+121+Tutorial+Task+2'));
ok('colon separator', isSameAssessment('Assignment 2: After the Snow', 'Assignment 2'));
ok('dash separator', isSameAssessment('Assignment 3 - Phonetics', 'Assignment 3'));
ok('paren separator', isSameAssessment('Assignment 5 (group)', 'Assignment 5'));
ok('trailing whitespace ignored', isSameAssessment('Assignment 1 ', 'Assignment 1'));

// The 2026-09-07 SECL121 twin: BOTH sides carry their own descriptive suffix, and hers abbreviates
// "Assignment" to "Ass" — so neither title is a prefix of the other. Only the kind+number stem
// sees through it.
ok('both sides suffixed, "Ass" abbreviation (SECL121, live)',
  isSameAssessment('Ass 1 — Video recording: speaking Setswana (50)', 'ASSIGNMENT 1 - SOUNDS VALUES OF SETSWANA'));
ok('local title SHORTER than eFundi, same stem (MATV121 shape)',
  isSameAssessment('Assignment 2', 'Assignment 2 - Tutorial tasks 4-6'));
ok('test kind, both suffixed (EDCC125 shape)',
  isSameAssessment('Test 3 · Ch 3 (open-book MCQ, opens 28 Aug)', 'Test 3 - Chapter 3 online'));
ok('exam / examination are one kind', isSameAssessment('Exam 1 · open book', 'Examination 1'));

console.log('\nisSameAssessment — must NOT adopt:');

// The stem must not flatten SECL121's four assessments into each other: Ass 1 and Ass 2 are word-
// for-word identical apart from the number.
ok('same wording, different number', !isSameAssessment(
  'Ass 2 — Video recording: speaking Setswana (50)', 'ASSIGNMENT 1 - SOUNDS VALUES OF SETSWANA'));
ok('same number, different kind', !isSameAssessment('Test 1 · Trigonometry', 'Assignment 1 - Van Hiele'));
ok('stem number must be whole ("Ass 1" ≠ "Assignment 10")',
  !isSameAssessment('Ass 1 — Video recording', 'ASSIGNMENT 10 - LATER'));
ok('a number that is not a kind word yields no stem',
  !isSameAssessment('1. Introduction to Setswana', 'Assignment 1 - Sounds'));
ok('module code in front is not a stem (MATH121 shape)',
  !isSameAssessment('MATH 121  Assignment 1  2026 · Van Hiele', 'Test 1 - Trigonometry'));
// The whole reason for the separator check: a prefix alone would match here.
ok('"Assignment 1" does NOT match "Assignment 10"', !isSameAssessment('Assignment 10', 'Assignment 1'));
ok('"Test 1" does NOT match "Test 12 · Ch 2"', !isSameAssessment('Test 12 · Ch 2', 'Test 1'));
ok('different assignment numbers', !isSameAssessment('Assignment 2 · Essay', 'Assignment 1'));
ok('unrelated titles', !isSameAssessment('Portfolio', 'Assignment 1'));
ok('local title SHORTER than eFundi (not an extension)', !isSameAssessment('Assignment', 'Assignment 1'));
ok('empty local title', !isSameAssessment('', 'Assignment 1'));
ok('empty eFundi title never matches everything', !isSameAssessment('Assignment 1', ''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
