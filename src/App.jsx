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

// Relative time for the last-sync line: "just now" / "3h ago" / "2d ago", else a date.
function timeAgo(ts) {
  if (!ts) return 'never'
  const then = new Date(ts).getTime()
  if (isNaN(then)) return 'never'
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function syncStatusColour(status) {
  if (status === 'auth_failed' || status === 'error') return 'var(--red)'
  if (status === 'partial') return '#f0b232'
  return 'var(--cyan)'
}

// Small UTC date helpers for the weekly Classes window. All take/return 'YYYY-MM-DD'; noon-UTC
// anchoring keeps a whole-day shift from ever crossing a date boundary.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function weekdayIndex(dateStr) {   // 0 = Monday … 6 = Sunday
  return (new Date(dateStr + 'T12:00:00Z').getUTCDay() + 6) % 7
}
function mondayOf(dateStr) {
  return addDays(dateStr, -weekdayIndex(dateStr))
}

// The sync fails SILENTLY by design (no push, no email) — this banner is the one loud surface.
// Two triggers: the last run failed outright, or no run has landed in >26h (schedule is every
// 12h; 26h = both daily runs missed even allowing for GitHub's best-effort cron drift). The
// stale case matters most: a dead schedule writes NO run rows, so only the clock can catch it.
const SYNC_STALE_MS = 26 * 60 * 60 * 1000
export function syncProblem(lastSync, now = Date.now()) {
  if (!lastSync) return null
  if (lastSync.status === 'auth_failed') return 'auth'
  if (lastSync.status === 'error') return 'error'
  const t = new Date(lastSync.finished_at || lastSync.started_at).getTime()
  if (!isNaN(t) && now - t > SYNC_STALE_MS) return 'stale'
  return null
}

