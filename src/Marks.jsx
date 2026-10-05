// The Marks tab (#marks): one participation pie per module this semester, then "My year".
//
// All the maths lives in lib/marks.js (tested by sync/verify-marks.mjs); all the reads and writes
// live in lib/marksData.js. This file only draws and wires taps. It is handed a data layer (live or
// the dev-only demo) and the signed-in user's id, and runs the same code for both accounts: the
// row rules return each person only her OWN marks, so nothing here branches on who is viewing.
//
// Her rulings, kept here so nobody "improves" them away: no red, no warnings, no targets, no pass
// lines, no praise lines. An empty pie or ring just reads "Not marked yet". A weight is never
// guessed: an assessment with no weight sits in the list, never in the pie. The year figure is
// TYPED from her record, never computed: no average across modules is worked out anywhere here.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildPie, wedgePath, parseMarkInput, formatNumber, ringDash, pieLabels, SLICE_COLOUR_COUNT, LABEL_LINE_HEIGHT,
} from './lib/marks'

// The six slice colours, in slice order, the same in every module (her choice). Index = colourIndex.
export const SLICE_COLOURS = ['#38e1ff', '#9a6bff', '#34f5c5', '#ffd166', '#ff7fc1', '#4d7cff']
if (SLICE_COLOURS.length !== SLICE_COLOUR_COUNT) throw new Error('SLICE_COLOURS must match SLICE_COLOUR_COUNT')

const R = 90        // pie radius in the 200 x 200 viewBox
const C = 100       // pie centre
const RING_R = 30   // "My year" ring radius in its 76 x 76 viewBox
const YEAR_CODE = 'YEAR-2026'
const YEAR_TITLE = 'Year average (from my record)'
const HINT = 'Try 88 or 22/25'
const EMPTY = 'Not marked yet'

// The year figure as stored: up to 2 decimals, no trailing zeros (89.27, 71.5, 80).
const twoDp = (n) => (typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '')

// "22/25 (88%)" when a fraction was typed, else "88%".
function markText(mark, raw) {
  if (mark === null || mark === undefined) return EMPTY
  const pct = `${formatNumber(mark)}%`
  return raw && raw.includes('/') ? `${raw} (${pct})` : pct
}

