// Data layers for the Marks tab (src/Marks.jsx). Same idea as plannerData.js: the component never
// talks to Supabase directly. It is handed ONE of these objects and calls the same methods on
// either, so the live tab and the dev-only #marks-demo route run exactly the same component code.
//
//   fetchAll()                         -> { modules, assessments, myMarks, finals }
//   saveMark(owner, assessmentId, mark, raw) -> the my_marks row (upsert on owner + assessment)
//   clearMark(owner, assessmentId)     -> nothing (deletes that person's row for that assessment)
//   upsertFinal(owner, row)            -> the final_marks row (upsert on owner + module_code)
//   updateFinal(id, patch)             -> the updated final_marks row (updated_at stamped here)
//   addFinal(owner, row)               -> the inserted final_marks row
//   removeFinal(id)                    -> nothing
//
// Every method THROWS on failure, with a plain message.
//
// Reads never filter by owner: the row rules on my_marks and final_marks (0023) already return
// only the signed-in person's own rows, for BOTH accounts. modules and assessments are shared rows.
import { supabase } from './supabase'

// Supabase sends `numeric` columns as strings. null stays null; anything unreadable becomes null.
function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const cleanModule = (m) => ({ ...m, participation_pct: num(m.participation_pct) })
const cleanAssessment = (a) => ({ ...a, weight_pct: num(a.weight_pct) })
const cleanMark = (m) => ({ assessment_id: m.assessment_id, mark: num(m.mark), raw: m.raw ?? null })
const cleanFinal = (f) => ({ ...f, mark: num(f.mark), credits: f.credits == null ? null : num(f.credits), semester: f.semester == null ? null : num(f.semester) })

function fail(error) {
  const msg = error?.message || String(error || 'Unknown error')
  return new Error(msg)
}

async function run(query) {
  let res
  try {
    res = await query
  } catch (err) {
    throw fail(err)
  }
  if (res.error) throw fail(res.error)
  return res.data
}

export const marksDb = {
  demo: false,

  async fetchAll() {
    const [modules, assessments, myMarks, finals] = await Promise.all([
      run(supabase.from('modules').select('id, code, title, colour, hidden, participation_pct').order('code')),
      run(supabase.from('assessments').select('id, module_id, title, type, due_date, weight_pct, status')),
      run(supabase.from('my_marks').select('assessment_id, mark, raw')),
      run(supabase.from('final_marks').select('id, kind, module_code, title, credits, semester, mark').order('module_code')),
    ])
    return {
      modules: (modules || []).map(cleanModule),
      assessments: (assessments || []).map(cleanAssessment),
      myMarks: (myMarks || []).map(cleanMark),
      finals: (finals || []).map(cleanFinal),
    }
  },

  // .single() on purpose: a write the row rules quietly refuse returns 0 rows and no error, and
  // .single() turns that into an error instead of a false "saved".
  async saveMark(owner, assessmentId, mark, raw) {
    const row = { owner, assessment_id: assessmentId, mark, raw, updated_at: new Date().toISOString() }
    return cleanMark(await run(supabase.from('my_marks')
      .upsert(row, { onConflict: 'owner,assessment_id' })
      .select('assessment_id, mark, raw').single()))
  },

  async clearMark(owner, assessmentId) {
    await run(supabase.from('my_marks').delete().eq('owner', owner).eq('assessment_id', assessmentId))
  },

  async upsertFinal(owner, row) {
    const full = { ...row, owner, updated_at: new Date().toISOString() }
    return cleanFinal(await run(supabase.from('final_marks')
      .upsert(full, { onConflict: 'owner,module_code' })
      .select('*').single()))
  },

  async updateFinal(id, patch) {
    return cleanFinal(await run(supabase.from('final_marks')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select('*').single()))
  },

  async addFinal(owner, row) {
    return cleanFinal(await run(supabase.from('final_marks')
      .insert({ ...row, owner, updated_at: new Date().toISOString() })
      .select('*').single()))
  },

  async removeFinal(id) {
    await run(supabase.from('final_marks').delete().eq('id', id))
  },
}

