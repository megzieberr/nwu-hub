import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ping } from './lib/ping'
import { formatDue } from './lib/week'
import {
  localDateStr, parseLocalDate, addDays, mondayOf, weekDates, timeToMin, minToTime,
  gridRows, freeGaps, dueByDay, expandRepeat, swapBlocks, copyWeek, classMarkersForWeek,
} from './lib/planner.js'

// The Week tab (sunday-planner/PLAN-week-tab.md, unit 2b): her study blocks for one Monday..Sunday,
// on the hub's own look. Three faces of ONE component:
//   • wide screen  — a Monday..Sunday grid in 15-minute rows;
//   • phone (<760) — one day at a time: day tabs, swipe, a time-ordered list with tappable gaps;
//   • wallpaper    — the grid and deadline strip only, centred for a 1920x1080 screenshot.
//
// All date/time/gap/repeat/swap/copy decisions come from lib/planner.js (tested there). All reads
// and writes go through the `data` prop (lib/plannerData.js): the live Supabase layer, or the
// in-memory demo layer on the dev-only #week-demo route. This file never imports the client.

const HOURS_KEY = 'nwuHub.week.hours'
const CACHE_PREFIX = 'nwuHub.week.cache.'
const CACHE_WEEKS = 8
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Fixed chips beside the module chips. Colours come from the hub palette, no new ones.
const KIND_CHIPS = [
  { kind: 'prep', name: 'Prep', colour: 'var(--gold)' },
  { kind: 'break', name: 'Break', colour: 'var(--green)' },
  { kind: 'other', name: 'Other', colour: 'var(--blue)' },
]
const KIND_NAME = { study: 'Study', class: 'Class', prep: 'Prep', break: 'Break', other: 'Other' }
const STUDY_COLOUR = 'var(--cyan)'
// Rows copied in from the tutoring scheduler (source set): one "classes" colour, locked.
const LOCKED_COLOUR = 'var(--purple)'
const ROW_PX = 12            // one 15-minute row on the normal wide grid (an hour = 48px)
const REPEAT_WEEKS = 6       // default "repeat every week until": 6 weeks ahead
const REPEAT_CAP = 26

// ---------- small helpers (formatting only; the logic lives in planner.js) ----------

const hm = (t) => String(t || '').slice(0, 5)

function rangeLabel(dates) {
  const a = parseLocalDate(dates[0])
  const b = parseLocalDate(dates[6])
  return `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]}`
}

function lengthLabel(min) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (!h) return `${m} min`
  return m ? `${h} h ${m} min` : `${h} h`
}

function savedAtLabel(iso) {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return 'earlier'
  return `${formatDue(localDateStr(d))}, ${minToTime(d.getHours() * 60 + d.getMinutes())}`
}

function readHours() {
  try {
    const v = JSON.parse(localStorage.getItem(HOURS_KEY) || 'null')
    if (v && Number.isInteger(v.start) && Number.isInteger(v.end) && v.start >= 6 && v.end <= 24 && v.end > v.start) return v
  } catch { /* fall through to the default */ }
  return { start: 10, end: 22 }
}

function writeHours(v) {
  try { localStorage.setItem(HOURS_KEY, JSON.stringify(v)) } catch { /* per-device nicety only */ }
}

function readCache(cacheId) {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_PREFIX + cacheId) || 'null')
    if (v && v.weeks && typeof v.weeks === 'object') return v
  } catch { /* a broken copy is no copy */ }
  return { weeks: {} }
}

function saveCache(cacheId, monday, week) {
  try {
    const c = readCache(cacheId)
    c.weeks[monday] = { ...week, savedAt: new Date().toISOString() }
    // Keep the most recently saved few weeks; a cache is a spare copy, not an archive.
    const keep = Object.entries(c.weeks)
      .sort((a, b) => String(b[1].savedAt).localeCompare(String(a[1].savedAt)))
      .slice(0, CACHE_WEEKS)
    localStorage.setItem(CACHE_PREFIX + cacheId, JSON.stringify({ weeks: Object.fromEntries(keep) }))
  } catch { /* storage full or blocked: the live view still works */ }
}

function useIsPhone() {
  const q = '(max-width: 759px)'
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const f = () => setM(mq.matches)
    f()
    mq.addEventListener('change', f)
    return () => mq.removeEventListener('change', f)
  }, [])
  return m
}

function blockColour(b, modById) {
  if (b.source) return LOCKED_COLOUR
  const m = b.module_id && modById[b.module_id]
  if (m && m.colour) return m.colour
  const k = KIND_CHIPS.find((x) => x.kind === b.kind)
  return k ? k.colour : STUDY_COLOUR
}

function blockTitle(b, modById) {
  return b.label || (b.module_id && modById[b.module_id]?.code) || KIND_NAME[b.kind] || 'Study'
}