export default function Marks({ db, userId }) {
  const [data, setData] = useState(null)          // { modules, assessments, myMarks, finals }
  const [status, setStatus] = useState('loading') // loading | ok | error
  const [loadError, setLoadError] = useState('')
  const [notice, setNotice] = useState('')        // a plain line after a write that did not save
  const [openId, setOpenId] = useState(null)      // the module whose pie is open big
  const [editing, setEditing] = useState(null)    // assessment id being typed into
  const [ringEdit, setRingEdit] = useState(null)  // 'f:<id>' | 'm:<code>' | 'year'
  const [armed, setArmed] = useState(null)        // final_marks id waiting for its "Remove" tap

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      setData(await db.fetchAll())
      setStatus('ok')
    } catch (e) {
      setLoadError(e.message)
      setStatus('error')
    }
  }, [db])

  useEffect(() => { load() }, [load])

  const modules = useMemo(() => (data ? data.modules.filter((m) => !m.hidden) : []), [data])
  const pies = useMemo(() => {
    if (!data) return new Map()
    const out = new Map()
    for (const m of modules) {
      out.set(m.id, buildPie(data.assessments.filter((a) => a.module_id === m.id), data.myMarks, m))
    }
    return out
  }, [data, modules])

  // ---------- writes: change the screen at once, roll back with a plain line if it fails ----------

  async function writeMark(assessmentId, parsed) {
    const before = data.myMarks.find((m) => m.assessment_id === assessmentId) || null
    const put = (row) => setData((d) => ({
      ...d,
      myMarks: d.myMarks.filter((m) => m.assessment_id !== assessmentId).concat(row ? [row] : []),
    }))
    setEditing(null)
    if (parsed.clear && !before) return
    put(parsed.clear ? null : { assessment_id: assessmentId, mark: parsed.mark, raw: parsed.raw })
    try {
      if (parsed.clear) await db.clearMark(userId, assessmentId)
      else put(await db.saveMark(userId, assessmentId, parsed.mark, parsed.raw))
      setNotice('')
    } catch (e) {
      put(before)
      setNotice(`That mark did not save (${e.message}), so it is back to what it was.`)
    }
  }

  const putFinal = (id, row) => setData((d) => ({
    ...d,
    finals: row
      ? (d.finals.some((f) => f.id === id) ? d.finals.map((f) => (f.id === id ? row : f)) : d.finals.concat(row))
      : d.finals.filter((f) => f.id !== id),
  }))

  // target: { row } for an existing final_marks row, or { create } with the new row's fields.
  async function writeFinal(target, parsed) {
    setRingEdit(null)
    setArmed(null)
    const mark = parsed.clear ? null : parsed.mark
    if (target.row) {
      const before = target.row
      if (before.mark === mark) return
      putFinal(before.id, { ...before, mark })
      try {
        putFinal(before.id, await db.updateFinal(before.id, { mark }))
        setNotice('')
      } catch (e) {
        putFinal(before.id, before)
        setNotice(`That final mark did not save (${e.message}), so it is back to what it was.`)
      }
      return
    }
    if (mark === null) return   // clearing a ring that has no row yet: nothing to do
    const tmpId = `tmp-${Date.now()}`
    putFinal(tmpId, { id: tmpId, ...target.create, mark })
    try {
      const saved = await db.upsertFinal(userId, { ...target.create, mark })
      setData((d) => ({ ...d, finals: d.finals.filter((f) => f.id !== tmpId && f.id !== saved.id).concat(saved) }))
      setNotice('')
    } catch (e) {
      putFinal(tmpId, null)
      setNotice(`That final mark did not save (${e.message}), so it is back to what it was.`)
    }
  }

  async function addModule(row) {
    const tmpId = `tmp-${Date.now()}`
    putFinal(tmpId, { id: tmpId, kind: 'module', mark: null, ...row })
    try {
      const saved = await db.addFinal(userId, { kind: 'module', mark: null, ...row })
      setData((d) => ({ ...d, finals: d.finals.filter((f) => f.id !== tmpId).concat(saved) }))
      setNotice('')
      return true
    } catch (e) {
      putFinal(tmpId, null)
      setNotice(`${row.module_code} was not added (${e.message}).`)
      return false
    }
  }

  async function removeFinal(row) {
    setArmed(null)
    setRingEdit(null)
    putFinal(row.id, null)
    try {
      await db.removeFinal(row.id)
      setNotice('')
    } catch (e) {
      putFinal(row.id, row)
      setNotice(`${row.module_code} was not removed (${e.message}), so it is still here.`)
    }
  }

  // ---------- render ----------

  if (status === 'loading' && !data) {
    return <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 muted">Loading your marks…</div>
  }
  if (status === 'error' && !data) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        <p className="muted">Could not load your marks: {loadError}</p>
        <button className="btn ghost mk-tap mt-3" onClick={load}>Try again</button>
      </div>
    )
  }

  const open = openId ? modules.find((m) => m.id === openId) : null

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 mk" data-marks-root="">
      <h1 className="display text-2xl" style={{ color: '#eaf4ff' }}>Marks</h1>
      {notice && <p className="mk-notice" role="status">{notice}</p>}

      <section className="mt-5">
        <h2 className="section-label mb-3">This semester</h2>
        {modules.length === 0 ? (
          <p className="muted">No modules yet.</p>
        ) : (
          <div className="mk-grid" data-pie-grid="">
            {modules.map((m) => (
              <PieCard key={m.id} module={m} pie={pies.get(m.id)}
                onOpen={() => { setOpenId(m.id); setEditing(null) }} />
            ))}
          </div>
        )}
      </section>

      <MyYear finals={data.finals} modules={modules} ringEdit={ringEdit} armed={armed}
        onEdit={(key) => { setRingEdit(key); setArmed(null) }}
        onCancel={() => setRingEdit(null)}
        onSave={writeFinal} onArm={(id) => { setArmed(id); setRingEdit(null) }}
        onRemove={removeFinal} onAdd={addModule} />

      {open && (
        <PieSheet module={open} pie={pies.get(open.id)} editing={editing} notice={notice}
          onEdit={setEditing} onSave={writeMark}
          onClose={() => { setOpenId(null); setEditing(null) }} />
      )}
    </div>
  )
}

