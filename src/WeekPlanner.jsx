import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ping } from './lib/ping'
import { formatDue } from './lib/week'
import {
  localDateStr, parseLocalDate, addDays, mondayOf, weekDates, minToTime, timeToMin,
  expandRepeat, swapBlocks, copyWeek, classMarkersForWeek, isHardDeadline, isExamRow, layoutDay,
  groupColourFor, moduleForLabel, inkFor, liftForDark, LEARNER_GREY, dropDuplicateMarkers,
} from './lib/planner.js'
import { wallpaperFileName } from './lib/wallpaper.js'
import { renderWallpaper, saveCanvas } from './lib/wallpaperPaint.js'

// The Week tab (sunday-planner/DESIGN-shovel-look.md, unit 6): her week as a timeline in the look
// of her Shovel planner, saving to plan_blocks exactly as before. Every block is as tall as its
// real time. Two faces of ONE component:
//   • wide screen  : an hour axis, then MON .. SUN side by side;
//   • phone (<760) : one day at a time, day tabs plus swipe, the same timeline.
// The wallpaper (her ask, 27 Sep: "download the week I am in as a png, like whenworks does") is
// not a third face of the page: it is DRAWN from the same placed rows by lib/wallpaper.js, at the
// real size of her screen. The Wallpaper button saves it; the #week-wall route shows it.
//
// The look (her rulings, 27 and 28 Sep): every FIXED time is SOLID, uni classes and tests in the
// module's hub colour, classes she teaches in the group's colour, one-on-one learners grey; her
// own study blocks, which she can move and swap, are an OUTLINE with a faint fill; learners' exam
// dates a solid bar at the top of the day. No "fixed" tag, no lock, no block inside a block.
//
// Placement, colours and every date/repeat/swap/copy decision come from lib/planner.js (tested
// there). All reads and writes go through the `data` prop (lib/plannerData.js): the live
// Supabase layer, or the in-memory demo layer on the dev-only #week-demo route.

const HOURS_KEY = 'nwuHub.week.hours'
const CACHE_PREFIX = 'nwuHub.week.cache.'
const CACHE_WEEKS = 8
const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const DAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Fixed chips beside the module chips. The hub palette's values, as hex so a block can work out
// its text colour and its edge from them.
const KIND_CHIPS = [
  { kind: 'prep', name: 'Prep', colour: '#ffd166' },
  { kind: 'break', name: 'Break', colour: '#34f5c5' },
  { kind: 'other', name: 'Other', colour: '#4d7cff' },
]
const KIND_NAME = { study: 'Study', class: 'Class', prep: 'Prep', break: 'Break', other: 'Other' }
const STUDY_COLOUR = '#38e1ff'          // her block with no module and no kind chip
const NEUTRAL_SOLID = '#4d7cff'         // her own timetable row whose label names no module
const REPEAT_WEEKS = 6                  // default "repeat every week until": 6 weeks ahead
const REPEAT_CAP = 26
const MAX_LENGTH_MIN = 8 * 60
const STEP_MIN = 15                     // her blocks start and end on quarter hours

// ---------- small helpers (formatting only; the logic lives in planner.js) ----------

const pad = (n) => String(n).padStart(2, '0')
const hm = (t) => String(t || '').slice(0, 5)
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

// The time of day in minutes, refreshed every minute, for the "now" line.
function useNowMin() {
  const read = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
  const [m, setM] = useState(read)
  useEffect(() => {
    const t = setInterval(() => setM(read()), 60 * 1000)
    return () => clearInterval(t)
  }, [])
  return m
}

// 'own'   her block, editable                     → outline, module or kind colour
// 'uni'   her own timetable row (ww:own:, a test)  → solid, module colour from its label
// 'class' a class she teaches (from the scheduler) → solid, group colour or grey
// 'exam'  a learner's exam date (ww:exam:)         → solid bar at the top of the day
function rowType(b) {
  if (b.source == null) return 'own'
  if (isExamRow(b)) return 'exam'
  return isHardDeadline(b) ? 'uni' : 'class'
}