// Side-by-side lanes for overlapping items in one day column (overlaps are allowed on purpose).
// Layout only: which items overlap is plain interval maths on the minutes planner.js already gave.
function withLanes(items) {
  const sorted = items.slice().sort((a, b) => a.s - b.s || b.e - a.e)
  const out = []
  let cluster = []
  let laneEnds = []
  let clusterEnd = -1
  const flush = () => {
    for (const it of cluster) it.lanes = laneEnds.length
    cluster = []
    laneEnds = []
    clusterEnd = -1
  }
  for (const it of sorted) {
    if (cluster.length && it.s >= clusterEnd) flush()
    let lane = laneEnds.findIndex((end) => end <= it.s)
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(it.e) } else laneEnds[lane] = it.e
    const p = { ...it, lane }
    cluster.push(p)
    out.push(p)
    clusterEnd = Math.max(clusterEnd, it.e)
  }
  flush()
  return out
}

// A timed NWU class marker as a block-shaped object, so gridRows/freeGaps can take it as-is.
const markerAsBlock = (m) => ({ block_date: m.date, start_time: minToTime(m.start), end_time: minToTime(m.end) })

// =================================================================================================

export default function WeekPlanner({ data: db, cacheId = null, wall = false, onOpenWall, onExitWall }) {
  const today = useMemo(() => localDateStr(new Date()), [])
  const [monday, setMonday] = useState(() => mondayOf(today))
  const dates = useMemo(() => weekDates(monday), [monday])
  const [selDay, setSelDay] = useState(() => Math.max(0, weekDates(mondayOf(today)).indexOf(today)))
  const [hours, setHours] = useState(readHours)
  const [week, setWeek] = useState(null)             // { blocks, goals, assessments, modules }
  const [status, setStatus] = useState('loading')    // loading | ok | offline
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editor, setEditor] = useState(null)         // { block|null, date, start, length }
  const [pick, setPick] = useState(null)             // the block waiting for its swap partner
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const phoneWidth = useIsPhone()
  const isPhone = phoneWidth && !wall
  const loadSeq = useRef(0)

  const load = useCallback(async (mon) => {
    const seq = ++loadSeq.current
    try {
      const w = await db.fetchWeek(mon, addDays(mon, 6))
      if (seq !== loadSeq.current) return
      setWeek(w)
      setSavedAt(null)
      setStatus('ok')
      if (cacheId) saveCache(cacheId, mon, w)
    } catch (e) {
      if (seq !== loadSeq.current) return
      // Read-only fallback: the last copy of THIS week saved on this device, if there is one.
      // There is no queue of offline writes on purpose, so editing is simply off until online.
      const cached = cacheId ? readCache(cacheId).weeks[mon] : null
      setWeek(cached || null)
      setSavedAt(cached ? cached.savedAt : null)
      setStatus('offline')
      if (!e.offline) setError(`Could not load this week: ${e.message}`)
    }
  }, [db, cacheId])

  useEffect(() => {
    setWeek(null)
    setStatus('loading')
    load(monday)
  }, [monday, load])

  // Back online: fetch again rather than leave her on the stale copy.
  useEffect(() => {
    const again = () => load(monday)
    window.addEventListener('online', again)
    return () => window.removeEventListener('online', again)
  }, [monday, load])

  // Keep the saved copy in step with local changes (a tick, a move) once the week is live.
  useEffect(() => {
    if (status === 'ok' && week && cacheId) saveCache(cacheId, monday, week)
  }, [week]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(t)
  }, [notice])

  // Wallpaper: Esc (or a tap, below) goes back to the normal Week view.
  useEffect(() => {
    if (!wall) return
    const onKey = (e) => { if (e.key === 'Escape') onExitWall && onExitWall() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [wall, onExitWall])

  const modules = week?.modules || []
  const modById = useMemo(() => Object.fromEntries(modules.map((m) => [m.id, m])), [modules])
  const chipModules = modules.filter((m) => !m.hidden)
  const blocks = week?.blocks || []
  const markers = useMemo(
    () => classMarkersForWeek(week?.goals || [], dates).filter((m) => m.date),
    [week, dates])
  const due = useMemo(() => dueByDay(week?.assessments || [], dates), [week, dates])
  const startMin = hours.start * 60
  const endMin = hours.end * 60
  const readOnly = status !== 'ok'
  const thisMonday = mondayOf(today)

  function changeHours(next) {
    setHours(next)
    writeHours(next)
  }

  function goWeek(mon, dayIdx) {
    setPick(null)
    setConfirmClear(false)
    setMonday(mon)
    const t = weekDates(mon).indexOf(today)
    setSelDay(dayIdx ?? (t >= 0 ? t : 0))
  }

  function stepDay(n) {
    const d = selDay + n
    if (d > 6) goWeek(addDays(monday, 7), 0)
    else if (d < 0) goWeek(addDays(monday, -7), 6)
    else setSelDay(d)
  }

  function patchLocal(id, patch) {
    setWeek((w) => (w ? { ...w, blocks: w.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) } : w))
  }

  function dayItems(date) {
    return [
      ...blocks.filter((b) => b.block_date === date),
      ...markers.filter((m) => m.date === date && !m.untimed).map(markerAsBlock),
    ]
  }

  // New block: at the tapped time, an hour long, or less if the free gap is shorter.
  function openNew(date, start, gapEnd) {
    if (readOnly || pick) return
    let end = gapEnd
    if (end == null) {
      const g = freeGaps(dayItems(date), startMin, endMin).find((x) => start >= x.start && start < x.end)
      end = g ? g.end : start + 60
    }
    const length = Math.max(15, Math.min(60, end - start, 24 * 60 - start))
    setError('')
    setEditor({ block: null, date, start, length })
  }

  function openEdit(b) {
    if (readOnly || b.source) return
    if (pick) { choosePartner(b); return }
    setError('')
    setEditor({ block: b, date: b.block_date, start: timeToMin(b.start_time), length: timeToMin(b.end_time) - timeToMin(b.start_time) })
  }

  // ---------- writes ----------

  async function toggleDone(b) {
    if (readOnly || b.source) return
    const done = !b.done
    // On the way IN only, and before the round trip, the same as the dashboard's ticks.
    if (done) ping()
    const done_at = done ? new Date().toISOString() : null
    patchLocal(b.id, { done, done_at })
    try {
      await db.update(b.id, { done, done_at })
    } catch (e) {
      patchLocal(b.id, { done: b.done, done_at: b.done_at })
      setError(`Could not save that: ${e.message}`)
    }
  }

  async function saveDraft(d, scope) {
    const orig = editor?.block || null
    const fields = {
      block_date: d.date,
      start_time: minToTime(d.start),
      end_time: minToTime(d.start + d.length),
      module_id: d.module_id,
      kind: d.kind,
      label: d.label.trim().slice(0, 120),
      note: d.note.trim() || null,
    }
    setBusy(true)
    setError('')
    try {
      let message = ''
      if (scope === 'later' && orig?.series_id) {
        // Same weekday shift for every later row; times, subject, label and note copied across.
        const shift = dates.indexOf(d.date) - dates.indexOf(orig.block_date)
        const rows = await db.fetchSeries(orig.series_id, orig.block_date)
        const { block_date: _ignored, ...rest } = fields
        for (const r of rows) await db.update(r.id, { ...rest, block_date: addDays(r.block_date, shift) })
        message = `Changed ${rows.length} block${rows.length === 1 ? '' : 's'} in this series.`
      } else {
        // "Just this one", a plain edit, or a new block. Turning on repeat gives the row a new
        // series id and adds one row per later week (planner.js skips weeks already taken).
        const seriesId = d.repeat ? crypto.randomUUID() : null
        if (orig) await db.update(orig.id, d.repeat ? { ...fields, series_id: seriesId } : fields)
        else await db.insert([{ ...fields, series_id: seriesId }])
        if (d.repeat) {
          const existing = await db.fetchBlocks(addDays(d.date, 7), d.until)
          const rows = expandRepeat({ ...fields, block_date: d.date }, d.until, existing, seriesId, REPEAT_CAP)
          await db.insert(rows)
          let weeks = 0
          for (let x = addDays(d.date, 7); x <= d.until && weeks < REPEAT_CAP; x = addDays(x, 7)) weeks++
          const skipped = weeks - rows.length
          message = `Repeated for ${rows.length} more week${rows.length === 1 ? '' : 's'}` +
            (skipped > 0 ? `, skipped ${skipped} where that time was already taken.` : '.')
        }
      }
      setEditor(null)
      if (message) setNotice(message)
      // On a phone, follow a block that moved to another day, so she sees where it went.
      const i = dates.indexOf(d.date)
      if (i >= 0) setSelDay(i)
    } catch (e) {
      setError(`Could not save that: ${e.message}`)
    }
    await load(monday)
    setBusy(false)
  }

  async function deleteBlock(scope) {
    const orig = editor?.block
    if (!orig) return
    setBusy(true)
    setError('')
    try {
      const ids = scope === 'later' && orig.series_id
        ? (await db.fetchSeries(orig.series_id, orig.block_date)).map((r) => r.id)
        : [orig.id]
      await db.remove(ids)
      setEditor(null)
      if (ids.length > 1) setNotice(`Deleted ${ids.length} blocks.`)
    } catch (e) {
      setError(`Could not delete that: ${e.message}`)
    }
    await load(monday)
    setBusy(false)
  }

  function startSwap(b) {
    setEditor(null)
    setPick(b)
  }

  // Two UPDATEs. If the second fails, the first is put back, so she never ends up with both
  // blocks in one slot.
  async function choosePartner(b) {
    const a = pick
    if (!a || b.id === a.id || b.source) return
    const [a2, b2] = swapBlocks(a, b)
    const slot = (x) => ({ block_date: x.block_date, start_time: hm(x.start_time), end_time: hm(x.end_time) })
    setBusy(true)
    setError('')
    setPick(null)
    try {
      await db.update(a.id, slot(a2))
      try {
        await db.update(b.id, slot(b2))
        setNotice('Swapped.')
      } catch (e) {
        try {
          await db.update(a.id, slot(a))
          setError(`Could not swap those: ${e.message}. Nothing was changed.`)
        } catch (e2) {
          setError(`Could not swap those, and could not put the first block back: ${e2.message}. Check both blocks.`)
        }
      }
    } catch (e) {
      setError(`Could not swap those: ${e.message}`)
    }
    await load(monday)
    setBusy(false)
  }

  async function copyToNextWeek() {
    const next = addDays(monday, 7)
    setBusy(true)
    setError('')
    try {
      const target = await db.fetchBlocks(next, addDays(next, 6))
      const rows = copyWeek(blocks, next, target)
      await db.insert(rows)
      setNotice(rows.length
        ? `Copied ${rows.length} block${rows.length === 1 ? '' : 's'} into next week.`
        : 'Nothing new to copy: those times are already taken next week.')
      goWeek(next)
    } catch (e) {
      setError(`Could not copy the week: ${e.message}`)
    }
    setBusy(false)
  }

  async function clearWeek() {
    const ids = blocks.filter((b) => b.source == null).map((b) => b.id)
    setConfirmClear(false)
    setBusy(true)
    setError('')
    try {
      await db.remove(ids)
      setNotice(`Cleared ${ids.length} block${ids.length === 1 ? '' : 's'}.`)
    } catch (e) {
      setError(`Could not clear the week: ${e.message}`)
    }
    await load(monday)
    setBusy(false)
  }

  // ---------- render ----------

  const gridProps = {
    dates, today, blocks, markers, due, hours, modById, readOnly: readOnly || busy, pick,
    onEdit: openEdit, onTick: toggleDone, onAdd: openNew,
  }

  if (wall) {
    return (
      <div className="wk-wall" onClick={() => onExitWall && onExitWall()}>
        <div className="wk-wall-band">
          <div className="wk-side" aria-hidden="true">{rangeLabel(dates)}</div>
          {week
            ? <WeekGrid {...gridProps} wall />
            : <div className="muted" style={{ alignSelf: 'center' }}>{status === 'loading' ? 'Loading…' : 'No copy of this week to show.'}</div>}
        </div>
      </div>
    )
  }

  const userBlocks = blocks.filter((b) => b.source == null)

  return (
    <main className="wk-live max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <div className="wk-nav">
        <button className="icon-btn" aria-label="Previous week" onClick={() => goWeek(addDays(monday, -7))}>‹</button>
        <h1 className="wk-range">{rangeLabel(dates)}</h1>
        <button className="icon-btn" aria-label="Next week" onClick={() => goWeek(addDays(monday, 7))}>›</button>
        {monday !== thisMonday && (
          <button className="btn small ghost" onClick={() => goWeek(thisMonday)}>This week</button>
        )}
      </div>

      {status === 'offline' && (
        <div className="panel p-3 text-sm" style={{ borderColor: 'var(--gold)', color: 'var(--gold)' }}>
          {savedAt
            ? `Offline, showing the copy from ${savedAtLabel(savedAt)}. Editing is off until you are back online.`
            : 'Offline, and there is no saved copy of this week on this device yet.'}
        </div>
      )}
      {error && (
        <div className="panel p-3 text-sm" role="alert" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{error}</div>
      )}
      {notice && <div className="panel p-3 text-sm accent" role="status">{notice}</div>}
      {pick && (
        <div className="panel p-3 flex items-center gap-3 wk-pickbar" style={{ borderColor: 'var(--cyan)' }}>
          <span className="text-sm" style={{ flex: '1 1 0', minWidth: 0 }}>
            Tap the block to swap with <b>{blockTitle(pick, modById)}</b> ({hm(pick.start_time)}–{hm(pick.end_time)}).
          </span>
          <button className="btn small ghost" onClick={() => setPick(null)}>Cancel</button>
        </div>
      )}

      {status === 'loading' && !week && <p className="muted text-sm">Loading…</p>}

      {week && (isPhone
        ? <DayView {...gridProps} dayIdx={selDay} setDayIdx={setSelDay} onSwipe={stepDay} />
        : (
          <div className="wk-wrap">
            <div className="wk-side" aria-hidden="true">{rangeLabel(dates)}</div>
            <WeekGrid {...gridProps} />
          </div>
        ))}

      {week && (
        <div className="wk-tools">
          <button className="btn small ghost" disabled={readOnly || busy} onClick={copyToNextWeek}>Copy this week to next week</button>
          {!confirmClear
            ? <button className="btn small ghost" disabled={readOnly || busy || !userBlocks.length} onClick={() => setConfirmClear(true)}>Clear this week</button>
            : (
              <span className="wk-confirm">
                <span className="text-sm">Clear the {userBlocks.length} block{userBlocks.length === 1 ? '' : 's'} you made this week? This can't be undone.</span>
                <button className="btn small" style={{ borderColor: 'var(--red)', color: 'var(--red)' }} onClick={clearWeek}>Clear</button>
                <button className="btn small ghost" onClick={() => setConfirmClear(false)}>Keep</button>
              </span>
            )}
          <HoursPicker hours={hours} onChange={changeHours} />
          {!isPhone && onOpenWall && (
            <button className="btn small ghost" onClick={onOpenWall} title="Grid only, for a screenshot. Press F11, then PrtScn.">Wallpaper</button>
          )}
        </div>
      )}

      {editor && (
        <BlockEditor
          key={editor.block?.id || 'new'}
          init={editor} dates={dates} modules={chipModules} busy={busy}
          onSave={saveDraft} onDelete={deleteBlock} onSwap={startSwap}
          onClose={() => setEditor(null)}
        />
      )}
    </main>
  )
}