// ---------- the pie ----------

// Per slice: marked = a faint full wedge ("marks lost") with the solid wedge on top at R * fill;
// not marked = only a dashed outline. A `gap` (weights under 100) is simply left empty. The thin
// outer circle is a frame only, in the hub's line colour, so an empty pie still has a shape.
//
// Each slice carries its assessment's short name (her ask, 5 Oct): inside the slice when it fits,
// just outside the rim in the slice's colour when the slice is too thin. The viewBox grows to hold
// outside names and the max-width grows with it, so the circle itself stays the same size.
function Pie({ pie, onSlice, label, big }) {
  const tap = (id) => (onSlice ? { onClick: () => onSlice(id), style: { cursor: 'pointer' } } : {})
  const { labels, box } = useMemo(() => pieLabels(pie.slices, C, C, R), [pie.slices])
  return (
    <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} className="mk-pie"
      style={{ maxWidth: box.w * (big ? 1.5 : 1) }} aria-hidden={onSlice ? 'true' : undefined}
      role={onSlice ? undefined : 'img'} aria-label={onSlice ? undefined : label}>
      <circle cx={C} cy={C} r={R} fill="none" strokeWidth="1" style={{ stroke: 'var(--line)' }} />
      {pie.slices.map((s) => {
        const col = SLICE_COLOURS[s.colourIndex]
        const full = wedgePath(C, C, R, s.startAngle, s.endAngle)
        if (s.mark === null) {
          return (
            <g key={s.id} data-slice={s.id} {...tap(s.id)}>
              <path d={full} fill="transparent" stroke={col} strokeWidth="1.6" strokeDasharray="5 4"
                strokeLinejoin="round" data-kind="empty" data-r={R} />
            </g>
          )
        }
        const r = R * s.fill
        return (
          <g key={s.id} data-slice={s.id} {...tap(s.id)}>
            <path d={full} fill={col} fillOpacity="0.16" strokeWidth="1" style={{ stroke: 'var(--bg)' }} data-kind="lost" data-r={R} />
            {r > 0 && <path d={wedgePath(C, C, r, s.startAngle, s.endAngle)} fill={col} data-kind="solid" data-r={r} />}
          </g>
        )
      })}
      {labels.map((l) => (
        <text key={l.id} x={l.x} y={l.y} textAnchor={l.anchor} data-slice-label={l.id}
          className={l.outside ? 'mk-slice-label out' : 'mk-slice-label'}
          style={l.outside ? { fill: SLICE_COLOURS[l.colourIndex] } : undefined}>
          {l.lines.map((line, i) => (
            <tspan key={i} x={l.x} dy={i ? LABEL_LINE_HEIGHT : 0}>{line}</tspan>
          ))}
        </text>
      ))}
    </svg>
  )
}

function PieLines({ pie }) {
  return (
    <div className="mk-lines">
      <div className="mk-line" data-line="average">
        Average on marked work: {pie.average === null ? EMPTY : `${formatNumber(pie.average)}%`}
      </div>
      <div className="mk-line" data-line="banked">Banked so far: {formatNumber(pie.banked)} of 100</div>
    </div>
  )
}

function PieCard({ module: m, pie, onOpen }) {
  return (
    <button className="panel mk-card" style={{ '--c': m.colour || 'var(--cyan)' }} onClick={onOpen}
      data-pie-card={m.code} aria-label={`${m.code} ${m.title || ''}: open the pie`}>
      <span className="mk-code">{m.code}</span>
      {m.title && <span className="mk-name">{m.title}</span>}
      <Pie pie={pie} label={`${m.code} participation pie`} />
      <PieLines pie={pie} />
    </button>
  )
}

// ---------- the pie, open big ----------