function blockColour(b, modById, modules) {
  const t = rowType(b)
  if (t === 'uni') return moduleForLabel(b.label, modules)?.colour || NEUTRAL_SOLID
  if (t === 'class' || t === 'exam') return groupColourFor(b.label) || LEARNER_GREY
  const m = b.module_id && modById[b.module_id]
  if (m && m.colour) return m.colour
  const k = KIND_CHIPS.find((x) => x.kind === b.kind)
  return k ? k.colour : STUDY_COLOUR
}

// Her rule (28 Sep): a FIXED time is solid; a study block she can move or swap any time is an
// outline. Only her own blocks can be moved, so everything else is solid.
const isSolid = (type) => type !== 'own'

// The three colour variables a block is drawn with: its fill, its edge/text on the dark
// background, and its text colour when solid.
function lookVars(colour) {
  return { '--c': colour, '--cb': liftForDark(colour), '--ink': inkFor(colour) }
}

function blockTitle(b, modById) {
  return b.label || (b.module_id && modById[b.module_id]?.code) || KIND_NAME[b.kind] || 'Study'
}

// "MATV121: online class — Wednesday, 19:00" → "MATV121: online class". The block already shows
// the time, so the text after the dash only repeats it.
function markerTitle(text) {
  return String(text || '').split(' — ')[0].trim() || 'NWU class'
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
  const nowMin = useNowMin()
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
  const [shooting, setShooting] = useState(false)   // the wallpaper PNG is being made
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

  // Wallpaper PNG: the week on screen, drawn at the real size of this screen, saved to Downloads.
  async function saveWallpaper() {
    if (shooting) return
    setError('')
    setShooting(true)
    try {
      await saveCanvas(await renderWallpaper(wallModel), wallpaperFileName(monday))
      setNotice('Saved to your Downloads. Right-click it and choose "Set as desktop background".')
    } catch (e) {
      setError(`Could not make the wallpaper: ${e?.message || e}`)
    }
    setShooting(false)
  }

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
  // NWU classes from the hub, minus any she also typed into the scheduler (drawn once, as that row).
  const markers = useMemo(
    () => dropDuplicateMarkers(classMarkersForWeek(week?.goals || [], dates).filter((m) => m.date), blocks, modules),
    [week, dates, blocks, modules])
  const readOnly = status !== 'ok'
  const thisMonday = mondayOf(today)

  // Every day's timed rows (her blocks, the scheduler's rows, NWU classes) placed on the timeline,
  // and the day's learners' exam dates for the bar at the top.
  const dayData = useMemo(() => {
    const out = {}
    for (const d of dates) {
      const rows = [
        ...blocks.filter((b) => b.block_date === d && !isExamRow(b)).map((b) => ({
          key: b.id, id: b.id, type: rowType(b), b, label: blockTitle(b, modById),
          colour: blockColour(b, modById, modules), start_time: b.start_time, end_time: b.end_time,
        })),
        ...markers.filter((m) => m.date === d && !m.untimed).map((m) => ({
          key: `nwu-${m.goal.id}`, id: `nwu-${m.goal.id}`, type: 'nwu', m, label: markerTitle(m.goal.text),
          colour: m.goal.modules?.colour || STUDY_COLOUR,
          start_time: minToTime(m.start), end_time: minToTime(m.end),
        })),
      ]
      const exams = blocks.filter((b) => b.block_date === d && isExamRow(b))
        .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')) || String(a.label).localeCompare(String(b.label)))
        .map((b) => ({ key: b.id, id: b.id, type: 'exam', b, label: blockTitle(b, modById), colour: blockColour(b, modById, modules) }))
      out[d] = { placed: layoutDay(rows, hours.start * 60, hours.end * 60), exams }
    }
    return out
  }, [blocks, markers, dates, hours, modById, modules])

  const untimedByDate = useMemo(() => {
    const out = {}
    for (const d of dates) out[d] = markers.filter((m) => m.date === d && m.untimed)
    return out
  }, [markers, dates])

  // The same placed rows, as plain facts for the wallpaper (lib/wallpaper.js draws them).
  const wallModel = useMemo(() => ({
    title: rangeLabel(dates),
    hours,
    days: dates.map((d, i) => ({
      name: DAY_SHORT[i].toUpperCase(),
      num: parseLocalDate(d).getDate(),
      blocks: dayData[d].placed.map((p) => ({
        label: p.row.label, start: hm(p.row.start_time), end: hm(p.row.end_time),
        colour: p.row.colour, solid: isSolid(p.row.type), done: p.row.type === 'own' && !!p.row.b?.done,
        top: p.top, height: p.height, lane: p.lane, lanes: p.lanes,
      })),
      exams: dayData[d].exams.map((it) => ({ label: it.label, colour: it.colour })),
      untimed: untimedByDate[d].map((m) => ({ label: m.goal.text, colour: m.goal.modules?.colour || STUDY_COLOUR })),
    })),
  }), [dates, hours, dayData, untimedByDate])

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

  // Tap an empty stretch of the timeline: a new block starting at that quarter hour, one hour long.
  function openNew(date, startMin) {
    if (readOnly || busy || pick) return
    setError('')
    setSheet({ mode: 'edit', block: null, date, start: startMin, length: 60 })
  }

  // Tap a block: see what it entails. In swap mode, the tap picks the partner instead. An NWU class
  // from the hub has no plan_blocks row; it opens the same read-only panel.
  function openItem(it) {
    if (it.type === 'nwu') {
      if (pick) return
      setSheet({ mode: 'info', item: it })
      return
    }
    const b = it.b
    if (pick) { choosePartner(b); return }
    setError('')
    setSheet(b.source ? { mode: 'info', item: it, block: b } : { mode: 'view', block: b })
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
    today, nowMin, hours, dayData, untimedByDate, readOnly: readOnly || busy, pick, hot,
    onItem: openItem, onAdd: openNew, onHot: setHot,
  }

  if (wall) {
    return (
      <div className="wk-wall" onClick={() => onExitWall && onExitWall()}>
        {week
          ? <WallPicture model={wallModel} />
          : <div className="muted">{status === 'loading' ? 'Loading…' : 'No copy of this week to show.'}</div>}
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
        ? <DayView {...gridProps} dates={dates} blocks={blocks} dayIdx={selDay} setDayIdx={setSelDay} onSwipe={stepDay} />
        : (
          <div className="wk-wrap">
            <div className="wk-side" aria-hidden="true">{rangeLabel(dates)}</div>
            <Timeline {...gridProps} dates={dates} />
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
          {!isPhone && (
            <button className="btn small ghost" disabled={shooting} onClick={saveWallpaper}
              title="Save this week as a picture for your desktop, at the size of this screen.">{shooting ? 'Saving…' : 'Wallpaper'}</button>
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
          block={liveBlock} dates={dates} modById={modById} modules={modules} busy={busy} readOnly={readOnly}
          onTick={toggleDone} onEdit={openEdit} onDelete={deleteBlock} onSwap={startSwap} onClose={closeSheet}
        />
      )}
      {sheet && sheet.mode === 'info' && sheet.item && (
        <InfoView item={sheet.item} dates={dates} onClose={closeSheet} />
      )}
    </main>
  )
}

// ---------- the wallpaper, shown (the #week-wall route) ----------

// The very picture the Wallpaper button saves, fitted to the window.
function WallPicture({ model }) {
  const ref = useRef(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let gone = false
    renderWallpaper(model, ref.current)
      .then(() => { if (!gone) setError('') })
      .catch((e) => { if (!gone) setError(`Could not draw the wallpaper: ${e?.message || e}`) })
    return () => { gone = true }
  }, [model])
  return (
    <>
      <canvas ref={ref} className="wk-wall-pic" data-wallpaper="" />
      {error && <div className="wk-wall-err" role="alert">{error}</div>}
    </>
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

// ---------- one block on the timeline ----------

// As tall as its real time; overlapping blocks share the width side by side, so nothing is ever
// folded away or drawn inside another block.
function Ev({ p, pick, onItem }) {
  const it = p.row
  const b = it.b
  const cls = ['ev', isSolid(it.type) ? 'ev-solid' : 'ev-line', it.type]
  if (it.type === 'own' && b.done) cls.push('done')
  if (pick && b && pick.id === b.id) cls.push('picking')
  const mins = timeToMin(it.end_time) - timeToMin(it.start_time)
  if (mins <= 30) cls.push('short')
  const style = {
    ...lookVars(it.colour),
    '--top': `${p.top}%`, '--h': `${p.height}%`, '--lane': p.lane, '--lanes': p.lanes,
  }
  const inner = (
    <>
      <span className="ev-l">{it.label}</span>
      <span className="ev-t">{timeRange(it)}</span>
    </>
  )
  const what = it.type === 'own' ? (pick ? 'Swap with' : 'Open') : it.type === 'nwu' ? 'NWU class' : it.type === 'uni' ? 'Your timetable' : 'Class'
  return (
    <button type="button" className={cls.join(' ')} style={style}
      data-block-id={b ? b.id : it.id} data-kind={it.type}
      disabled={!!pick && (it.type !== 'own' || pick.id === b.id)}
      aria-label={`${what}: ${it.label}, ${timeRange(it)}${b && b.done ? ', done' : ''}`}
      onClick={(e) => { e.stopPropagation(); onItem(it) }}>
      {inner}
    </button>
  )
}

// ---------- one day's column ----------

// Hour cells behind the blocks are the tap targets for a new block: the tap's height inside the
// cell picks the quarter hour. Blocks sit on top, placed by lib/planner.js layoutDay.
function DayColumn({ date, dayIdx, today, nowMin, hours, placed, readOnly, pick, hot, onItem, onAdd, onHot }) {
  const hourList = []
  for (let h = hours.start; h < hours.end; h++) hourList.push(h)
  const addable = !readOnly && !pick
  const range = (hours.end - hours.start) * 60
  const nowTop = date === today && nowMin >= hours.start * 60 && nowMin < hours.end * 60
    ? ((nowMin - hours.start * 60) / range) * 100 : null
  const d = parseLocalDate(date)
  return (
    <div className={`tl-day${date === today ? ' today' : ''}`} data-day={date}>
      {hourList.map((h) => {
        const key = `${date}|${h}`
        const cls = ['tl-cell']
        if (hot === key) cls.push('hot')
        return (
          <div key={h} className={cls.join(' ')} data-date={date} data-hour={h}
            role={addable ? 'button' : undefined} tabIndex={addable ? 0 : undefined}
            aria-label={addable ? `${DAY_LONG[dayIdx]} ${d.getDate()}, ${pad(h)}:00: add a block` : undefined}
            onPointerDown={() => onHot(key)}
            onClick={addable ? (e) => {
              const r = e.currentTarget.getBoundingClientRect()
              const q = Math.min(3, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * 4)))
              onAdd(date, h * 60 + q * STEP_MIN)
            } : undefined}
            onKeyDown={addable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(date, h * 60) } } : undefined}>
            {addable && <span className="tl-plus" aria-hidden="true">+</span>}
          </div>
        )
      })}
      {nowTop != null && <div className="tl-now" style={{ top: `${nowTop}%` }} aria-hidden="true" />}
      {placed.map((p) => <Ev key={p.row.key} p={p} pick={pick} onItem={onItem} />)}
    </div>
  )
}