function SyncAlert({ lastSync }) {
  const problem = syncProblem(lastSync)
  if (!problem) return null
  const when = timeAgo(lastSync.finished_at || lastSync.started_at)
  const colour = problem === 'stale' ? '#f0b232' : 'var(--red)'
  return (
    <div className="panel p-4 text-sm" style={{ borderColor: colour, color: colour }}>
      {problem === 'auth' && (
        <>⚠️ <b>eFundi sync can't log in</b> (last try {when}) — your NWU password probably changed.
          Update the <span className="mono">EFUNDI_PASSWORD</span> secret (GitHub → nwu-hub → Settings →
          Secrets → Actions), then re-run the sync from the Actions tab. New eFundi posts are NOT arriving.</>
      )}
      {problem === 'error' && (
        <>⚠️ <b>eFundi sync failed</b> on its last run ({when}) — check the log: GitHub → nwu-hub →
          Actions → eFundi sync. New eFundi posts may not be arriving.</>
      )}
      {problem === 'stale' && (
        <>⚠️ <b>eFundi sync hasn't run since {when}</b> — the schedule may be stuck or disabled.
          Check GitHub → nwu-hub → Actions (a green manual "Run workflow" clears this).</>
      )}
    </div>
  )
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
  const [showDone, setShowDone] = useState(false)
  const [lastSync, setLastSync] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setName(data.user?.email?.split('@')[0] || 'Student'))
    ;(async () => {
      const [m, a] = await Promise.all([
        supabase.from('modules').select('*').order('code'),
        supabase.from('assessments').select('*, modules(code,colour,hidden)').eq('status', 'upcoming').order('due_date'),
      ])
      if (m.error) setError(m.error.message)
      // Hidden modules still sync (their announcements feed the objectives agent) but get no
      // dashboard tile — drop them here so both the grid and the module count skip them.
      setModules((m.data || []).filter((x) => !x.hidden))
      // ...and keep a hidden module's assessments out of the Quest Log too, so nothing but its
      // announcements ever surfaces on the dashboard.
      setDeadlines((a.data || []).filter((d) => !d.modules?.hidden))
      // Personal study goals are owner-only — a read-only viewer never sees this section.
      // Done ones are fetched too but hidden by default (tucked under the "Done" tab so a
      // mistaken tick can be undone); active ones show, ordered by target date.
      if (!isViewer) {
        const g = await supabase.from('goals').select('*, modules(code,colour)')
          .order('done').order('target_date', { nullsFirst: false })
        setGoals(g.data || [])
        // Latest eFundi sync run (owner-only via RLS). Table may not exist pre-0005 → error
        // object, not a throw, so this stays silent and the indicator simply hides.
        const ls = await supabase.from('efundi_sync_runs')
          .select('started_at, finished_at, status, items_new')
          .order('started_at', { ascending: false }).limit(1).maybeSingle()
        setLastSync(ls.data || null)
      }
    })()
  }, [isViewer])

  // Dashboard-only cutoff so the quest log reads as "what's actually coming up", not the
  // whole semester's dread. The full list (incl. date-TBC ones) still lives on each module's
  // Assessments page — this just trims the emotional load of the home screen.
  const QUEST_WINDOW_MS = 21 * 24 * 60 * 60 * 1000
  const questLog = deadlines.filter((d) => {
    if (!d.due_date) return false
    const due = new Date(d.due_date).getTime()
    return !isNaN(due) && due - Date.now() <= QUEST_WINDOW_MS
  })

  // Classes are agent-tagged goals (kind='class'), shown on their own and scoped to THIS WEEK only
  // (Mon–Sun) — the home screen shows what's on now, not the whole semester. A one-off class shows
  // only in the week its date falls in, then drops off. A recurring class (recurring=true — the
  // lecturer said it runs weekly on a standing link) always shows, placed on its weekday for the
  // current week (weekday derived from target_date). Date strings sort/compare lexically.
  const weekStartStr = mondayOf(new Date().toISOString().slice(0, 10))
  const weekEndStr = addDays(weekStartStr, 6)
  const classes = goals
    .filter((g) => g.kind === 'class')
    .map((g) => ({
      ...g,
      // recurring → this week's occurrence on the same weekday; one-off → its own date.
      showDate: g.recurring && g.target_date
        ? addDays(weekStartStr, weekdayIndex(g.target_date))
        : g.target_date,
    }))
    .filter((g) => g.recurring || (g.showDate && g.showDate >= weekStartStr && g.showDate <= weekEndStr))
    .sort((a, b) => (a.showDate || '9999-99-99').localeCompare(b.showDate || '9999-99-99'))

  // Optimistic tick: flip `done` locally, then persist. On failure, revert and surface it.
  async function toggleGoal(goal) {
    const done = !goal.done
    setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, done } : g)))
    const { error: e } = await supabase.from('goals').update({ done }).eq('id', goal.id)
    if (e) {
      setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, done: goal.done } : g)))
      setError('Could not save objective — ' + e.message)
    }
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="max-w-5xl mx-auto px-6 py-8 space-y-9">
        <SyncAlert lastSync={lastSync} />
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
            {lastSync && (
              <div className="muted text-xs mt-1 flex items-center gap-2">
                <span style={{ color: syncStatusColour(lastSync.status) }}>●</span>
                <span>eFundi · synced {timeAgo(lastSync.finished_at || lastSync.started_at)}
                  {lastSync.status === 'auth_failed' ? ' · login failed'
                    : lastSync.status === 'error' ? ' · error'
                    : lastSync.status === 'partial' ? ' · partial' : ''}</span>
              </div>
            )}
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

        <Section title="Quest Log · Upcoming" empty={!questLog.length && 'Nothing due in the next 3 weeks.'}>
          <div className="panel">
            {questLog.map((d) => {
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
          <Section title="Classes · This Week" empty={!classes.length && 'No classes scheduled this week.'}>
            <div className="panel">
              {classes.map((g) => <ClassRow key={g.id} g={g} />)}
            </div>
          </Section>
        )}

        {!isViewer && (() => {
          const objectives = goals.filter((g) => g.kind !== 'class')
          const active = objectives.filter((g) => !g.done)
          const done = objectives.filter((g) => g.done)
          return (
            <Section title="Objectives" empty={!objectives.length && 'No goals set.'}>
              <div className="panel">
                {active.length
                  ? active.map((g) => <ObjectiveRow key={g.id} g={g} onToggle={toggleGoal} />)
                  : <div className="row"><span className="muted text-sm">All clear — nothing outstanding.</span></div>}
              </div>
              {done.length > 0 && (
                <div className="mt-3">
                  <button onClick={() => setShowDone((v) => !v)} className="btn small ghost"
                    aria-expanded={showDone}
                    style={{ borderColor: 'var(--line-strong)', color: 'var(--muted)' }}>
                    {showDone ? '▾' : '▸'} Objectives Done ({done.length})
                  </button>
                  {showDone && (
                    <div className="panel mt-2" style={{ opacity: 0.9 }}>
                      {done.map((g) => <ObjectiveRow key={g.id} g={g} onToggle={toggleGoal} />)}
                    </div>
                  )}
                </div>
              )}
            </Section>
          )
        })()}
      </main>
    </div>
  )
}