function Sheet({ label, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay wk-sheet-back" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="system wk-sheet mk-sheet" role="dialog" aria-modal="true" aria-label={label}>{children}</div>
    </div>
  )
}

function PieSheet({ module: m, pie, editing, notice, onEdit, onSave, onClose }) {
  const colour = m.colour || 'var(--cyan)'
  return (
    <Sheet label={`${m.code} marks`} onClose={onClose}>
      <div className="mk-sheet-head">
        <div style={{ minWidth: 0 }}>
          <div className="mk-code" style={{ '--c': colour }}>{m.code}</div>
          {m.title && <div className="mk-name" style={{ '--c': colour }}>{m.title}</div>}
        </div>
        <button className="btn ghost mk-tap" onClick={onClose}>Close</button>
      </div>
      {notice && <p className="mk-notice" role="status">{notice}</p>}
      <Pie pie={pie} onSlice={(id) => onEdit(id)} big />
      <PieLines pie={pie} />
      {pie.gap > 0 && pie.slices.length > 0 && (
        <p className="muted text-sm mt-1">{formatNumber(pie.gap)}% of this pie has no weight yet.</p>
      )}

      <div className="mk-list" data-slice-list="">
        {pie.slices.map((s) => (
          <MarkRow key={s.id} id={s.id} title={s.title} mark={s.mark} raw={s.raw}
            colour={SLICE_COLOURS[s.colourIndex]} weight={`${formatNumber(s.share)}%`}
            editing={editing === s.id} onEdit={onEdit} onSave={onSave} />
        ))}
        {pie.slices.length === 0 && <p className="muted text-sm">No weights yet, so the pie is empty.</p>}
      </div>

      {pie.unweighted.length > 0 && (
        <>
          <h3 className="section-label mt-5 mb-2">No weight yet (not in the pie)</h3>
          <div className="mk-list" data-unweighted-list="">
            {pie.unweighted.map((u) => (
              <MarkRow key={u.id} id={u.id} title={u.title} mark={u.mark} raw={u.raw}
                editing={editing === u.id} onEdit={onEdit} onSave={onSave} />
            ))}
          </div>
        </>
      )}
    </Sheet>
  )
}

function MarkRow({ id, title, mark, raw, colour, weight, editing, onEdit, onSave }) {
  const initial = mark === null ? '' : (raw ?? String(mark))
  return (
    <div data-row={id}>
      <button className={`mk-row${editing ? ' sel' : ''}`} onClick={() => onEdit(editing ? null : id)}
        aria-expanded={editing}>
        {colour
          ? <span className={`mk-dot${mark === null ? ' empty' : ''}`} style={{ '--c': colour }} />
          : <span className="mk-dot none" />}
        <span className="mk-row-text">
          <span className="mk-row-title">{title}</span>
          {weight && <span className="mk-row-weight">Weight {weight}</span>}
        </span>
        <span className={mark === null ? 'mk-row-mark muted' : 'mk-row-mark'}>{markText(mark, raw)}</span>
      </button>
      {editing && (
        <MarkEditor label={`Mark for ${title}`} initial={initial} canClear={mark !== null}
          onSave={(p) => onSave(id, p)} onCancel={() => onEdit(null)} />
      )}
    </div>
  )
}

// The small input. Accepts whatever parseMarkInput accepts; empty (or Clear) removes the mark.
function MarkEditor({ label, initial, canClear, onSave, onCancel }) {
  const [text, setText] = useState(initial)
  const [bad, setBad] = useState(false)
  function submit(e) {
    e.preventDefault()
    const p = parseMarkInput(text)
    if (!p.ok) { setBad(true); return }
    onSave(p)
  }
  return (
    <form className="mk-editor" onSubmit={submit} data-mark-editor="">
      <input className="input" aria-label={label} value={text} autoFocus
        placeholder="88 or 22/25" autoComplete="off" enterKeyHint="done"
        onChange={(e) => { setText(e.target.value); setBad(false) }} />
      <button type="submit" className="btn small">Save</button>
      {canClear && (
        <button type="button" className="btn ghost small" onClick={() => onSave({ ok: true, clear: true })}>Clear</button>
      )}
      <button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button>
      {bad && <div className="mk-hint" data-hint="">{HINT}</div>}
    </form>
  )
}

