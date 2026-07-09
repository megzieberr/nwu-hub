import { useEffect, useState, useRef } from 'react'
import { supabase } from './lib/supabase'
import { signInOrUp, signOut } from './lib/auth'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [role, setRole] = useState(null)
  const [view, setView] = useState({ name: 'dashboard' })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  // Learn this account's hub role. Only an explicitly allow-listed 'viewer' (e.g. a friend
  // with read-only access) is restricted; everyone else — owner, or an un-provisioned account
  // before the profiles table exists — gets the full UI. RLS is the real gate; this is polish.
  useEffect(() => {
    if (!session) { setRole(null); return }
    supabase.from('profiles').select('role').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => setRole(data?.role ?? null))
  }, [session])

  if (loading) return <Centered>Loading…</Centered>
  if (!session) return <Login />
  const isViewer = role === 'viewer'
  return view.name === 'module' ? (
    <ModulePage code={view.code} isViewer={isViewer} userId={session.user.id} onBack={() => setView({ name: 'dashboard' })} />
  ) : (
    <Dashboard isViewer={isViewer} onOpenModule={(code) => setView({ name: 'module', code })} />
  )
}

function Centered({ children }) {
  return <div className="min-h-screen flex items-center justify-center muted">{children}</div>
}

function Header({ children, onBack }) {
  return (
    <header style={{ borderBottom: '1px solid var(--line)', background: 'rgba(5,7,15,0.55)', backdropFilter: 'blur(6px)' }}>
      <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && <button onClick={onBack} className="icon-btn" aria-label="Back">←</button>}
          <span className="brand">NWU STUDY HUB</span>
        </div>
        <div className="flex items-center gap-2">
          {children}
          <button onClick={signOut} className="icon-btn">⎋ Exit</button>
        </div>
      </div>
    </header>
  )
}

function Login() {
  const [username, setUsername] = useState('megzieberr')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      await signInOrUp(username, password)
    } catch (e) {
      setErr(e.message || 'Access denied.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 gap-7 text-center">
      <div>
        <div className="logo">NWU STUDY HUB</div>
        <div className="tagline mt-3">System Access</div>
      </div>
      <form onSubmit={submit} className="panel bracket p-8 w-full max-w-sm text-left">
        <div className="field mb-4">
          <label>Hunter ID</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field mb-4">
          <label>Passcode</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {err && <p className="text-sm font-semibold mb-3" style={{ color: 'var(--red)' }}>{err}</p>}
        <button className="btn w-full" disabled={busy || !password}>{busy ? 'Authorising…' : '⚔ Enter'}</button>
        <p className="muted text-xs mt-4">First time here? Pick any passcode — it forges your account.</p>
      </form>
    </div>
  )
}