// ---------- visible hours (per device) ----------

function HoursPicker({ hours, onChange }) {
  const starts = []
  for (let h = 6; h <= 23; h++) starts.push(h)
  const ends = []
  for (let h = 7; h <= 24; h++) ends.push(h)
  const lbl = (h) => `${String(h).padStart(2, '0')}:00`
  return (
    <span className="wk-hours text-sm muted">
      Show
      <select className="input wk-select" aria-label="First hour shown" value={hours.start}
        onChange={(e) => {
          const start = Number(e.target.value)
          onChange({ start, end: Math.max(hours.end, start + 1) })
        }}>
        {starts.map((h) => <option key={h} value={h}>{lbl(h)}</option>)}
      </select>
      to
      <select className="input wk-select" aria-label="Last hour shown" value={hours.end}
        onChange={(e) => {
          const end = Number(e.target.value)
          onChange({ start: Math.min(hours.start, end - 1), end })
        }}>
        {ends.map((h) => <option key={h} value={h}>{lbl(h)}</option>)}
      </select>
    </span>
  )
}

// ---------- deadline chips ----------

function DueChips({ items, max }) {
  const shown = max ? items.slice(0, max) : items
  const rest = items.length - shown.length
  return (
    <>
      {shown.map((a) => {
        const c = a.modules?.colour || 'var(--cyan)'
        const upcoming = !a.status || a.status === 'upcoming'
        const doneMark = a.status === 'submitted' || a.status === 'graded'
        return (
          <span key={a.id} className={`wk-due${upcoming ? '' : ' done'}`} style={{ '--c': c }}
            title={`${a.modules?.code || ''} ${a.title} · due ${formatDue(a.due_date)}`}>
            {doneMark ? '✓ ' : ''}{a.modules?.code ? `${a.modules.code} ` : ''}{a.title}
          </span>
        )
      })}
      {rest > 0 && (
        <span className="wk-more" title={items.slice(shown.length).map((a) => `${a.modules?.code || ''} ${a.title}`).join('\n')}>
          + {rest} more
        </span>
      )}
    </>
  )
}

