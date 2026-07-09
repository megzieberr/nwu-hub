import { useEffect, useState, useRef } from 'react'
import { supabase } from './lib/supabase'
import { signInOrUp, signOut } from './lib/auth'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState({ name: 'dashboard' })

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (loading) return <Centered>Loading…</Centered>
  if (!session) return <Login />
  return view.name === 'module' ? (
    <ModulePage code={view.code} onBack={() => setView({ name: 'dashboard' })} />
  ) : (
    <Dashboard onOpenModule={(code) => setView({ name: 'module', code })} />
  )
}

function Centered({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500">{children}</div>
  )
}

function Header({ children, onBack }) {
  return (
    <header className="bg-white border-b border-slate-200">
      <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-slate-400 hover:text-slate-800 text-sm">← Back</button>
          )}
          <h1 className="text-lg font-bold text-slate-800">NWU Study Hub</h1>
        </div>
        <div className="flex items-center gap-4">{children}
          <button onClick={signOut} className="text-sm text-slate-500 hover:text-slate-800">Sign out</button>
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
      setErr(e.message || 'Could not log in.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 px-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <h1 className="text-2xl font-bold text-slate-800">NWU Study Hub</h1>
        <p className="text-sm text-slate-500 mt-1 mb-6">Your semester, in one place.</p>
        <label className="block text-sm font-medium text-slate-600">Username</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400" />
        <label className="block text-sm font-medium text-slate-600">Password</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400" />
        {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}
        <button disabled={busy || !password} className="w-full rounded-lg bg-slate-800 text-white py-2 font-medium disabled:opacity-50">
          {busy ? 'Working…' : 'Enter'}
        </button>
        <p className="text-xs text-slate-400 mt-4">First time here? Just pick a password — it creates your account.</p>
      </form>
    </div>
  )
}