// ---------------------------------------------------------------------------------------------
// DEMO layer: in memory only, for the dev-only #marks-demo route (App.jsx). Nothing here reaches a
// database. Made-up modules and made-up marks only (public repo): no names, no real marks, no ids.
// Created lazily so a production build, where nothing calls getMarksDemoLayer(), drops all of it.
//
// Test hook, dev only: window.__marksDemo = { failWrite: true } makes the next write fail (used to
// prove the screen rolls back). The layer is left on window.__marksDemoLayer for headless checks.
// ---------------------------------------------------------------------------------------------

let demoInstance = null

export function getMarksDemoLayer() {
  if (!demoInstance) {
    demoInstance = makeDemoLayer()
    if (typeof window !== 'undefined') window.__marksDemoLayer = demoInstance
  }
  return demoInstance
}

function makeDemoLayer() {
  let n = 0
  const id = (p) => `${p}-${++n}`

  // Six visible modules plus one hidden one (which must not get a pie).
  const modules = [
    { id: 'm1', code: 'ALPH101', title: 'Module one', colour: '#38e1ff', hidden: false, participation_pct: 40 },
    { id: 'm2', code: 'BETA102', title: 'Module two', colour: '#ff9f43', hidden: false, participation_pct: 50 },
    { id: 'm3', code: 'GAMM103', title: 'Module three', colour: '#ffd166', hidden: false, participation_pct: 100 },
    { id: 'm4', code: 'DELT104', title: 'Module four', colour: '#9a6bff', hidden: false, participation_pct: 40 },
    { id: 'm5', code: 'EPSI105', title: 'Module five', colour: '#34f5c5', hidden: false, participation_pct: null },
    { id: 'm6', code: 'ZETA106', title: 'Module six', colour: '#ff7fc1', hidden: false, participation_pct: 30 },
    { id: 'm7', code: 'HIDE107', title: 'Hidden module', colour: '#4d7cff', hidden: true, participation_pct: 40 },
  ]
  const a = (module_id, title, weight_pct, due_date, type = 'assignment') => ({
    id: id('a'), module_id, title, type, due_date, weight_pct, status: 'upcoming',
  })
  const assessments = [
    // m1: weights add to 100, two marked, one not yet, plus an exam (left out of the pie).
    a('m1', 'Assignment 1', 30, '2026-08-10'),
    a('m1', 'Test 1', 40, '2026-09-01', 'test'),
    a('m1', 'Assignment 2', 30, '2026-10-10'),
    a('m1', 'Exam', 60, '2026-11-10', 'exam'),
    // m2: weights stored as a share of the FINAL mark (20 + 20 + 10 = participation 50).
    a('m2', 'Essay', 20, '2026-08-20'),
    a('m2', 'Portfolio', 20, '2026-09-20'),
    a('m2', 'Quiz', 10, '2026-10-01', 'quiz'),
    // m3: four equal slices, nothing marked yet.
    a('m3', 'Task 1', 25, '2026-08-05'),
    a('m3', 'Task 2', 25, '2026-08-25'),
    a('m3', 'Task 3', 25, '2026-09-15'),
    a('m3', 'Task 4', 25, '2026-10-05'),
    // m4: weights add to 70 only, so 30% of the circle stays empty, plus one with no weight.
    a('m4', 'Project', 40, '2026-08-30'),
    a('m4', 'Test 1', 30, '2026-09-12', 'test'),
    a('m4', 'Reading log', null, '2026-10-02'),
    // m5: no weights at all: no slices, every row sits in the list.
    a('m5', 'Worksheet A', null, '2026-08-14'),
    a('m5', 'Worksheet B', null, '2026-09-14'),
    // m6: six slices, so all six colours show.
    a('m6', 'Unit 1', 10, '2026-07-28'),
    a('m6', 'Unit 2', 15, '2026-08-11'),
    a('m6', 'Unit 3', 15, '2026-08-25'),
    a('m6', 'Unit 4', 20, '2026-09-08'),
    a('m6', 'Unit 5', 20, '2026-09-22'),
    a('m6', 'Unit 6', 20, '2026-10-06'),
    // hidden module: must never show.
    a('m7', 'Hidden task', 100, '2026-09-01'),
  ]
  const byTitle = (mid, title) => assessments.find((x) => x.module_id === mid && x.title === title).id
  let myMarks = [
    { assessment_id: byTitle('m1', 'Assignment 1'), mark: 72, raw: '72' },
    { assessment_id: byTitle('m1', 'Test 1'), mark: 84, raw: '21/25' },
    { assessment_id: byTitle('m2', 'Essay'), mark: 65, raw: '65%' },
    { assessment_id: byTitle('m4', 'Project'), mark: 90, raw: '45/50' },
    { assessment_id: byTitle('m4', 'Reading log'), mark: 80, raw: '8/10' },
    { assessment_id: byTitle('m6', 'Unit 1'), mark: 100, raw: '10/10' },
    { assessment_id: byTitle('m6', 'Unit 2'), mark: 60, raw: '60' },
    { assessment_id: byTitle('m6', 'Unit 3'), mark: 50, raw: '50' },
  ]
  let finals = [
    { id: id('f'), kind: 'module', module_code: 'OLDA111', title: 'First module', credits: 12, semester: 1, mark: 81 },
    { id: id('f'), kind: 'module', module_code: 'OLDB112', title: 'Second module', credits: 12, semester: 1, mark: 67 },
    { id: id('f'), kind: 'module', module_code: 'OLDC113', title: 'Third module', credits: 8, semester: 1, mark: 74.5 },
    { id: id('f'), kind: 'module', module_code: 'OLDD114', title: 'Fourth module', credits: 12, semester: 1, mark: 92 },
    { id: id('f'), kind: 'module', module_code: 'OLDE115', title: 'Fifth module', credits: 8, semester: 1, mark: 58 },
    { id: id('f'), kind: 'module', module_code: 'YEAR100', title: 'Year module', credits: 16, semester: 0, mark: null },
    { id: id('f'), kind: 'module', module_code: 'BETA102', title: 'Module two', credits: 12, semester: 2, mark: 70 },
    { id: id('f'), kind: 'year_figure', module_code: 'YEAR-2026', title: 'Year average (from my record)', credits: null, semester: 0, mark: 71.25 },
  ]

  const hooks = () => (typeof window !== 'undefined' && window.__marksDemo) || {}
  const gate = async (write = false) => {
    await new Promise((r) => setTimeout(r, 30))   // a little latency, like the real thing
    const h = hooks()
    if (write && h.failWrite) {
      h.failWrite = false
      throw new Error('Demo: this write was set to fail')
    }
  }
  const copy = (x) => JSON.parse(JSON.stringify(x))

  return {
    demo: true,
    async fetchAll() {
      await gate()
      return copy({ modules, assessments, myMarks, finals })
    },
    async saveMark(_owner, assessmentId, mark, raw) {
      await gate(true)
      const row = { assessment_id: assessmentId, mark, raw }
      myMarks = myMarks.filter((m) => m.assessment_id !== assessmentId).concat(row)
      return copy(row)
    },
    async clearMark(_owner, assessmentId) {
      await gate(true)
      myMarks = myMarks.filter((m) => m.assessment_id !== assessmentId)
    },
    async upsertFinal(_owner, row) {
      await gate(true)
      const i = finals.findIndex((f) => f.module_code === row.module_code)
      if (i >= 0) {
        finals[i] = { ...finals[i], ...row }
        return copy(finals[i])
      }
      const made = { id: id('f'), kind: 'module', title: null, credits: null, semester: null, mark: null, ...row }
      finals = finals.concat(made)
      return copy(made)
    },
    async updateFinal(fid, patch) {
      await gate(true)
      const i = finals.findIndex((f) => f.id === fid)
      if (i < 0) throw new Error('Demo: no such row')
      finals[i] = { ...finals[i], ...patch }
      return copy(finals[i])
    },
    async addFinal(_owner, row) {
      await gate(true)
      if (finals.some((f) => f.module_code === row.module_code)) {
        throw new Error('duplicate key value violates unique constraint "final_marks_owner_code_uniq"')
      }
      const made = { id: id('f'), kind: 'module', title: null, credits: null, semester: null, mark: null, ...row }
      finals = finals.concat(made)
      return copy(made)
    },
    async removeFinal(fid) {
      await gate(true)
      finals = finals.filter((f) => f.id !== fid)
    },
  }
}
