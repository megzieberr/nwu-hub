// Data layers for the Week tab (src/WeekPlanner.jsx). The component never talks to Supabase
// directly: it is handed ONE of these objects and calls the same six methods on either, so the
// live view and the dev-only demo route run exactly the same component code.
//
//   fetchWeek(mon, sun)        → { blocks, goals, assessments, modules } for one Monday..Sunday
//   fetchBlocks(from, to)      → plan_blocks rows with from <= block_date <= to
//   fetchSeries(id, fromDate)  → the rows of one repeat series from fromDate onwards
//   insert(rows)               → the inserted rows, ids and all
//   update(id, patch)          → the updated row (updated_at is stamped here, every time)
//   remove(ids)                → nothing
//
// Every method THROWS on failure. An error that looks like "no network" carries `offline: true`,
// which is what lets the component fall back to its saved copy instead of shouting.
//
// No query here filters by user: plan_blocks' row rules (0021) already return only the signed-in
// person's rows, and inserts leave `owner` to its column default (auth.uid()).
import { supabase } from './supabase'
import { localDateStr, mondayOf, addDays } from './planner.js'

const TABLE = 'plan_blocks'

function fail(error) {
  const msg = error?.message || String(error || 'Unknown error')
  const e = new Error(msg)
  const offlineNow = typeof navigator !== 'undefined' && navigator.onLine === false
  e.offline = offlineNow || /failed to fetch|networkerror|network request failed|load failed/i.test(msg)
  return e
}

function must(res) {
  if (res.error) throw fail(res.error)
  return res.data
}

// supabase-js resolves (never rejects) on an HTTP error, but a dropped connection can still throw
// from inside fetch on some browsers. Both roads end in the same kind of Error.
async function run(query) {
  try {
    return must(await query)
  } catch (err) {
    if (err instanceof Error && 'offline' in err) throw err
    throw fail(err)
  }
}

export const plannerDb = {
  demo: false,

  async fetchWeek(mon, sun) {
    const [blocks, goals, assessments, modules] = await Promise.all([
      run(supabase.from(TABLE).select('*')
        .gte('block_date', mon).lte('block_date', sun)
        .order('block_date').order('start_time')),
      // Her NWU classes, already in the hub. goals is owner-only, so a viewer simply gets none.
      run(supabase.from('goals')
        .select('id, text, kind, target_date, target_time, recurring, module_id, modules(code,colour)')
        .eq('kind', 'class')),
      // Every status, not just 'upcoming': the strip shows submitted items too (muted, ticked).
      run(supabase.from('assessments')
        .select('id, title, due_date, status, module_id, modules(code,colour,hidden)')
        .gte('due_date', mon).lte('due_date', sun)),
      run(supabase.from('modules').select('id, code, title, colour, hidden').order('code')),
    ])
    return {
      blocks: blocks || [],
      goals: goals || [],
      // Same rule as the dashboard: a hidden module's deadlines never surface.
      assessments: (assessments || []).filter((a) => !a.modules?.hidden),
      modules: modules || [],
    }
  },

  async fetchBlocks(from, to) {
    return (await run(supabase.from(TABLE).select('*')
      .gte('block_date', from).lte('block_date', to))) || []
  },

  async fetchSeries(seriesId, fromDate) {
    return (await run(supabase.from(TABLE).select('*')
      .eq('series_id', seriesId).gte('block_date', fromDate)
      .order('block_date'))) || []
  },

  async insert(rows) {
    if (!rows.length) return []
    return (await run(supabase.from(TABLE).insert(rows).select('*'))) || []
  },

  // .single() on purpose: an update the row rules quietly refuse touches 0 rows and returns no
  // error, and a "saved" that never saved is the worst kind of bug. .single() turns 0 rows into one.
  async update(id, patch) {
    return run(supabase.from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).select('*').single())
  },

  async remove(ids) {
    if (!ids.length) return
    await run(supabase.from(TABLE).delete().in('id', ids))
  },
}

// ---------------------------------------------------------------------------------------------
// DEMO layer: in memory only, for the dev-only #week-demo route (App.jsx). Nothing here reaches a
// database. Fixtures are name-free on purpose (public repo). Created lazily so that a production
// build, where nothing calls getDemoLayer(), drops all of this.
//
// Test hooks, dev only: window.__weekDemo = { offline: true } makes every call fail as offline;
// { failUpdate: 2 } makes the 2nd update from now fail (used to prove the swap rolls back).
// Its data lives for the page's lifetime; a reload starts from the fixtures again.
// ---------------------------------------------------------------------------------------------

let demoInstance = null

export function getDemoLayer() {
  if (!demoInstance) demoInstance = makeDemoLayer()
  return demoInstance
}