function Dashboard({ onOpenModule }) {
  const [modules, setModules] = useState([])
  const [deadlines, setDeadlines] = useState([])
  const [goals, setGoals] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    (async () => {
      const [m, a, g] = await Promise.all([
        supabase.from('modules').select('*').order('code'),
        supabase.from('assessments').select('*, modules(code)').eq('status', 'upcoming').order('due_date'),
        supabase.from('goals').select('*').eq('done', false).order('target_date'),
      ])
      if (m.error) setError(m.error.message)
      setModules(m.data || [])
      setDeadlines(a.data || [])
      setGoals(g.data || [])
    })()
  }, [])

  return (
    <div className="min-h-screen bg-slate-50">
      <Header />
      <main className="max-w-5xl mx-auto px-6 py-8 space-y-10">
        {error && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 text-sm">
            {error} — if this mentions a missing table, the schema hasn't been run yet.
          </div>
        )}

        <Section title="Modules" empty={!modules.length && 'No modules yet — a tutor will seed these when it orients itself.'}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {modules.map((m) => (
              <button key={m.id} onClick={() => onOpenModule(m.code)}
                className="text-left bg-white rounded-xl border border-slate-200 p-4 hover:shadow-md hover:border-slate-300 transition"
                style={{ borderTopColor: m.colour || '#64748b', borderTopWidth: 3 }}>
                <div className="text-xs font-mono text-slate-400">{m.code}</div>
                <div className="font-semibold text-slate-800 mt-1 leading-snug">{m.title}</div>
                <div className="text-xs text-slate-400 mt-2">Open →</div>
              </button>
            ))}
          </div>
        </Section>

        <Section title="Upcoming deadlines" empty={!deadlines.length && 'Nothing due yet.'}>
          <ul className="divide-y divide-slate-100 bg-white rounded-xl border border-slate-200">
            {deadlines.map((d) => (
              <li key={d.id} className="px-4 py-3 flex items-center justify-between">
                <span className="text-slate-700">
                  <span className="font-mono text-xs text-slate-400 mr-2">{d.modules?.code}</span>
                  {d.title}
                </span>
                <span className="text-sm text-slate-500">{d.due_date || '—'}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="This week's goals" empty={!goals.length && 'No goals set.'}>
          <ul className="space-y-2">
            {goals.map((g) => (
              <li key={g.id} className="bg-white rounded-lg border border-slate-200 px-4 py-2 text-slate-700">{g.text}</li>
            ))}
          </ul>
        </Section>
      </main>
    </div>
  )
}

function ModulePage({ code, onBack }) {
  const [mod, setMod] = useState(null)
  const [units, setUnits] = useState([])
  const [summaries, setSummaries] = useState([])
  const [assessments, setAssessments] = useState([])
  const [openSummary, setOpenSummary] = useState(null)
  const [showKit, setShowKit] = useState(false)

  useEffect(() => {
    (async () => {
      const { data: m } = await supabase.from('modules').select('*').eq('code', code).maybeSingle()
      if (!m) return
      setMod(m)
      const [u, s, a] = await Promise.all([
        supabase.from('study_units').select('*').eq('module_id', m.id).order('number'),
        supabase.from('summaries').select('id,title,kind,unit_id,html').eq('module_id', m.id).order('created_at'),
        supabase.from('assessments').select('*').eq('module_id', m.id).order('due_date'),
      ])
      setUnits(u.data || [])
      setSummaries(s.data || [])
      setAssessments(a.data || [])
    })()
  }, [code])

  if (!mod) return (<div className="min-h-screen bg-slate-50"><Header onBack={onBack} /><Centered>Loading module…</Centered></div>)

  const summariesFor = (unitId) => summaries.filter((s) => s.unit_id === unitId)
  const accent = mod.colour || '#64748b'

  return (
    <div className="min-h-screen bg-slate-50">
      <Header onBack={onBack}>
        <button onClick={() => setShowKit(true)} className="text-sm font-medium text-white rounded-lg px-3 py-1.5"
          style={{ background: accent }}>🎙️ NotebookLM kit</button>
      </Header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-10">
        <div>
          <div className="text-xs font-mono text-slate-400">{mod.code}</div>
          <h2 className="text-2xl font-bold text-slate-800 mt-1">{mod.title}</h2>
          <div className="text-sm text-slate-500 mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {mod.credits != null && <span>{mod.credits} credits</span>}
            {mod.nqf_level != null && <span>NQF {mod.nqf_level}</span>}
            {mod.participation_pct != null && <span>Participation {mod.participation_pct}% · Exam {mod.exam_pct}%</span>}
            {mod.pass_min != null && <span>Pass {mod.pass_min}% (exam min {mod.exam_min}%)</span>}
          </div>
        </div>

        <Section title="Study units">
          <div className="space-y-3">
            {units.map((u) => (
              <div key={u.id} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-slate-800">
                    <span className="text-slate-400 mr-2">{u.number}.</span>{u.title}
                  </div>
                  <span className="text-xs rounded-full px-2 py-0.5 bg-slate-100 text-slate-500">{u.status.replace('_', ' ')}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {summariesFor(u.id).length ? summariesFor(u.id).map((s) => (
                    <button key={s.id} onClick={() => setOpenSummary(s)}
                      className="text-sm rounded-lg border px-3 py-1.5 hover:bg-slate-50"
                      style={{ borderColor: accent, color: accent }}>
                      📄 {s.title}
                    </button>
                  )) : <span className="text-sm text-slate-400">No summary yet — ask your tutor to make one.</span>}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Assessments" empty={!assessments.length && 'None yet.'}>
          <ul className="divide-y divide-slate-100 bg-white rounded-xl border border-slate-200">
            {assessments.map((a) => (
              <li key={a.id} className="px-4 py-3 flex items-center justify-between">
                <span className="text-slate-700">{a.title}</span>
                <span className="text-sm text-slate-500">{a.due_date || 'date TBC'}</span>
              </li>
            ))}
          </ul>
        </Section>
      </main>

      {openSummary && <SummaryViewer summary={openSummary} accent={accent} onClose={() => setOpenSummary(null)} />}
      {showKit && <NotebookLMKit mod={mod} units={units} accent={accent} onClose={() => setShowKit(false)} />}
    </div>
  )
}

function SummaryViewer({ summary, accent, onClose }) {
  const iframeRef = useRef(null)

  function savePdf() {
    const w = iframeRef.current?.contentWindow
    if (w) { w.focus(); w.print() }
  }
  function download() {
    const blob = new Blob([summary.html || ''], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = summary.title.replace(/[^\w.-]+/g, '_') + '.html'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/50 flex flex-col p-3 sm:p-6">
      <div className="bg-white rounded-xl overflow-hidden flex flex-col w-full max-w-4xl mx-auto flex-1 shadow-xl">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
          <span className="font-medium text-slate-700 text-sm truncate">{summary.title}</span>
          <div className="flex items-center gap-2">
            <button onClick={savePdf} className="text-sm text-white rounded-lg px-3 py-1.5" style={{ background: accent }}>⭳ Save as PDF</button>
            <button onClick={download} className="text-sm text-slate-600 rounded-lg px-3 py-1.5 border border-slate-300 hover:bg-slate-50">Download</button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-800 px-2">✕</button>
          </div>
        </div>
        <iframe ref={iframeRef} title={summary.title} srcDoc={summary.html}
          sandbox="allow-scripts allow-same-origin allow-modals allow-popups" className="flex-1 w-full bg-white" />
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
    `Audience: a distance-learning B.Ed student revising for open-book tests. Keep it friendly and concrete, not too formal.`

  function copy() {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="font-bold text-slate-800">🎙️ NotebookLM podcast kit</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-800">✕</button>
        </div>
        <p className="text-sm text-slate-500 mb-4">Open NotebookLM → new notebook → upload these sources → paste the prompt → generate an Audio Overview.</p>

        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">1 · Upload these files</div>
        <ul className="text-sm text-slate-700 bg-slate-50 rounded-lg p-3 mb-2">
          {sources.length ? sources.map((s) => <li key={s} className="font-mono text-xs py-0.5">{s}</li>)
            : <li className="text-slate-400">No source files recorded yet.</li>}
        </ul>
        <p className="text-xs text-slate-400 mb-4">Find them in <span className="font-mono">NWU Semester 2\{mod.code}\Resources\</span></p>

        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">2 · Paste this prompt</div>
        <pre className="text-xs text-slate-700 bg-slate-50 rounded-lg p-3 whitespace-pre-wrap max-h-48 overflow-y-auto">{prompt}</pre>
        <button onClick={copy} className="mt-3 w-full text-white rounded-lg py-2 text-sm font-medium" style={{ background: accent }}>
          {copied ? 'Copied ✓' : 'Copy prompt'}
        </button>
      </div>
    </div>
  )
}

function Section({ title, empty, children }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400 mb-3">{title}</h2>
      {empty ? <p className="text-slate-400 text-sm">{empty}</p> : children}
    </section>
  )
}