// ---------- the timeline: the week (wide) or one day (phone) ----------

function Timeline({ dates, today, nowMin, hours, dayData, untimedByDate, readOnly, pick, hot, onItem, onAdd, onHot, phone = false }) {
  const hourList = []
  for (let h = hours.start; h < hours.end; h++) hourList.push(h)
  const anyExam = dates.some((d) => dayData[d].exams.length)
  const anyUntimed = dates.some((d) => untimedByDate[d].length)
  const cols = { '--days': dates.length, '--hours': hourList.length }
  return (
    <div className={`tl${phone ? ' phone' : ''}`} data-week-grid="" style={cols}>
      {!phone && (
        <div className="tl-row tl-head">
          <div className="tl-corner" />
          {dates.map((d) => {
            const i = (parseLocalDate(d).getDay() + 6) % 7
            return (
              <div key={d} className={`tl-gh${d === today ? ' today' : ''}`} data-day-head={d}>
                {DAY_SHORT[i].toUpperCase()} <small>{parseLocalDate(d).getDate()}</small>
              </div>
            )
          })}
        </div>
      )}

      {anyExam && (
        <div className="tl-row tl-exams-row">
          <div className="tl-lab">Exams</div>
          {dates.map((d) => (
            <div key={d} className="tl-exams" data-exams={d}>
              {dayData[d].exams.map((it) => (
                <button key={it.key} type="button" className="ex-bar" style={lookVars(it.colour)} data-kind="exam"
                  disabled={!!pick} aria-label={`Exam: ${it.label}`}
                  onClick={() => onItem(it)}>{it.label}</button>
              ))}
            </div>
          ))}
        </div>
      )}

      {anyUntimed && (
        <div className="tl-row">
          <div className="tl-lab">No time set</div>
          {dates.map((d) => (
            <div key={d} className="slot-notime" data-notime={d}>
              {untimedByDate[d].map((m) => (
                <span key={m.goal.id} className="slot-nwu" data-nwu-class="" style={{ '--c': m.goal.modules?.colour || STUDY_COLOUR }}
                  title="NWU class, no time set">{m.goal.text}</span>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="tl-row tl-body">
        <div className="tl-axis" aria-hidden="true">
          {hourList.map((h, i) => (
            <span key={h} className="tl-hr" style={{ top: `${(i / hourList.length) * 100}%` }}>{pad(h)}:00</span>
          ))}
        </div>
        {dates.map((d) => (
          <DayColumn key={d} date={d} dayIdx={(parseLocalDate(d).getDay() + 6) % 7} today={today} nowMin={nowMin}
            hours={hours} placed={dayData[d].placed} readOnly={readOnly} pick={pick} hot={hot}
            onItem={onItem} onAdd={onAdd} onHot={onHot} />
        ))}
      </div>
    </div>
  )
}

// ---------- phone: one day at a time ----------

function DayView({ dates, blocks, dayIdx, setDayIdx, onSwipe, ...grid }) {
  const date = dates[dayIdx]
  const d = parseLocalDate(date)

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
          if (x === grid.today) cls.push('today')
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
        <Timeline {...grid} dates={[date]} phone />
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
function BlockView({ block: b, dates, modById, modules, busy, readOnly, onTick, onEdit, onDelete, onSwap, onClose }) {
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
      <div className="display wk-sheet-title" style={{ '--c': liftForDark(blockColour(b, modById, modules)) }}>{title}</div>
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

// Anything that comes from a timetable (a class she teaches, her own test or class, a learner's
// exam, an NWU class from the hub): what it is and when. Read only.
const INFO = {
  uni: { kicker: 'Your timetable', what: 'From your own timetable: it happens on this day, at this time.' },
  class: { kicker: 'Class', what: 'A class from your tutoring timetable.' },
  exam: { kicker: 'Exam', what: "A learner's exam date, from your tutoring timetable." },
  nwu: { kicker: 'NWU class', what: 'A class from your NWU hub.' },
}

function InfoView({ item: it, dates, onClose }) {
  const info = INFO[it.type] || INFO.class
  const date = it.b ? it.b.block_date : it.m.date
  // An exam row's own times are placeholders (it lives in the top bar); /week puts the paper's
  // real time, as WhenWorks has it, in the note.
  const timeText = it.type === 'exam'
    ? (it.b.note || null)
    : (it.b ? (it.b.start_time && it.b.end_time ? timeRange(it.b) : null) : (it.m.untimed ? null : timeRange(it)))
  return (
    <Sheet label={`${info.kicker}: ${it.label}`} onClose={onClose}>
      <div className="kicker">{info.kicker}</div>
      <div className="display wk-sheet-title" style={{ '--c': liftForDark(it.colour) }}>
        {it.type === 'nwu' ? it.m.goal.text : it.label}
      </div>
      <dl className="wk-facts">
        <dt>What</dt><dd>{info.what}</dd>
        <dt>Day</dt><dd>{dayLabel(date, dates)}</dd>
        {timeText && <><dt>Time</dt><dd>{timeText}</dd></>}
      </dl>
      <p className="text-sm muted mt-3">It comes from your timetable, so it can't be changed here.</p>
      <div className="wk-sheet-btns mt-4">
        <button className="btn small ghost" onClick={onClose}>Close</button>
      </div>
    </Sheet>
  )
}

// New block, or Edit from the view panel. Her own blocks start and end on quarter hours (the block
// is drawn as tall as its real time). A block saved before with odd times keeps them unless she
// picks new ones.
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
  for (let m = 6 * 60; m < 24 * 60; m += STEP_MIN) starts.push(m)
  if (!starts.includes(init.start)) starts.push(init.start)
  starts.sort((a, b) => a - b)
  const lengths = []
  for (let m = STEP_MIN; m <= MAX_LENGTH_MIN && start + m <= 24 * 60; m += STEP_MIN) lengths.push(m)
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
