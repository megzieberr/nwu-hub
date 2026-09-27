import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ping } from './lib/ping'
import { formatDue } from './lib/week'
import {
  localDateStr, parseLocalDate, addDays, mondayOf, weekDates, minToTime, timeToMin,
  expandRepeat, swapBlocks, copyWeek, classMarkersForWeek, hourBoxes, isWholeHours, isHardDeadline,
} from './lib/planner.js'

// The Week tab (sunday-planner/PLAN-week-tab.md, unit 4): her week as an hour-box grid, the same
// look as the study planner, saving to plan_blocks exactly as before. Three faces of ONE component:
//   • wide screen  : TIME | MON .. SUN, one box per hour per day;
//   • phone (<760) : one day at a time, day tabs plus swipe, the same hour boxes top to bottom;
//   • wallpaper    : the grid only, for a 1920x1080 screenshot.
//
// Which rows sit in which box, and every date/repeat/swap/copy decision, comes from lib/planner.js
// (tested there). All reads and writes go through the `data` prop (lib/plannerData.js): the live
// Supabase layer, or the in-memory demo layer on the dev-only #week-demo route.

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
const LOCKED_COLOUR = 'var(--purple)'   // classes copied in from the tutoring scheduler
const FIXED_COLOUR = 'var(--red)'       // hard deadlines (ww:own: rows)
const REPEAT_WEEKS = 6                  // default "repeat every week until": 6 weeks ahead
const REPEAT_CAP = 26
const MAX_LENGTH_H = 8

// ---------- small helpers (formatting only; the logic lives in planner.js) ----------

const pad = (n) => String(n).padStart(2, '0')
const hm = (t) => String(t || '').slice(0, 5)
const hourLabel = (h) => `${pad(h)}:00 - ${pad(h + 1 === 24 ? 0 : h + 1)}:00`
const timeRange = (b) => `${hm(b.start_time)} - ${hm(b.end_time)}`

function rangeLabel(dates) {
  const a = parseLocalDate(dates[0])
  const b = parseLocalDate(dates[6])
  return `${a.getDate()} ${MONTHS[a.getMonth()]} - ${b.getDate()} ${MONTHS[b.getMonth()]}`
}