function makeDemoLayer() {
  const mon = mondayOf(localDateStr(new Date()))
  const day = (i) => addDays(mon, i)
  let n = 0
  const id = () => `demo-${++n}`

  const modules = [
    { id: 'm1', code: 'MATH101', title: 'Module one', colour: '#38e1ff', hidden: false },
    { id: 'm2', code: 'ENGL102', title: 'Module two', colour: '#ff5c7a', hidden: false },
    { id: 'm3', code: 'EDUC103', title: 'Module three', colour: '#ffd166', hidden: false },
    { id: 'm4', code: 'HIDE104', title: 'Hidden module', colour: '#9a6bff', hidden: true },
  ]
  const modRef = (mid) => {
    const m = modules.find((x) => x.id === mid)
    return m ? { code: m.code, colour: m.colour, hidden: m.hidden } : null
  }

  const b = (i, start, end, extra = {}) => ({
    id: id(), block_date: day(i), start_time: `${start}:00`, end_time: `${end}:00`,
    module_id: null, kind: 'study', label: '', done: false, done_at: null, note: null,
    series_id: null, source: null, source_key: null, ...extra,
  })
  const lockedRow = (i, start, end) => b(i, start, end, {
    kind: 'class', label: 'Group lesson', source: 'whenworks', source_key: `ww:demo:${day(i)}`,
  })

  let blocks = [
    b(0, '10:00', '11:30', { module_id: 'm1', label: 'Chapter 3 reading' }),
    lockedRow(0, '16:15', '17:00'),
    b(1, '14:00', '15:00', { module_id: 'm2', label: 'Essay outline' }),
    b(1, '14:30', '15:30', { kind: 'prep', label: 'Lesson prep' }),          // overlaps the one above
    b(2, '10:00', '12:00', { module_id: 'm3', label: 'Unit 2 notes' }),
    b(2, '16:15', '17:00', { module_id: 'm1', label: 'Past paper drill' }),
    b(2, '19:30', '20:00', { kind: 'break', label: 'Walk' }),
    b(3, '11:00', '12:30', { module_id: 'm2', label: 'Reading log', done: true, done_at: new Date().toISOString() }),
    lockedRow(3, '16:15', '17:00'),
    b(4, '10:00', '11:00', { kind: 'other', label: 'Admin' }),
    b(4, '13:00', '14:00', { module_id: 'm3', label: 'Quiz practice' }),
    lockedRow(4, '17:00', '18:00'),
    b(6, '18:00', '19:00', { kind: 'prep', label: 'Plan the week' }),
  ]
  // A three-week repeat series on Saturday, so "just this one / this and later ones" has
  // something to act on.
  for (let w = 0; w < 3; w++) {
    blocks.push({ ...b(5, '10:00', '12:00', { module_id: 'm1', label: 'Weekly review', series_id: 'demo-series' }),
      block_date: addDays(day(5), 7 * w) })
  }

  const goals = [
    // Recurring NWU class, timed: shows every week on its weekday (a Tuesday).
    { id: 'g1', text: 'MATH101 lecture', kind: 'class', target_date: day(1), target_time: '12:00:00',
      recurring: true, module_id: 'm1', modules: { code: 'MATH101', colour: '#38e1ff' } },
    // One-off NWU class with no time: goes in the untimed row, this week only (a Thursday).
    { id: 'g2', text: 'ENGL102 online session', kind: 'class', target_date: day(3), target_time: null,
      recurring: false, module_id: 'm2', modules: { code: 'ENGL102', colour: '#ff5c7a' } },
  ]

  const assessments = [
    { id: 'a1', title: 'Essay draft', due_date: day(2), status: 'upcoming', module_id: 'm2' },
    { id: 'a2', title: 'Quiz 2', due_date: day(2), status: 'upcoming', module_id: 'm3' },
    { id: 'a3', title: 'Test 1', due_date: day(4), status: 'submitted', module_id: 'm1' },
    { id: 'a4', title: 'Reflection', due_date: day(4), status: 'upcoming', module_id: 'm3' },
    { id: 'a5', title: 'Hidden item', due_date: day(4), status: 'upcoming', module_id: 'm4' },
  ].map((a) => ({ ...a, modules: modRef(a.module_id) }))

  const hooks = () => (typeof window !== 'undefined' && window.__weekDemo) || {}
  const gate = async () => {
    await new Promise((r) => setTimeout(r, 30))   // a little latency, like the real thing
    if (hooks().offline) {
      const e = new Error('Failed to fetch (demo offline)')
      e.offline = true
      throw e
    }
  }
  const copy = (x) => JSON.parse(JSON.stringify(x))
  const sortBlocks = (rows) => rows.slice().sort((x, y) =>
    x.block_date.localeCompare(y.block_date) || x.start_time.localeCompare(y.start_time))
  const withSeconds = (t) => (t && t.length === 5 ? `${t}:00` : t)

  return {
    demo: true,
    async fetchWeek(from, to) {
      await gate()
      return copy({
        blocks: sortBlocks(blocks.filter((x) => x.block_date >= from && x.block_date <= to)),
        goals,
        assessments: assessments.filter((a) => a.due_date >= from && a.due_date <= to && !a.modules?.hidden),
        modules,
      })
    },
    async fetchBlocks(from, to) {
      await gate()
      return copy(blocks.filter((x) => x.block_date >= from && x.block_date <= to))
    },
    async fetchSeries(seriesId, fromDate) {
      await gate()
      return copy(sortBlocks(blocks.filter((x) => x.series_id === seriesId && x.block_date >= fromDate)))
    },
    async insert(rows) {
      await gate()
      const made = rows.map((r) => ({
        id: id(), module_id: null, kind: 'study', label: '', done: false, done_at: null, note: null,
        series_id: null, source: null, source_key: null, ...r,
        start_time: withSeconds(r.start_time), end_time: withSeconds(r.end_time),
      }))
      blocks = blocks.concat(made)
      return copy(made)
    },
    async update(bid, patch) {
      await gate()
      const h = hooks()
      if (h.failUpdate) {
        h.failUpdate -= 1
        if (h.failUpdate === 0) throw new Error('Demo: this update was set to fail')
      }
      const i = blocks.findIndex((x) => x.id === bid)
      if (i < 0) throw new Error('Demo: no such block')
      const p = { ...patch, updated_at: new Date().toISOString() }
      if (p.start_time) p.start_time = withSeconds(p.start_time)
      if (p.end_time) p.end_time = withSeconds(p.end_time)
      blocks[i] = { ...blocks[i], ...p }
      return copy(blocks[i])
    },
    async remove(ids) {
      await gate()
      blocks = blocks.filter((x) => !ids.includes(x.id))
    },
  }
}