// ---------- wide grid (and the wallpaper) ----------

function WeekGrid({ dates, today, blocks, markers, due, hours, modById, readOnly, pick, onEdit, onTick, onAdd, wall = false }) {
  const startMin = hours.start * 60
  const endMin = hours.end * 60
  const nRows = (endMin - startMin) / 15
  const nHours = hours.end - hours.start
  const untimed = markers.filter((m) => m.untimed)
  const rowsTpl = `repeat(${nRows}, minmax(0, 1fr))`
  const bodyRow = wall ? 'minmax(0, 1fr)' : `${nRows * ROW_PX}px`
  const lineBg = { backgroundSize: `100% ${100 / nHours}%` }

  return (
    <div className="wk-grid" data-week-grid=""
      style={{ gridTemplateRows: `auto auto${untimed.length ? ' auto' : ''} ${bodyRow}` }}>
      <div className="wk-rl" />
      {dates.map((d, i) => (
        <div key={d} className={`wk-dh${!wall && d === today ? ' today' : ''}`}>
          {DAY_SHORT[i]} <small>{parseLocalDate(d).getDate()}</small>
        </div>
      ))}

      <div className="wk-rl">Due</div>
      {dates.map((d) => (
        <div key={d} className="wk-cell" data-due-date={d}><DueChips items={due[d] || []} max={2} /></div>
      ))}

      {untimed.length > 0 && <div className="wk-rl">Class</div>}
      {untimed.length > 0 && dates.map((d) => (
        <div key={d} className="wk-cell">
          {untimed.filter((m) => m.date === d).map((m) => (
            <span key={m.goal.id} className="wk-due wk-nwu-chip" style={{ '--c': m.goal.modules?.colour || 'var(--cyan)' }}
              title="NWU class, no time set">{m.goal.text}</span>
          ))}
        </div>
      ))}

      <div className="wk-times" style={{ gridTemplateRows: rowsTpl }} aria-hidden="true">
        {Array.from({ length: nHours }, (_, i) => (
          <span key={i} style={{ gridRow: `${1 + i * 4} / span 4` }}>{minToTime(startMin + i * 60)}</span>
        ))}
      </div>

      {dates.map((d) => {
        const items = withLanes([
          ...blocks.filter((b) => b.block_date === d)
            .map((b) => ({ key: b.id, b, s: timeToMin(b.start_time), e: timeToMin(b.end_time) })),
          ...markers.filter((m) => m.date === d && !m.untimed)
            .map((m) => ({ key: `nwu-${m.goal.id}`, m, s: m.start, e: m.end })),
        ])
        const onBg = (e) => {
          if (wall || readOnly || e.target !== e.currentTarget) return
          const r = e.currentTarget.getBoundingClientRect()
          const row = Math.min(nRows - 1, Math.max(0, Math.floor((e.clientY - r.top) / (r.height / nRows))))
          onAdd(d, startMin + row * 15)
        }
        return (
          <div key={d} className={`wk-col${!wall && d === today ? ' today' : ''}`} data-date={d}
            style={{ gridTemplateRows: rowsTpl, ...lineBg }} onClick={onBg}
            title={wall || readOnly ? undefined : 'Tap an empty spot to add a block'}>
            {items.map((it) => {
              const place = gridRows(it.b || markerAsBlock(it.m), startMin, endMin)
              if (!place) return null
              const style = {
                gridRow: `${place.rowStart} / ${place.rowEnd}`,
                width: `calc(${100 / it.lanes}% - 2px)`,
                marginLeft: `${(100 * it.lane) / it.lanes}%`,
              }
              if (it.m) {
                return (
                  <div key={it.key} className="wk-b nwu" data-nwu-class=""
                    style={{ ...style, '--c': it.m.goal.modules?.colour || 'var(--cyan)' }}
                    title={`NWU class · ${minToTime(it.m.start)}`}>
                    <span className="l">{it.m.goal.text}</span>
                    <span className="t">{minToTime(it.m.start)}</span>
                  </div>
                )
              }
              const b = it.b
              const locked = !!b.source
              const title = blockTitle(b, modById)
              const cls = ['wk-b']
              if (b.done) cls.push('done')
              if (locked) cls.push('locked')
              if (pick && pick.id === b.id) cls.push('picking')
              const interactive = !wall && !readOnly && !locked
              return (
                <div key={it.key} className={cls.join(' ')} data-block-id={b.id} data-locked={locked ? '1' : undefined}
                  style={{ ...style, '--c': blockColour(b, modById) }}
                  role={interactive ? 'button' : undefined} tabIndex={interactive ? 0 : undefined}
                  onClick={interactive ? () => onEdit(b) : undefined}
                  onKeyDown={interactive ? (e) => { if (e.key === 'Enter') onEdit(b) } : undefined}
                  title={`${title} · ${hm(b.start_time)}–${hm(b.end_time)}${locked ? ' · from the tutoring timetable, locked' : ''}`}>
                  <span className="l">{locked && <span className="wk-lock" aria-label="Locked">🔒</span>}{title}</span>
                  <span className="t">{hm(b.start_time)}–{hm(b.end_time)}</span>
                  {!wall && !locked && (
                    <button className="wk-b-tick" disabled={readOnly}
                      aria-label={b.done ? `Mark not done: ${title}` : `Mark done: ${title}`}
                      onClick={(e) => { e.stopPropagation(); onTick(b) }}>✓</button>
                  )}
                  {wall && b.done && <span className="wk-b-done" aria-label="Done">✓</span>}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ---------- phone: one day at a time ----------

function DayView({ dates, today, blocks, markers, due, hours, modById, readOnly, pick, onEdit, onTick, onAdd, dayIdx, setDayIdx, onSwipe }) {
  const date = dates[dayIdx]
  const startMin = hours.start * 60
  const endMin = hours.end * 60
  const dayBlocks = blocks.filter((b) => b.block_date === date)
  const dayMarkers = markers.filter((m) => m.date === date)
  const timed = dayMarkers.filter((m) => !m.untimed)
  const untimed = dayMarkers.filter((m) => m.untimed)
  const gaps = readOnly || pick ? [] : freeGaps([...dayBlocks, ...timed.map(markerAsBlock)], startMin, endMin)
  const d = parseLocalDate(date)

  const rows = [
    ...dayBlocks.map((b) => ({ type: 'block', s: timeToMin(b.start_time), b })),
    ...timed.map((m) => ({ type: 'nwu', s: m.start, m })),
    ...gaps.map((g) => ({ type: 'gap', s: g.start, g })),
  ].sort((x, y) => x.s - y.s || (x.type === 'gap') - (y.type === 'gap'))

  const touch = useRef(null)
  const onTouchStart = (e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY } }
  const onTouchEnd = (e) => {
    if (!touch.current) return
    const dx = e.changedTouches[0].clientX - touch.current.x
    const dy = e.changedTouches[0].clientY - touch.current.y
    touch.current = null
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) onSwipe(dx < 0 ? 1 : -1)
  }

  return (
    <div className="space-y-3">
      <div className="wk-tabs" role="tablist" aria-label="Days of this week">
        {dates.map((x, i) => {
          const cls = ['wk-tab']
          if (i === dayIdx) cls.push('sel')
          if (x === today) cls.push('today')
          if (blocks.some((b) => b.block_date === x)) cls.push('has')
          return (
            <button key={x} className={cls.join(' ')} role="tab" aria-selected={i === dayIdx}
              aria-label={`${DAY_LONG[i]} ${parseLocalDate(x).getDate()}`} onClick={() => setDayIdx(i)}>
              <b>{DAY_SHORT[i]}</b><span>{parseLocalDate(x).getDate()}</span>
            </button>
          )
        })}
      </div>

      {(due[date] || []).length > 0 && (
        <div className="wk-duebar" data-due-date={date}>
          <span className="section-label">Due {formatDue(date)}</span>
          <div className="wk-duelist"><DueChips items={due[date]} /></div>
        </div>
      )}

      <div className="wk-list" data-day-list={date} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <p className="wk-dayhead">{DAY_LONG[dayIdx]} {d.getDate()} {MONTHS[d.getMonth()]}</p>
        {untimed.map((m) => (
          <div key={m.goal.id} className="wk-item nwu" data-nwu-class="" style={{ '--c': m.goal.modules?.colour || 'var(--cyan)' }}>
            <div className="wk-item-time">No time</div>
            <div className="wk-item-body"><span className="l">{m.goal.text}</span><small>NWU class</small></div>
          </div>
        ))}
        {rows.map((r) => {
          if (r.type === 'gap') {
            return (
              <button key={`gap-${r.g.start}`} className="wk-gap" data-gap={`${minToTime(r.g.start)}-${minToTime(r.g.end)}`}
                onClick={() => onAdd(date, r.g.start, r.g.end)}>
                + {minToTime(r.g.start)}–{minToTime(r.g.end)} free
              </button>
            )
          }
          if (r.type === 'nwu') {
            return (
              <div key={`nwu-${r.m.goal.id}`} className="wk-item nwu" data-nwu-class="" style={{ '--c': r.m.goal.modules?.colour || 'var(--cyan)' }}>
                <div className="wk-item-time">{minToTime(r.m.start)}<br />{minToTime(r.m.end)}</div>
                <div className="wk-item-body"><span className="l">{r.m.goal.text}</span><small>NWU class</small></div>
              </div>
            )
          }
          const b = r.b
          const locked = !!b.source
          const title = blockTitle(b, modById)
          const cls = ['wk-item']
          if (b.done) cls.push('done')
          if (locked) cls.push('locked')
          if (pick && pick.id === b.id) cls.push('picking')
          const code = b.module_id && modById[b.module_id]?.code
          const sub = [code && b.label ? code : null, b.kind !== 'study' && b.kind !== 'class' ? KIND_NAME[b.kind] : null, b.note]
            .filter(Boolean).join(' · ')
          const body = (
            <>
              <span className="l">{locked && <span className="wk-lock" aria-label="Locked">🔒</span>}{title}</span>
              {(sub || locked) && <small>{locked ? 'From the tutoring timetable' : sub}</small>}
            </>
          )
          return (
            <div key={b.id} className={cls.join(' ')} data-block-id={b.id} data-locked={locked ? '1' : undefined}
              style={{ '--c': blockColour(b, modById) }}>
              <div className="wk-item-time">{hm(b.start_time)}<br />{hm(b.end_time)}</div>
              {locked
                ? <div className="wk-item-body">{body}</div>
                : (
                  <button className="wk-item-body" disabled={readOnly || (pick && pick.id === b.id)}
                    aria-label={pick ? `Swap with ${title}` : `Edit ${title}, ${hm(b.start_time)} to ${hm(b.end_time)}`}
                    onClick={() => onEdit(b)}>{body}</button>
                )}
              {!locked && (
                <button className="wk-tick" disabled={readOnly}
                  aria-label={b.done ? `Mark not done: ${title}` : `Mark done: ${title}`}
                  onClick={() => onTick(b)}>✓</button>
              )}
            </div>
          )
        })}
        {!rows.length && !untimed.length && <p className="muted text-sm">Nothing planned.</p>}
      </div>
    </div>
  )
}

// ---------- the editor sheet ----------

function BlockEditor({ init, dates, modules, busy, onSave, onDelete, onSwap, onClose }) {
  const orig = init.block
  const initialChip = orig
    ? (orig.module_id ? `m:${orig.module_id}` : KIND_CHIPS.some((k) => k.kind === orig.kind) ? `k:${orig.kind}` : '')
    : ''
  const [date, setDate] = useState(init.date)
  const [start, setStart] = useState(init.start)
  const [length, setLength] = useState(init.length)
  const [chip, setChip] = useState(initialChip)
  const [label, setLabel] = useState(orig?.label || '')
  const [note, setNote] = useState(orig?.note || '')
  const [repeat, setRepeat] = useState(false)
  const [until, setUntil] = useState(addDays(init.date, 7 * REPEAT_WEEKS))
  const [ask, setAsk] = useState(null)          // 'save' | 'delete': the series question
  const [armDelete, setArmDelete] = useState(false)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const starts = []
  for (let m = 6 * 60; m < 24 * 60; m += 15) starts.push(m)
  if (!starts.includes(start)) starts.unshift(start)
  const lengths = []
  for (let m = 15; m <= 8 * 60 && start + m <= 24 * 60; m += 15) lengths.push(m)
  if (!lengths.includes(length)) lengths.push(length)
  const lengthOk = start + length <= 24 * 60

  const minUntil = addDays(date, 7)
  const maxUntil = addDays(date, 7 * REPEAT_CAP)
  const canRepeat = !orig || !orig.series_id

  function draft() {
    let kind = 'study'
    let module_id = null
    if (chip.startsWith('m:')) module_id = chip.slice(2)
    else if (chip.startsWith('k:')) kind = chip.slice(2)
    const u = until < minUntil ? minUntil : until > maxUntil ? maxUntil : until
    return { date, start, length, kind, module_id, label, note, repeat: canRepeat && repeat, until: u }
  }

  function submit(scope) {
    if (!lengthOk) return
    if (orig?.series_id && !scope) { setAsk('save'); return }
    onSave(draft(), scope)
  }

  function del(scope) {
    if (orig?.series_id && !scope) { setAsk('delete'); return }
    if (!orig?.series_id && !armDelete) { setArmDelete(true); return }
    onDelete(scope)
  }

  const whenLabel = (() => {
    const i = dates.indexOf(date)
    const d = parseLocalDate(date)
    return `${i >= 0 ? DAY_LONG[i] : ''} ${d.getDate()} ${MONTHS[d.getMonth()]} · ${minToTime(start)}–${minToTime(start + length)}`
  })()

  return (
    <div className="overlay wk-sheet-back" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="system wk-sheet" role="dialog" aria-modal="true" aria-label={orig ? 'Edit block' : 'New block'}>
        <div className="kicker">{orig ? 'Edit block' : 'New block'}</div>
        <div className="display" style={{ color: 'var(--cyan)', fontSize: 16, marginTop: 4 }}>{whenLabel}</div>

        {ask ? (
          <div className="space-y-3 mt-4">
            <p>This block repeats every week. {ask === 'save' ? 'Change' : 'Delete'} just this one, or this one and the later ones?</p>
            <div className="wk-sheet-btns">
              <button className="btn small" disabled={busy}
                onClick={() => (ask === 'save' ? onSave(draft(), 'one') : onDelete('one'))}>Just this one</button>
              <button className="btn small" disabled={busy}
                onClick={() => (ask === 'save' ? onSave(draft(), 'later') : onDelete('later'))}>This and later ones</button>
              <button className="btn small ghost" onClick={() => setAsk(null)}>Back</button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 mt-4">
            <div className="field">
              <label>Day</label>
              <div className="wk-chips">
                {dates.map((x, i) => (
                  <button key={x} type="button" className={`wk-chip${x === date ? ' sel' : ''}`} style={{ '--c': 'var(--cyan)' }}
                    aria-pressed={x === date} onClick={() => setDate(x)}>
                    {DAY_SHORT[i]} {parseLocalDate(x).getDate()}
                  </button>
                ))}
              </div>
            </div>

            <div className="wk-two">
              <div className="field">
                <label htmlFor="wk-start">Start</label>
                <select id="wk-start" className="input" value={start} onChange={(e) => setStart(Number(e.target.value))}>
                  {starts.map((m) => <option key={m} value={m}>{minToTime(m)}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="wk-length">Length</label>
                <select id="wk-length" className="input" value={length} onChange={(e) => setLength(Number(e.target.value))}>
                  {lengths.map((m) => <option key={m} value={m}>{lengthLabel(m)}</option>)}
                </select>
              </div>
            </div>
            {!lengthOk && <p className="text-sm" style={{ color: 'var(--red)' }}>That runs past midnight. Pick a shorter length.</p>}

            <div className="field">
              <label>Subject</label>
              <div className="wk-chips">
                {modules.map((m) => {
                  const v = `m:${m.id}`
                  return (
                    <button key={m.id} type="button" className={`wk-chip${chip === v ? ' sel' : ''}`}
                      style={{ '--c': m.colour || 'var(--cyan)' }} aria-pressed={chip === v}
                      onClick={() => setChip(chip === v ? '' : v)}>{m.code}</button>
                  )
                })}
                {KIND_CHIPS.map((k) => {
                  const v = `k:${k.kind}`
                  return (
                    <button key={k.kind} type="button" className={`wk-chip${chip === v ? ' sel' : ''}`}
                      style={{ '--c': k.colour }} aria-pressed={chip === v}
                      onClick={() => setChip(chip === v ? '' : v)}>{k.name}</button>
                  )
                })}
              </div>
            </div>

            <div className="field">
              <label htmlFor="wk-label">What's the plan?</label>
              <input id="wk-label" className="input" maxLength={120} value={label}
                placeholder="e.g. Chapter 3 summary" onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />
            </div>

            <div className="field">
              <label htmlFor="wk-note">Note (optional)</label>
              <textarea id="wk-note" className="input" rows={2} value={note}
                placeholder="e.g. swapped because I was tired" onChange={(e) => setNote(e.target.value)} />
            </div>

            {canRepeat && (
              <div className="wk-repeat">
                <label className="wk-check">
                  <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
                  Repeat every week until
                </label>
                <input type="date" className="input wk-date" aria-label="Repeat until" disabled={!repeat}
                  min={minUntil} max={maxUntil} value={until} onChange={(e) => setUntil(e.target.value || until)} />
              </div>
            )}
            {orig?.series_id && <p className="text-sm muted">This block repeats every week.</p>}

            <div className="wk-sheet-btns">
              <button className="btn small green" disabled={busy || !lengthOk} onClick={() => submit()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
              <button className="btn small ghost" onClick={onClose}>Cancel</button>
            </div>
            {orig && (
              <div className="wk-sheet-btns">
                <button className="btn small ghost" disabled={busy} onClick={() => onSwap(orig)}>Swap with…</button>
                <button className="btn small ghost" disabled={busy} onClick={() => del()}
                  style={armDelete ? { borderColor: 'var(--red)', color: 'var(--red)' } : undefined}>
                  {armDelete ? 'Tap again to delete' : 'Delete'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