// ---------- My year ----------

function Ring({ mark, code, colour, onTap, label }) {
  const { circumference, filled } = ringDash(mark, RING_R)
  return (
    <button className="mk-ring" onClick={onTap} aria-label={label} data-ring={code}>
      <svg viewBox="0 0 76 76" width="76" height="76" aria-hidden="true">
        <circle cx="38" cy="38" r={RING_R} fill="none" stroke="rgba(80, 140, 255, 0.22)" strokeWidth="7" />
        {mark !== null && filled > 0 && (
          <circle cx="38" cy="38" r={RING_R} fill="none" strokeWidth="7" style={{ stroke: colour }}
            strokeDasharray={`${filled} ${circumference}`} transform="rotate(-90 38 38)" />
        )}
        {mark !== null && (
          <text x="38" y="43" textAnchor="middle" className="mk-ring-num">{formatNumber(mark)}</text>
        )}
      </svg>
      <span className="mk-ring-code">{code}</span>
      {mark === null && <span className="mk-ring-empty">{EMPTY}</span>}
    </button>
  )
}

function MyYear({ finals, modules, ringEdit, armed, onEdit, onCancel, onSave, onArm, onRemove, onAdd }) {
  const moduleRows = finals.filter((f) => f.kind === 'module')
  const sem1 = moduleRows.filter((f) => f.semester === 1)
  const yearMods = moduleRows.filter((f) => f.semester === 0)
  const yearFig = finals.find((f) => f.kind === 'year_figure') || null
  const finalByCode = new Map(moduleRows.map((f) => [f.module_code, f]))

  // A removable ring (semester 1 / year module): the x needs a second tap ("Remove").
  const ownRing = (f, colour) => (
    <div className="mk-ring-wrap" key={f.id}>
      <Ring mark={f.mark} code={f.module_code} colour={colour}
        label={`${f.module_code}: ${f.mark === null ? EMPTY : formatNumber(f.mark)}. Edit the final mark`}
        onTap={() => onEdit(`f:${f.id}`)} />
      {armed === f.id ? (
        <button className="mk-x-arm" onClick={() => onRemove(f)}>Remove</button>
      ) : (
        <button className="mk-x" onClick={() => onArm(f.id)} aria-label={`Remove ${f.module_code}`}><span>×</span></button>
      )}
    </div>
  )

  // The editor for whichever ring in this group is being edited.
  const editorFor = (rows) => {
    const hit = rows.find((r) => r.key === ringEdit)
    if (!hit) return null
    return (
      <div className="mk-ring-editor">
        <div className="mk-ring-editor-label">Final mark for {hit.code}</div>
        <MarkEditor key={hit.key} label={`Final mark for ${hit.code}`}
          initial={hit.row && hit.row.mark !== null ? String(hit.row.mark) : ''}
          canClear={!!(hit.row && hit.row.mark !== null)}
          onSave={(p) => onSave(hit.row ? { row: hit.row } : { create: hit.create }, p)} onCancel={onCancel} />
      </div>
    )
  }

  const sem1Keys = sem1.map((f) => ({ key: `f:${f.id}`, code: f.module_code, row: f }))
  const yearKeys = yearMods.map((f) => ({ key: `f:${f.id}`, code: f.module_code, row: f }))
  const sem2Keys = modules.map((m) => {
    const row = finalByCode.get(m.code) || null
    return {
      key: `m:${m.code}`, code: m.code, row, module: m,
      create: { module_code: m.code, title: m.title || null, semester: 2, kind: 'module' },
    }
  })
  const yearKey = [{
    key: 'year', code: 'my year average', row: yearFig,
    create: { module_code: YEAR_CODE, title: YEAR_TITLE, semester: 0, kind: 'year_figure' },
  }]

  return (
    <section className="mt-8" data-my-year="">
      <h2 className="section-label mb-3">My year</h2>

      <h3 className="mk-sub">Semester 1</h3>
      {sem1.length ? (
        <div className="mk-rings">{sem1.map((f) => ownRing(f, 'var(--cyan)'))}</div>
      ) : (
        <p className="muted text-sm">No Semester 1 modules yet. Add them below.</p>
      )}
      {editorFor(sem1Keys)}

      {yearMods.length > 0 && (
        <>
          <h3 className="mk-sub">Year module</h3>
          <div className="mk-rings">{yearMods.map((f) => ownRing(f, 'var(--purple)'))}</div>
          {editorFor(yearKeys)}
        </>
      )}

      <h3 className="mk-sub">Semester 2</h3>
      {sem2Keys.length ? (
        <div className="mk-rings">
          {sem2Keys.map((k) => (
            <div className="mk-ring-wrap" key={k.key}>
              <Ring mark={k.row ? k.row.mark : null} code={k.code} colour={k.module.colour || 'var(--cyan)'}
                label={`${k.code}: ${k.row && k.row.mark !== null ? formatNumber(k.row.mark) : EMPTY}. Edit the final mark`}
                onTap={() => onEdit(k.key)} />
            </div>
          ))}
        </div>
      ) : (
        <p className="muted text-sm">No modules yet.</p>
      )}
      {editorFor(sem2Keys)}

      <div className="mt-6">
        {yearFig ? (
          <button className="mk-yearline" onClick={() => onEdit('year')} data-year-figure="">
            {yearFig.title || YEAR_TITLE}: {yearFig.mark === null ? EMPTY : twoDp(yearFig.mark)}
          </button>
        ) : (
          <button className="btn ghost mk-tap" onClick={() => onEdit('year')}>Add my year average</button>
        )}
        {editorFor(yearKey)}
      </div>

      <AddModule existing={new Set(finals.map((f) => f.module_code.toUpperCase()))} onAdd={onAdd} />
    </section>
  )
}