// One class row. No tick — a class isn't "done", it just passes and drops out of the 3-week
// window on its own. Left border is the module colour (matches the Quest Log). The join link,
// when present, is a tappable "Join →" (lecturers change it most weeks, so it lives on the row).
function ClassRow({ g }) {
  const c = g.modules?.colour || 'var(--cyan)'
  return (
    <div className="row" style={{ borderLeft: `3px solid ${c}`, paddingLeft: 14, gap: 12 }}>
      <span style={{ flex: 1, minWidth: 0 }}>
        {g.text}
        {g.recurring && (
          <span className="mono text-xs" style={{
            marginLeft: 8, padding: '1px 6px', borderRadius: 5, whiteSpace: 'nowrap',
            border: `1px solid ${c}`, color: c,
          }}>WEEKLY</span>
        )}
      </span>
      {g.link && (
        <a
          href={g.link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm"
          style={{ color: 'var(--cyan)', whiteSpace: 'nowrap', fontWeight: 600 }}
        >Join →</a>
      )}
      {g.showDate && <span className="muted text-sm">{g.showDate}</span>}
    </div>
  )
}

// One objective row. Ticking it moves it out of the active list (vanishes) into the "Done"
// tab — no strike-through, no pile-up. Untick from the Done tab to bring it back.
function ObjectiveRow({ g, onToggle }) {
  return (
    <div className="row" style={{ gap: 12 }}>
      <button
        onClick={() => onToggle(g)}
        aria-label={g.done ? 'Mark not done' : 'Mark done'}
        style={{
          flex: '0 0 auto', width: 22, height: 22, borderRadius: 6,
          border: `2px solid ${g.done ? 'var(--cyan)' : 'var(--line-strong)'}`,
          background: g.done ? 'var(--cyan)' : 'transparent',
          color: '#04121f', fontWeight: 900, fontSize: 14, lineHeight: '18px', cursor: 'pointer',
        }}
      >{g.done ? '✓' : ''}</button>
      <span style={{ flex: 1, minWidth: 0, color: g.done ? 'var(--muted)' : 'var(--text)' }}>
        {g.text}
        {g.link && (
          <a
            href={g.link}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-sm"
            style={{ marginLeft: 8, color: 'var(--cyan)', whiteSpace: 'nowrap', fontWeight: 600 }}
          >Join →</a>
        )}
      </span>
      {g.target_date && <span className="muted text-sm">{g.target_date}</span>}
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
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    (async () => {
      const { data: m, error: mErr } = await supabase.from('modules').select('*').eq('code', code).maybeSingle()
      if (mErr || !m) { setLoadError(mErr?.message || 'Module not found.'); return }
      setMod(m)
      // The last three tables (0003) may not exist pre-migration — Supabase returns an error
      // object rather than throwing, so `?.data || []` just yields empty sections. Safe.
      // NOTE: eFundi-synced raw content (announcements, files) is deliberately NOT shown here —
      // the hub surfaces only tutor-authored work. Announcements feed the objectives agent; synced
      // files are tutor fuel. See docs/efundi-sync-plan.md. Only owner-curated files render (below).
      const [u, s, a, res, pp, profs] = await Promise.all([
        supabase.from('study_units').select('*').eq('module_id', m.id).order('number'),
        supabase.from('summaries').select('id,title,kind,unit_id,assessment_id,html').eq('module_id', m.id).order('created_at'),
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

  if (!mod) return (
    <div className="min-h-screen"><Header onBack={onBack} />
      <Centered>{loadError ? <span style={{ color: 'var(--red)' }}>{loadError}</span> : 'Loading module…'}</Centered>
    </div>
  )

  // Unit summaries live under Study Units; assessment-linked briefs live under Assessments.
  // A brief sets assessment_id (unit_id null), so guarding on both keeps them from doubling up.
  const summariesFor = (unitId) => summaries.filter((s) => s.unit_id === unitId && !s.assessment_id)
  // A "(START HERE)" brief covers the whole assessment set, so float it to the top of the
  // section instead of nesting it under whichever single assessment it happens to be linked to.
  const isOverviewBrief = (s) => /\(start here\)/i.test(s.title || '')
  const overviewBriefs = summaries.filter((s) => s.assessment_id && isOverviewBrief(s))
  const briefsFor = (assessmentId) => summaries.filter((s) => s.assessment_id === assessmentId && !isOverviewBrief(s))
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
          {(() => {
            // Section-style modules (e.g. MATV121) title their units "S.S. 1.1: …". These get
            // grouped under their parent Study Unit; every other module keeps the flat list.
            const isSectioned = units.some((u) => /^\s*S\.S\.?\s*\d/.test(u.title))
            const renderPanel = (u, showNum) => (
              <div key={u.id} className="panel p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-bold" style={{ color: '#eaf4ff', fontSize: 16 }}>
                    {showNum && <span className="muted" style={{ marginRight: 8 }}>{u.number}.</span>}{u.title}
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
            )
            if (!isSectioned) {
              return <div className="space-y-3">{units.map((u) => renderPanel(u, true))}</div>
            }
            const groupNum = (u) => { const m = u.title.match(/S\.S\.?\s*(\d+)\./); return m ? Number(m[1]) : 0 }
            const groupLabel = (g) => {
              const first = units.find((u) => groupNum(u) === g)
              const m = first?.notes?.match(/^Study Unit \d[^·]*/)
              return m ? m[0].trim() : `Study Unit ${g}`
            }
            const groups = [...new Set(units.map(groupNum))].sort((a, b) => a - b)
            return (
              <div className="space-y-5">
                {groups.map((g) => (
                  <div key={g}>
                    <div className="section-label mb-2" style={{ color: accent }}>{groupLabel(g)}</div>
                    <div className="space-y-3">
                      {units.filter((u) => groupNum(u) === g).map((u) => renderPanel(u, false))}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </Section>

        <Section title="Assessments" empty={!assessments.length && 'None yet.'}>
          {overviewBriefs.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-2">
              {overviewBriefs.map((s) => (
                <button key={s.id} onClick={() => setOpenSummary(s)} className="btn small ghost" style={{ borderColor: accent, color: accent }}>
                  📋 {s.title}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-3">
            {assessments.map((a) => {
              const briefs = briefsFor(a.id)
              return (
                <div key={a.id} className="panel p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span style={{ color: '#eaf4ff' }}>{a.title}</span>
                    <span className="muted text-sm" style={{ flex: '0 0 auto' }}>{a.due_date || 'date TBC'}</span>
                  </div>
                  {briefs.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {briefs.map((s) => (
                        <button key={s.id} onClick={() => setOpenSummary(s)} className="btn small ghost" style={{ borderColor: accent, color: accent }}>
                          📋 {s.title}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </Section>

        <CodexFiles resources={resources} units={units} accent={accent} />

        <TrainingGrounds papers={papers} accent={accent} isViewer={isViewer} />

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
// Uses an anchor click rather than window.open: after the awaits above, the browser's
// user-activation has expired, so window.open() is silently killed by popup blockers
// (common on phones) and returns null with no error — the partner's download would just
// do nothing. An <a> click is far more reliable, and any failure is surfaced, never dropped.
async function downloadResource(path) {
  try {
    let href, revoke
    const { data, error } = await supabase.storage.from('resources').createSignedUrl(path, 300)
    if (!error && data?.signedUrl) {
      href = data.signedUrl
    } else {
      const dl = await supabase.storage.from('resources').download(path)
      if (dl.error) throw dl.error
      href = URL.createObjectURL(dl.data)
      revoke = href
    }
    const a = document.createElement('a')
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener'
    a.download = path.split('/').pop() || ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    if (revoke) setTimeout(() => URL.revokeObjectURL(revoke), 60000)
  } catch (e) {
    alert('Download failed: ' + (e?.message || e))
  }
}

function humanSize(bytes) {
  if (bytes == null) return ''
  const kb = bytes / 1024
  return kb < 1024 ? `${Math.max(1, Math.round(kb))} KB` : `${(kb / 1024).toFixed(1)} MB`
}

// ---- Codex · Files (owner-curated PDFs + NotebookLM slides) ----
// eFundi-synced files are intentionally excluded — they're tutor fuel, not hub content.
function CodexFiles({ resources, units, accent }) {
  resources = resources.filter((r) => r.source !== 'efundi')
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
function TrainingGrounds({ papers, accent, isViewer }) {
  // Owner always sees the section (empty → placeholder, so she can confirm it renders);
  // a viewer only sees it once there's actually a paper to download.
  if (!papers.length && isViewer) return null
  return (
    <Section title="Training Grounds · Past & Practice Papers"
      empty={!papers.length && 'No papers uploaded yet — they’ll appear here once seeded.'}>
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
  const toastTimer = useRef(null)
  const partsRef = useRef(parts)       // freshest committed parts, for accurate revert
  const saveChains = useRef({})         // part.id -> in-flight save chain (serialises writes)
  useEffect(() => { partsRef.current = parts }, [parts])

  // group parts under their assessment, keeping assessment order
  const byAssessment = assessments
    .map((a) => ({ a, parts: parts.filter((p) => p.assessment_id === a.id) }))
    .filter((g) => g.parts.length)
  if (!byAssessment.length) return null

  const nameFor = (uid) => {
    if (uid === userId) return 'You'
    return profiles[uid]?.display_name || (profiles[uid]?.role === 'owner' ? 'Owner' : 'Partner')
  }

  function showToast(msg) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4000)
  }

  // Optimistic write, serialised per part. On failure we revert ONLY the fields this
  // request touched (never a stale whole-row snapshot), so a failed tick can't also wipe
  // a just-saved note, and a double-fail can't leave the UI disagreeing with the DB.
  function savePart(part, fields) {
    const run = async () => {
      const cur = partsRef.current.find((p) => p.id === part.id) || part
      const prev = Object.fromEntries(Object.keys(fields).map((k) => [k, cur[k]]))
      setParts((ps) => ps.map((p) => (p.id === part.id ? { ...p, ...fields } : p)))
      const { data, error } = await supabase.from('project_parts').update(fields).eq('id', part.id).select('id')
      if (error || !data?.length) {
        setParts((ps) => ps.map((p) => (p.id === part.id ? { ...p, ...prev } : p)))
        showToast('Could not save — ' + (error?.message || 'not authorised'))
        return false
      }
      return true
    }
    const chain = (saveChains.current[part.id] || Promise.resolve()).then(run, run)
    saveChains.current[part.id] = chain
    return chain
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