function dayLabel(date, dates) {
  const i = dates ? dates.indexOf(date) : -1
  const d = parseLocalDate(date)
  const name = i >= 0 ? DAY_LONG[i] : DAY_LONG[(d.getDay() + 6) % 7]
  return `${name} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

function lengthLabel(min) {
  if (min % 60 === 0) return min === 60 ? '1 hour' : `${min / 60} hours`
  const h = Math.floor(min / 60)
  const m = min % 60
  return h ? `${h} h ${m} min` : `${m} min`
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
  return { start: 6, end: 22 }
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

// The current hour, refreshed every minute, for the "now" outline.
function useNowHour() {
  const [h, setH] = useState(() => new Date().getHours())
  useEffect(() => {
    const t = setInterval(() => setH(new Date().getHours()), 60 * 1000)
    return () => clearInterval(t)
  }, [])
  return h
}

// 'own' (hers, editable), 'locked' (a class from the scheduler), 'fixed' (a hard deadline).
function rowType(b) {
  if (b.source == null) return 'own'
  return isHardDeadline(b) ? 'fixed' : 'locked'
}

function blockColour(b, modById) {
  const t = rowType(b)
  if (t === 'fixed') return FIXED_COLOUR
  if (t === 'locked') return LOCKED_COLOUR
  const m = b.module_id && modById[b.module_id]
  if (m && m.colour) return m.colour
  const k = KIND_CHIPS.find((x) => x.kind === b.kind)
  return k ? k.colour : STUDY_COLOUR
}

function blockTitle(b, modById) {
  return b.label || (b.module_id && modById[b.module_id]?.code) || KIND_NAME[b.kind] || 'Study'
}

// "MATH101" or "Prep" or "Study": the module or kind line in the detail panel.
function subjectLine(b, modById) {
  const m = b.module_id && modById[b.module_id]
  if (m) return m.title && m.title !== m.code ? `${m.code}, ${m.title}` : m.code
  return KIND_NAME[b.kind] || 'Study'
}

// =================================================================================================

export default function WeekPlanner({ data: db, cacheId = null, wall = false, onOpenWall, onExitWall }) {
  const today = useMemo(() => localDateStr(new Date()), [])
  const nowH = useNowHour()
  const [monday, setMonday] = useState(() => mondayOf(today))
  const dates = useMemo(() => weekDates(monday), [monday])
  const [selDay, setSelDay] = useState(() => Math.max(0, weekDates(mondayOf(today)).indexOf(today)))
  const [hours, setHours] = useState(readHours)
  const [week, setWeek] = useState(null)             // { blocks, goals, modules }
  const [status, setStatus] = useState('loading')    // loading | ok | offline
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // The panel: { mode: 'view' | 'edit' | 'locked', block|null, date, start, length }
  const [sheet, setSheet] = useState(null)
  const [pick, setPick] = useState(null)             // the block waiting for its swap partner
  const [hot, setHot] = useState(null)               // 'date|hour' of the box last tapped
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

  // Keep the saved copy in step with local changes (a tick) once the week is live.
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
  const readOnly = status !== 'ok'
  const thisMonday = mondayOf(today)

  // Every day's rows (her blocks, locked rows, timed NWU class markers) sorted into hour boxes.
  const boxesByDate = useMemo(() => {
    const out = {}
    for (const d of dates) {
      const rows = [
        ...blocks.filter((b) => b.block_date === d).map((b) => ({
          key: b.id, id: b.id, type: rowType(b), b, label: blockTitle(b, modById), colour: blockColour(b, modById),
          start_time: b.start_time, end_time: b.end_time,
        })),
        ...markers.filter((m) => m.date === d && !m.untimed).map((m) => ({
          key: `nwu-${m.goal.id}`, id: `nwu-${m.goal.id}`, type: 'nwu', m, label: m.goal.text,
          start_time: minToTime(m.start), end_time: minToTime(m.end),
        })),
      ]
      out[d] = hourBoxes(rows, hours.start, hours.end)
    }
    return out
  }, [blocks, markers, dates, hours, modById])

  const untimedByDate = useMemo(() => {
    const out = {}
    for (const d of dates) out[d] = markers.filter((m) => m.date === d && m.untimed)
    return out
  }, [markers, dates])

  // The panel always shows the live copy of its block (so a tick shows at once).
  const liveBlock = sheet?.block ? (blocks.find((x) => x.id === sheet.block.id) || sheet.block) : null

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

  function closeSheet() {
    setSheet(null)
    setHot(null)
  }

  // Tap an empty hour box: a new block on that day and hour, one hour long.
  function openNew(date, hour) {
    if (readOnly || busy || pick) return
    setError('')
    setSheet({ mode: 'edit', block: null, date, start: hour * 60, length: 60 })
  }

  // Tap a block: see what it entails. In swap mode, the tap picks the partner instead.
  function openItem(b) {
    if (pick) { choosePartner(b); return }
    setError('')
    setSheet({ mode: b.source ? 'locked' : 'view', block: b })
  }

  function openEdit(b) {
    if (readOnly || b.source) return
    setSheet({
      mode: 'edit', block: b, date: b.block_date,
      start: timeToMin(b.start_time), length: timeToMin(b.end_time) - timeToMin(b.start_time),
    })
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
    const orig = sheet?.block || null
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
      closeSheet()
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
    const orig = sheet?.block
    if (!orig) return
    setBusy(true)
    setError('')
    try {
      const ids = scope === 'later' && orig.series_id
        ? (await db.fetchSeries(orig.series_id, orig.block_date)).map((r) => r.id)
        : [orig.id]
      await db.remove(ids)
      closeSheet()
      if (ids.length > 1) setNotice(`Deleted ${ids.length} blocks.`)
    } catch (e) {
      setError(`Could not delete that: ${e.message}`)
    }
    await load(monday)
    setBusy(false)
  }

  function startSwap(b) {
    closeSheet()
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
    setHot(null)
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
    dates, today, nowH, hours, boxesByDate, untimedByDate, readOnly: readOnly || busy, pick, hot,
    onItem: openItem, onAdd: openNew, onHot: setHot,
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
            Tap the block to swap with <b>{blockTitle(pick, modById)}</b> ({timeRange(pick)}).
          </span>
          <button className="btn small ghost" onClick={() => setPick(null)}>Cancel</button>
        </div>
      )}

      {status === 'loading' && !week && <p className="muted text-sm">Loading…</p>}

      {week && (isPhone
        ? <DayView {...gridProps} blocks={blocks} dayIdx={selDay} setDayIdx={setSelDay} onSwipe={stepDay} />
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

      {sheet && sheet.mode === 'edit' && (
        <BlockEditor
          key={`edit-${sheet.block?.id || 'new'}`}
          init={sheet} dates={dates} modules={chipModules} busy={busy}
          onSave={saveDraft}
          onCancel={() => (sheet.block ? setSheet({ mode: 'view', block: sheet.block }) : closeSheet())}
          onClose={closeSheet}
        />
      )}
      {sheet && sheet.mode === 'view' && liveBlock && (
        <BlockView
          key={`view-${liveBlock.id}`}
          block={liveBlock} dates={dates} modById={modById} busy={busy} readOnly={readOnly}
          onTick={toggleDone} onEdit={openEdit} onDelete={deleteBlock} onSwap={startSwap} onClose={closeSheet}
        />
      )}
      {sheet && sheet.mode === 'locked' && liveBlock && (
        <LockedView block={liveBlock} dates={dates} modById={modById} onClose={closeSheet} />
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
  const lbl = (h) => `${pad(h)}:00`
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

// ---------- one hour box (all three faces) ----------

// Everything in the box is shown, stacked; nothing is ever folded away. Her blocks, locked
// classes and hard deadlines are each their own tap target. NWU class markers are thin read-only
// tags; a box holding only those (or nothing) is itself the tap target for a new block.
function HourBox({ date, dayIdx, h, items, isNow, hot, readOnly, pick, wall, onItem, onAdd, onHot }) {
  const rows = items.filter((it) => it.type !== 'nwu')
  const addable = !wall && !readOnly && !pick && rows.length === 0
  const key = `${date}|${h}`
  const cls = ['slot']
  if (!items.length) cls.push('empty')
  if (isNow && !wall) cls.push('now')
  if (hot === key && !wall) cls.push('hot')
  const d = parseLocalDate(date)
  return (
    <div className={cls.join(' ')} data-date={date} data-hour={h}
      role={addable ? 'button' : undefined} tabIndex={addable ? 0 : undefined}
      aria-label={addable ? `${DAY_LONG[dayIdx]} ${d.getDate()}, ${hourLabel(h)}: add a block` : undefined}
      onPointerDown={wall ? undefined : () => onHot(key)}
      onClick={addable ? () => onAdd(date, h) : undefined}
      onKeyDown={addable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(date, h) } } : undefined}>
      {items.map((it) => (
        it.type === 'nwu'
          ? (
            <span key={it.key} className="slot-nwu" data-nwu-class="" style={{ '--c': it.m.goal.modules?.colour || 'var(--cyan)' }}
              title={`NWU class, ${timeRange(it)}`}>
              {it.label}{!isWholeHours(it) && <small> {timeRange(it)}</small>}
            </span>
          )
          : <BoxItem key={it.key} it={it} wall={wall} pick={pick} onItem={onItem} />
      ))}
      {addable && <span className={`slot-plus${items.length ? ' side' : ''}`} aria-hidden="true">+</span>}
    </div>
  )
}

function BoxItem({ it, wall, pick, onItem }) {
  const b = it.b
  const cls = ['slot-item', it.type]
  if (it.type === 'own' && b.done) cls.push('done')
  if (pick && pick.id === b.id) cls.push('picking')
  const odd = !isWholeHours(b)
  const inner = (
    <>
      {it.type === 'fixed' && <span className="slot-tag">FIXED</span>}
      <span className="slot-l">{it.type === 'locked' && <span className="wk-lock" aria-hidden="true">🔒</span>}{it.label}</span>
      {odd && <small className="slot-t">{timeRange(b)}</small>}
    </>
  )
  const style = { '--c': it.colour }
  if (wall) return <div className={cls.join(' ')} style={style}>{inner}</div>
  const what = it.type === 'fixed' ? 'Fixed deadline' : it.type === 'locked' ? 'Class, locked' : pick ? 'Swap with' : 'Open'
  return (
    <button type="button" className={cls.join(' ')} style={style}
      data-block-id={b.id} data-kind={it.type}
      disabled={!!pick && (it.type !== 'own' || pick.id === b.id)}
      aria-label={`${what}: ${it.label}, ${timeRange(b)}${b.done ? ', done' : ''}`}
      onClick={(e) => { e.stopPropagation(); onItem(b) }}>
      {inner}
    </button>
  )
}

// ---------- wide grid (and the wallpaper) ----------

function WeekGrid({ dates, today, nowH, hours, boxesByDate, untimedByDate, readOnly, pick, hot, onItem, onAdd, onHot, wall = false }) {
  const hourList = []
  for (let h = hours.start; h < hours.end; h++) hourList.push(h)
  const anyUntimed = dates.some((d) => untimedByDate[d].length)
  const rowTpl = wall ? 'minmax(0, 1fr)' : 'minmax(38px, auto)'
  return (
    <div className="wk-grid" data-week-grid=""
      style={{ gridTemplateRows: `auto${anyUntimed ? ' auto' : ''} repeat(${hourList.length}, ${rowTpl})` }}>
      <div className="wk-gh">TIME</div>
      {dates.map((d, i) => (
        <div key={d} className={`wk-gh${!wall && d === today ? ' today' : ''}`} data-day-head={d}>
          {DAY_SHORT[i].toUpperCase()} <small>{parseLocalDate(d).getDate()}</small>
        </div>
      ))}

      {anyUntimed && <div className="wk-gt slim">No time set</div>}
      {anyUntimed && dates.map((d) => (
        <div key={d} className="slot-notime" data-notime={d}>
          {untimedByDate[d].map((m) => (
            <span key={m.goal.id} className="slot-nwu" data-nwu-class="" style={{ '--c': m.goal.modules?.colour || 'var(--cyan)' }}
              title="NWU class, no time set">{m.goal.text}</span>
          ))}
        </div>
      ))}

      {hourList.map((h) => (
        <Fragment key={h}>
          <div className="wk-gt">{hourLabel(h)}</div>
          {dates.map((d, i) => (
            <HourBox key={d} date={d} dayIdx={i} h={h} items={boxesByDate[d][h] || []}
              isNow={d === today && h === nowH} hot={hot} readOnly={readOnly} pick={pick} wall={wall}
              onItem={onItem} onAdd={onAdd} onHot={onHot} />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

// ---------- phone: one day at a time ----------

function DayView({ dates, today, nowH, hours, boxesByDate, untimedByDate, blocks, readOnly, pick, hot, onItem, onAdd, onHot, dayIdx, setDayIdx, onSwipe }) {
  const date = dates[dayIdx]
  const d = parseLocalDate(date)
  const untimed = untimedByDate[date] || []
  const hourList = []
  for (let h = hours.start; h < hours.end; h++) hourList.push(h)

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
              <b>{DAY_SHORT[i].toUpperCase()}</b><span>{parseLocalDate(x).getDate()}</span>
            </button>
          )
        })}
      </div>

      <div className="wk-list" data-day-list={date} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <p className="wk-dayhead">{DAY_LONG[dayIdx]} {d.getDate()} {MONTHS[d.getMonth()]}</p>
        {untimed.length > 0 && (
          <div className="wk-row">
            <div className="wk-t slim">No time set</div>
            <div className="slot-notime" data-notime={date}>
              {untimed.map((m) => (
                <span key={m.goal.id} className="slot-nwu" data-nwu-class="" style={{ '--c': m.goal.modules?.colour || 'var(--cyan)' }}
                  title="NWU class, no time set">{m.goal.text}</span>
              ))}
            </div>
          </div>
        )}
        {hourList.map((h) => (
          <div className="wk-row" key={h}>
            <div className="wk-t">{hourLabel(h)}</div>
            <HourBox date={date} dayIdx={dayIdx} h={h} items={boxesByDate[date][h] || []}
              isNow={date === today && h === nowH} hot={hot} readOnly={readOnly} pick={pick}
              onItem={onItem} onAdd={onAdd} onHot={onHot} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- panels (a hub .overlay/.system panel; a bottom sheet on a phone) ----------

function Sheet({ label, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay wk-sheet-back" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="system wk-sheet" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  )
}

// Tap a block of hers: what it entails, the tick, and Edit / Swap / Delete.
function BlockView({ block: b, dates, modById, busy, readOnly, onTick, onEdit, onDelete, onSwap, onClose }) {
  const [ask, setAsk] = useState(false)          // the "just this one / later ones" question
  const [armDelete, setArmDelete] = useState(false)
  const title = blockTitle(b, modById)
  const off = busy || readOnly

  function del(scope) {
    if (b.series_id && !scope) { setAsk(true); return }
    if (!b.series_id && !armDelete) { setArmDelete(true); return }
    onDelete(scope)
  }

  return (
    <Sheet label={`Block: ${title}`} onClose={onClose}>
      <div className="kicker">Block</div>
      <div className="display wk-sheet-title" style={{ '--c': blockColour(b, modById) }}>{title}</div>
      <dl className="wk-facts">
        <dt>Subject</dt><dd>{subjectLine(b, modById)}</dd>
        <dt>Day</dt><dd>{dayLabel(b.block_date, dates)}</dd>
        <dt>Time</dt><dd>{timeRange(b)}</dd>
        {b.note && <><dt>Note</dt><dd className="wk-note">{b.note}</dd></>}
        {b.series_id && <><dt>Repeats</dt><dd>Every week</dd></>}
      </dl>

      {ask ? (
        <div className="space-y-3 mt-4">
          <p>This block repeats every week. Delete just this one, or this one and the later ones?</p>
          <div className="wk-sheet-btns">
            <button className="btn small" disabled={busy} onClick={() => onDelete('one')}>Just this one</button>
            <button className="btn small" disabled={busy} onClick={() => onDelete('later')}>This and later ones</button>
            <button className="btn small ghost" onClick={() => setAsk(false)}>Back</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 mt-4">
          <button className={`btn wk-done-btn${b.done ? ' green' : ''}`} disabled={off} aria-pressed={!!b.done}
            onClick={() => onTick(b)}>
            {b.done ? '✓ Done (tap to undo)' : 'Mark done'}
          </button>
          <div className="wk-sheet-btns">
            <button className="btn small" disabled={off} onClick={() => onEdit(b)}>Edit</button>
            <button className="btn small ghost" disabled={off} onClick={() => onSwap(b)}>Swap with…</button>
            <button className="btn small ghost" disabled={off} onClick={() => del()}
              style={armDelete ? { borderColor: 'var(--red)', color: 'var(--red)' } : undefined}>
              {armDelete ? 'Tap again to delete' : 'Delete'}
            </button>
          </div>
          <div className="wk-sheet-btns">
            <button className="btn small ghost" onClick={onClose}>Close</button>
          </div>
          {readOnly && <p className="text-sm muted">Offline: editing is off until you are back online.</p>}
        </div>
      )}
    </Sheet>
  )
}

// A locked row (a class from the tutoring timetable, or a hard deadline): read only.
function LockedView({ block: b, dates, modById, onClose }) {
  const fixed = isHardDeadline(b)
  const title = blockTitle(b, modById)
  return (
    <Sheet label={`${fixed ? 'Fixed' : 'Class'}: ${title}`} onClose={onClose}>
      <div className="kicker">{fixed ? 'Hard deadline' : 'Class'}</div>
      <div className="display wk-sheet-title" style={{ '--c': fixed ? FIXED_COLOUR : LOCKED_COLOUR }}>
        {fixed && <span className="slot-tag">FIXED</span>} {title}
      </div>
      <dl className="wk-facts">
        <dt>What</dt>
        <dd>{fixed
          ? 'A fixed appointment: it has to happen on this day, at this time.'
          : 'A class from your tutoring timetable.'}</dd>
        <dt>Day</dt><dd>{dayLabel(b.block_date, dates)}</dd>
        <dt>Time</dt><dd>{timeRange(b)}</dd>
      </dl>
      <p className="text-sm muted mt-3">Locked: it comes from your timetable, so it can't be changed here.</p>
      <div className="wk-sheet-btns mt-4">
        <button className="btn small ghost" onClick={onClose}>Close</button>
      </div>
    </Sheet>
  )
}

// New block, or Edit from the view panel. Her own blocks are whole hours: a start hour and a
// length in hours. A block saved before with odd times keeps them unless she picks new ones.
function BlockEditor({ init, dates, modules, busy, onSave, onCancel, onClose }) {
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
  const [ask, setAsk] = useState(false)          // the series question on save

  const starts = []
  for (let h = 6; h < 24; h++) starts.push(h * 60)
  if (!starts.includes(init.start)) starts.push(init.start)
  starts.sort((a, b) => a - b)
  const lengths = []
  for (let h = 1; h <= MAX_LENGTH_H && start + h * 60 <= 24 * 60; h++) lengths.push(h * 60)
  if (!lengths.includes(init.length) && start + init.length <= 24 * 60) lengths.push(init.length)
  if (!lengths.includes(length)) lengths.push(length)
  lengths.sort((a, b) => a - b)
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
    if (orig?.series_id && !scope) { setAsk(true); return }
    onSave(draft(), scope)
  }

  return (
    <Sheet label={orig ? 'Edit block' : 'New block'} onClose={onClose}>
      <div className="kicker">{orig ? 'Edit block' : 'New block'}</div>
      <div className="display" style={{ color: 'var(--cyan)', fontSize: 16, marginTop: 4 }}>
        {dayLabel(date, dates)} · {minToTime(start)} - {minToTime(start + length)}
      </div>

      {ask ? (
        <div className="space-y-3 mt-4">
          <p>This block repeats every week. Change just this one, or this one and the later ones?</p>
          <div className="wk-sheet-btns">
            <button className="btn small" disabled={busy} onClick={() => onSave(draft(), 'one')}>Just this one</button>
            <button className="btn small" disabled={busy} onClick={() => onSave(draft(), 'later')}>This and later ones</button>
            <button className="btn small ghost" onClick={() => setAsk(false)}>Back</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 mt-4">
          <div className="field">
            <label htmlFor="wk-label">What's the plan?</label>
            <input id="wk-label" className="input" maxLength={120} value={label}
              placeholder="e.g. Chapter 3 summary" onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }} />
          </div>

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
            <button className="btn small ghost" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