function AddModule({ existing, onAdd }) {
  const [code, setCode] = useState('')
  const [title, setTitle] = useState('')
  const [credits, setCredits] = useState('')
  const [semester, setSemester] = useState('1')
  const [hint, setHint] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    const c = code.trim().toUpperCase()
    if (!c) { setHint('Type a module code first.'); return }
    if (c.length > 20) { setHint('A module code is at most 20 characters.'); return }
    if (existing.has(c)) { setHint(`${c} is already in My year.`); return }
    const cr = credits.trim()
    if (cr && !/^\d{1,3}$/.test(cr)) { setHint('Credits is a whole number, like 12.'); return }
    const t = title.trim()
    if (t.length > 120) { setHint('That title is a bit long: 120 characters at most.'); return }
    setHint('')
    setBusy(true)
    const ok = await onAdd({ module_code: c, title: t || null, credits: cr ? Number(cr) : null, semester: Number(semester) })
    setBusy(false)
    if (ok) { setCode(''); setTitle(''); setCredits('') }
  }

  return (
    <form className="mk-add mt-6" onSubmit={submit} data-add-module="">
      <h3 className="mk-sub" style={{ marginTop: 0 }}>Add a module</h3>
      <div className="mk-add-fields">
        <input className="input mk-add-code" aria-label="Module code" placeholder="Code" value={code}
          maxLength={20} autoComplete="off" onChange={(e) => { setCode(e.target.value); setHint('') }} />
        <input className="input mk-add-title" aria-label="Title (optional)" placeholder="Title (optional)" value={title}
          maxLength={120} onChange={(e) => { setTitle(e.target.value); setHint('') }} />
        <input className="input mk-add-credits" aria-label="Credits (optional)" placeholder="Credits" value={credits}
          inputMode="numeric" onChange={(e) => { setCredits(e.target.value); setHint('') }} />
        <select className="input mk-add-sem" aria-label="Semester" value={semester} onChange={(e) => setSemester(e.target.value)}>
          <option value="1">Semester 1</option>
          <option value="0">Year module</option>
        </select>
        <button type="submit" className="btn mk-tap" disabled={busy}>Add</button>
      </div>
      {hint && <div className="mk-hint">{hint}</div>}
    </form>
  )
}
