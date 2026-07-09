import { useEffect, useState } from 'react'
import { supabase } from './lib/supabase'
import { signInOrUp, signOut } from './lib/auth'

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (loading) return <Centered>Loading…</Centered>
  return session ? <Dashboard /> : <Login />
}

function Centered({ children }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500">
      {children}
    </div>
  )
}

function Login() {
  const [username, setUsername] = useState('megzieberr')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true); setErr('')
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
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
        />

        <label className="block text-sm font-medium text-slate-600">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-slate-400"
        />

        {err && <p className="text-sm text-rose-600 mb-3">{err}</p>}

        <button
          disabled={busy || !password}
          className="w-full rounded-lg bg-slate-800 text-white py-2 font-medium disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Enter'}
        </button>
        <p className="text-xs text-slate-400 mt-4">First time here? Just pick a password — it creates your account.</p>
      </form>
    </div>
  )
}

function Dashboard() {
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
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-lg font-bold text-slate-800">NWU Study Hub</h1>
          <button onClick={signOut} className="text-sm text-slate-500 hover:text-slate-800">Sign out</button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-10">
        {error && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 text-sm">
            {error} — if this mentions a missing table, the schema hasn't been run yet.
          </div>
        )}

        <Section title="Modules" empty={!modules.length && 'No modules yet — a tutor will seed these when it orients itself.'}>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {modules.map((m) => (
              <div key={m.id} className="bg-white rounded-xl border border-slate-200 p-4"
                   style={{ borderTopColor: m.colour || '#64748b', borderTopWidth: 3 }}>
                <div className="text-xs font-mono text-slate-400">{m.code}</div>
                <div className="font-semibold text-slate-800 mt-1 leading-snug">{m.title}</div>
              </div>
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
              <li key={g.id} className="bg-white rounded-lg border border-slate-200 px-4 py-2 text-slate-700">
                {g.text}
              </li>
            ))}
          </ul>
        </Section>
      </main>
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