function Dashboard({ isViewer, onOpenModule }) {
  const [name, setName] = useState('')
  const [modules, setModules] = useState([])
  const [deadlines, setDeadlines] = useState([])
  const [goals, setGoals] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setName(data.user?.email?.split('@')[0] || 'Student'))
    ;(async () => {
      const [m, a] = await Promise.all([
        supabase.from('modules').select('*').order('code'),
        supabase.from('assessments').select('*, modules(code,colour)').eq('status', 'upcoming').order('due_date'),
      ])
      if (m.error) setError(m.error.message)
      setModules(m.data || [])
      setDeadlines(a.data || [])
      // Personal study goals are owner-only — a read-only viewer never sees this section.
      if (!isViewer) {
        const g = await supabase.from('goals').select('*').eq('done', false).order('target_date')
        setGoals(g.data || [])
      }
    })()
  }, [isViewer])

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-5xl mx-auto px-6 py-8 space-y-9">
        {error && (
          <div className="panel p-4 text-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
            {error} — if this mentions a missing table, the schema hasn't been run yet.
          </div>
        )}

        <div className="panel bracket p-5 flex items-center gap-4">
          <div style={{
            width: 62, height: 62, borderRadius: 14, flex: '0 0 auto',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid var(--cyan)', color: 'var(--cyan)', fontFamily: 'Orbitron', fontWeight: 900, fontSize: 26,
            boxShadow: '0 0 22px rgba(56,225,255,.3) inset, 0 0 16px rgba(56,225,255,.25)', background: 'rgba(2,8,22,.5)',
          }}>S2</div>
          <div>
            <div className="section-label">Student</div>
            <div className="display text-2xl" style={{ color: '#eaf4ff' }}>{name}</div>
            <div className="muted text-sm mt-1">Semester 2 · {modules.length} active module{modules.length === 1 ? '' : 's'}</div>
          </div>
        </div>

        <Section title="Modules" empty={!modules.length && 'No modules yet — a tutor will seed these when it orients itself.'}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {modules.map((m) => (
              <button key={m.id} onClick={() => onOpenModule(m.code)} className="gate" style={{ '--accent': m.colour || 'var(--cyan)' }}>
                <div className="code">{m.code}</div>
                <div className="name">{m.title}</div>
                <div className="enter">ENTER →</div>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Quest Log · Upcoming" empty={!deadlines.length && 'Nothing due yet.'}>
          <div className="panel">
            {deadlines.map((d) => {
              const c = d.modules?.colour || 'var(--cyan)'
              return (
                <div className="row" key={d.id} style={{ borderLeft: `3px solid ${c}`, paddingLeft: 14 }}>
                  <span><span className="mono" style={{ marginRight: 8, color: c }}>{d.modules?.code}</span>{d.title}</span>
                  <span className="muted text-sm">{d.due_date || '—'}</span>
                </div>
              )
            })}
          </div>
        </Section>

        {!isViewer && (
          <Section title="Objectives" empty={!goals.length && 'No goals set.'}>
            <div className="panel">
              {goals.map((g) => <div className="row" key={g.id}>{g.text}</div>)}
            </div>
          </Section>
        )}
      </main>
    </div>
  )
}

function ModulePage({ code, isViewer, userId, onBack }) {
  const [mod, setMod] = useState(null)
  const [units, setUnits] = useState([])
  const [summaries, setSummaries] = useState([])
  const [assessments, setAssessments] = useState([])
  const [resources, setResources] = useState([])
  const [papers, setPapers] = useState([])
  const [parts, setParts] = useState([])
  const [profiles, setProfiles] = useState({})
  const [openSummary, setOpenSummary] = useState(null)
  const [showKit, setShowKit] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: m } = await supabase.from('modules').select('*').eq('code', code).maybeSingle()
      if (!m) return
      setMod(m)
      // The last three tables (0003) may not exist pre-migration — Supabase returns an error
      // object rather than throwing, so `?.data || []` just yields empty sections. Safe.
      const [u, s, a, res, pp, profs] = await Promise.all([
        supabase.from('study_units').select('*').eq('module_id', m.id).order('number'),
        supabase.from('summaries').select('id,title,kind,unit_id,html').eq('module_id', m.id).order('created_at'),
        supabase.from('assessments').select('*').eq('module_id', m.id).order('due_date'),
        supabase.from('resources').select('*').eq('module_id', m.id).order('created_at'),
        supabase.from('past_papers').select('*').eq('module_id', m.id)
          .order('year', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }),
        supabase.from('profiles').select('id, display_name, role'),
      ])
      setUnits(u.data || [])
      setSummaries(s.data || [])
      setAssessments(a.data || [])
      setResources(res.data || [])
      setPapers(pp.data || [])
      const pmap = {}
      ;(profs.data || []).forEach((p) => { pmap[p.id] = p })
      setProfiles(pmap)
      // Party Quest parts hang off assessments, so fetch them once the ids are known.
      const aids = (a.data || []).map((x) => x.id)
      if (aids.length) {
        const { data: partData } = await supabase.from('project_parts').select('*').in('assessment_id', aids).order('position')
        setParts(partData || [])
      }
    })()
  }, [code])

  if (!mod) return (<div className="min-h-screen"><Header onBack={onBack} /><Centered>Loading module…</Centered></div>)

  const summariesFor = (unitId) => summaries.filter((s) => s.unit_id === unitId)
  const accent = mod.colour || 'var(--cyan)'

  return (
    <div className="min-h-screen">
      <Header onBack={onBack}>
        {!isViewer && (
          <button onClick={() => setShowKit(true)} className="icon-btn" style={{ borderColor: accent, color: accent }}>🎙️ NotebookLM</button>
        )}
      </Header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-9">
        <div className="panel bracket p-5" style={{ '--accent': accent }}>
          <div style={{ fontFamily: 'Orbitron', fontSize: 12, letterSpacing: 1, color: accent }}>{mod.code}</div>
          <h2 className="display text-2xl mt-1" style={{ color: '#eaf4ff' }}>{mod.title}</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {mod.credits != null && <span className="chip">{mod.credits} credits</span>}
            {mod.nqf_level != null && <span className="chip">NQF {mod.nqf_level}</span>}
            {mod.participation_pct != null && <span className="chip">Participation {mod.participation_pct}% · Exam {mod.exam_pct}%</span>}
            {mod.pass_min != null && <span className="chip">Pass {mod.pass_min}% · exam min {mod.exam_min}%</span>}
          </div>
        </div>

        <Section title="Study Units">
          <div className="space-y-3">
            {units.map((u) => (
              <div key={u.id} className="panel p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-bold" style={{ color: '#eaf4ff', fontSize: 16 }}>
                    <span className="muted" style={{ marginRight: 8 }}>{u.number}.</span>{u.title}
                  </div>
                  <span className="chip">{u.status.replace('_', ' ')}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {summariesFor(u.id).length ? summariesFor(u.id).map((s) => (
                    <button key={s.id} onClick={() => setOpenSummary(s)} className="btn small ghost" style={{ borderColor: accent, color: accent }}>
                      📄 {s.title}
                    </button>
                  )) : <span className="muted text-sm">{isViewer ? 'No summary yet.' : 'No summary yet — ask your tutor to make one.'}</span>}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Assessments" empty={!assessments.length && 'None yet.'}>
          <div className="panel">
            {assessments.map((a) => (
              <div className="row" key={a.id}>
                <span>{a.title}</span>
                <span className="muted text-sm">{a.due_date || 'date TBC'}</span>
              </div>
            ))}
          </div>
        </Section>

        <CodexFiles resources={resources} units={units} accent={accent} />

        <TrainingGrounds papers={papers} accent={accent} />

        <PartyQuests
          parts={parts} setParts={setParts} assessments={assessments}
          profiles={profiles} userId={userId} accent={accent}
        />
      </main>

      {openSummary && <SummaryViewer summary={openSummary} accent={accent} onClose={() => setOpenSummary(null)} />}
      {showKit && !isViewer && <NotebookLMKit mod={mod} units={units} accent={accent} onClose={() => setShowKit(false)} />}
    </div>
  )
}

function SummaryViewer({ summary, accent, onClose }) {
  const iframeRef = useRef(null)

  function savePdf() {
    const w = iframeRef.current?.contentWindow
    if (w) { w.focus(); w.print() }
  }

  return (
    <div className="overlay p-3 sm:p-6" style={{ flexDirection: 'column' }}>
      <div className="panel w-full max-w-4xl flex-1 flex flex-col overflow-hidden" style={{ padding: 0 }}>
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid var(--line)' }}>
          <span className="section-label truncate">{summary.title}</span>
          <div className="flex items-center gap-2">
            <button onClick={savePdf} className="btn small" style={{ background: accent, borderColor: accent, color: '#04121f' }} title="Opens your browser's Save-as-PDF">⭳ Save as PDF</button>
            <button onClick={onClose} className="icon-btn">✕</button>
          </div>
        </div>
        <iframe ref={iframeRef} title={summary.title} srcDoc={summary.html}
          sandbox="allow-scripts allow-same-origin allow-modals allow-popups" className="flex-1 w-full" style={{ background: '#fff', border: 0 }} />
      </div>
    </div>
  )
}

function NotebookLMKit({ mod, units, accent, onClose }) {
  const [copied, setCopied] = useState(false)
  const sources = units.filter((u) => u.source_file).map((u) => u.source_file)
  const prompt =
    `You are making a study podcast for my university module "${mod.title}" (${mod.code}).\n` +
    `Sources: my ${units.length} study units (${units.map((u) => `Unit ${u.number}: ${u.title}`).join('; ')}).\n\n` +
    `Create an engaging, clear deep-dive (~15 minutes) that:\n` +
    `- walks through each unit in order,\n` +
    `- explains the key concepts simply and links the history to why it matters for a future teacher,\n` +
    `- ends each section with a 20-second recap.\n\n` +
    `Audience: a distance-learning B.Ed student revising for open-book tests. Keep it friendly and concrete.`

  function copy() {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="overlay p-4" onClick={onClose}>
      <div className="system p-6 w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="display" style={{ color: 'var(--cyan)', fontSize: 18 }}>🎙️ NotebookLM Podcast Kit</h3>
          <button onClick={onClose} className="icon-btn">✕</button>
        </div>
        <p className="muted text-sm mb-4">New notebook → upload these sources → paste the prompt → generate an Audio Overview. (Or just ask your tutor: “make me a podcast.”)</p>

        <div className="section-label mb-2">1 · Upload these files</div>
        <ul className="text-sm mb-1" style={{ background: 'rgba(2,8,22,.5)', borderRadius: 10, padding: 12, border: '1px solid var(--line)' }}>
          {sources.length ? sources.map((s) => <li key={s} className="mono" style={{ padding: '2px 0', color: 'var(--text)' }}>{s}</li>)
            : <li className="muted">No source files recorded yet.</li>}
        </ul>
        <p className="muted text-xs mb-4">In <span className="mono">NWU Semester 2\{mod.code}\Resources\</span></p>

        <div className="section-label mb-2">2 · Paste this prompt</div>
        <pre className="text-xs whitespace-pre-wrap max-h-48 overflow-y-auto" style={{ background: 'rgba(2,8,22,.5)', borderRadius: 10, padding: 12, border: '1px solid var(--line)', color: 'var(--text)' }}>{prompt}</pre>
        <button onClick={copy} className="btn w-full mt-3" style={{ background: accent, borderColor: accent, color: '#04121f' }}>
          {copied ? 'Copied ✓' : 'Copy prompt'}
        </button>
      </div>
    </div>
  )
}

function Section({ title, empty, children }) {
  return (
    <section>
      <h2 className="section-label mb-3">{title}</h2>
      {empty ? <p className="muted text-sm">{empty}</p> : children}
    </section>
  )
}

// ---- shared download helper: signed URL (works for viewers too), blob fallback ----
async function downloadResource(path) {
  const { data, error } = await supabase.storage.from('resources').createSignedUrl(path, 300)
  if (!error && data?.signedUrl) { window.open(data.signedUrl, '_blank', 'noopener'); return }
  const dl = await supabase.storage.from('resources').download(path)
  if (dl.error) { alert('Download failed: ' + dl.error.message); return }
  const url = URL.createObjectURL(dl.data)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

function humanSize(bytes) {
  if (bytes == null) return ''
  const kb = bytes / 1024
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`
}

// ---- Codex · Files (course PDFs + NotebookLM slide PDFs) ----
function CodexFiles({ resources, units, accent }) {
  if (!resources.length) return null
  const unitById = {}
  units.forEach((u) => { unitById[u.id] = u })
  const groups = [
    { key: 'course_pdf', label: 'Course PDFs', items: resources.filter((r) => r.kind === 'course_pdf') },
    { key: 'notebooklm', label: 'NotebookLM Slides', items: resources.filter((r) => r.kind === 'notebooklm') },
    { key: 'other', label: 'Other', items: resources.filter((r) => r.kind === 'other') },
  ].filter((g) => g.items.length)

  return (
    <Section title="Codex · Files">
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.key}>
            <div className="section-label mb-2" style={{ color: accent }}>{g.label}</div>
            <div className="panel">
              {g.items.map((r) => {
                const unit = r.unit_id ? unitById[r.unit_id] : null
                return (
                  <div className="row" key={r.id}>
                    <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
                      <span className="truncate">📄 {r.title}</span>
                      {unit && <span className="chip">Unit {unit.number}</span>}
                    </span>
                    <span className="flex items-center gap-3" style={{ flex: '0 0 auto' }}>
                      {r.size_bytes != null && <span className="muted text-xs">{humanSize(r.size_bytes)}</span>}
                      <button onClick={() => downloadResource(r.storage_path)} className="btn small ghost"
                        style={{ borderColor: accent, color: accent }}>⭳ Download</button>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ---- Training Grounds · Past & Practice Papers ----
function TrainingGrounds({ papers, accent }) {
  if (!papers.length) return null
  return (
    <Section title="Training Grounds · Past & Practice Papers">
      <div className="panel">
        {papers.map((p) => (
          <div className="row" key={p.id}>
            <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
              <span className="truncate">{p.title}</span>
              {p.kind === 'practice' && (
                <span className="chip" style={{ borderColor: accent, color: accent }}>practice</span>
              )}
            </span>
            <span className="flex items-center gap-2" style={{ flex: '0 0 auto' }}>
              <button onClick={() => downloadResource(p.paper_path)} className="btn small"
                style={{ background: accent, borderColor: accent, color: '#04121f' }}>Paper</button>
              {p.memo_path
                ? <button onClick={() => downloadResource(p.memo_path)} className="btn small ghost"
                    style={{ borderColor: accent, color: accent }}>Memo</button>
                : <span className="chip" title="No memo yet">memo —</span>}
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

// ---- Party Quests · pair-project part checklists ----
function PartyQuests({ parts, setParts, assessments, profiles, userId, accent }) {
  const [toast, setToast] = useState('')

  // group parts under their assessment, keeping assessment order
  const byAssessment = assessments
    .map((a) => ({ a, parts: parts.filter((p) => p.assessment_id === a.id) }))
    .filter((g) => g.parts.length)
  if (!byAssessment.length) return null

  const nameFor = (uid) => {
    if (uid === userId) return 'You'
    return profiles[uid]?.display_name || (profiles[uid]?.role === 'viewer' ? 'Partner' : 'Owner')
  }

  // optimistic write; revert + toast on failure (house rule: never drop a save silently)
  async function savePart(part, fields) {
    const prev = { done: part.done, done_at: part.done_at, note: part.note }
    setParts((ps) => ps.map((p) => (p.id === part.id ? { ...p, ...fields } : p)))
    const { data, error } = await supabase.from('project_parts').update(fields).eq('id', part.id).select('id')
    if (error || !data?.length) {
      setParts((ps) => ps.map((p) => (p.id === part.id ? { ...p, ...prev } : p)))
      setToast('Could not save — ' + (error?.message || 'not authorised'))
      setTimeout(() => setToast(''), 4000)
      return false
    }
    return true
  }

  const toggle = (part) => {
    const done = !part.done
    savePart(part, { done, done_at: done ? new Date().toISOString() : null })
  }

  return (
    <Section title="Party Quests">
      {toast && (
        <div className="panel p-3 mb-3 text-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{toast}</div>
      )}
      <div className="space-y-4">
        {byAssessment.map(({ a, parts: aParts }) => {
          const done = aParts.filter((p) => p.done).length
          return (
            <div key={a.id} className="panel p-4" style={{ borderTop: `2px solid ${accent}` }}>
              <div className="flex items-center justify-between gap-3 mb-3">
                <div className="font-bold" style={{ color: '#eaf4ff', fontSize: 16 }}>{a.title}</div>
                <span className="chip" style={{ borderColor: accent, color: accent }}>{done}/{aParts.length} done</span>
              </div>
              <div className="space-y-2">
                {aParts.map((p) => {
                  const mine = p.assigned_to === userId
                  return (
                    <div key={p.id} className="flex items-start gap-3" style={{ padding: '6px 2px' }}>
                      <button
                        onClick={mine ? () => toggle(p) : undefined}
                        aria-label={p.done ? 'Done' : 'Not done'}
                        disabled={!mine}
                        style={{
                          flex: '0 0 auto', width: 22, height: 22, marginTop: 1, borderRadius: 6,
                          border: `2px solid ${p.done ? accent : 'var(--line-strong)'}`,
                          background: p.done ? accent : 'transparent',
                          color: '#04121f', fontWeight: 900, fontSize: 14, lineHeight: '18px',
                          cursor: mine ? 'pointer' : 'default',
                        }}
                      >{p.done ? '✓' : ''}</button>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span style={{ color: p.done ? 'var(--muted)' : 'var(--text)', textDecoration: p.done ? 'line-through' : 'none' }}>
                            {p.title}
                          </span>
                          <span className="chip">{nameFor(p.assigned_to)}</span>
                          {p.done && p.done_at && (
                            <span className="muted text-xs">{new Date(p.done_at).toLocaleDateString()}</span>
                          )}
                        </div>
                        {mine ? (
                          <input
                            className="input mt-2" style={{ fontSize: 14, padding: '7px 10px' }}
                            defaultValue={p.note || ''} placeholder="Add a note…"
                            onBlur={(e) => { if ((e.target.value || '') !== (p.note || '')) savePart(p, { note: e.target.value || null }) }}
                          />
                        ) : (
                          p.note && <div className="muted text-sm mt-1">“{p.note}”</div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
