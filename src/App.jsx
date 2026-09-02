import { useEffect, useState, useRef } from 'react'
import { supabase } from './lib/supabase'
import { signInOrUp, signOut } from './lib/auth'
import { qrSvg } from './lib/qr'
import { pushState, enablePush, disablePush } from './lib/push'
// Quest Log retired s19 (Megan: "My Week is better") — its both-ends window semantics live on
// inside lib/week.js's myWeek (overdue grace included). questWindow stays in lib/quests.js, tested
// but unrendered, in case she ever wants the full window back.
import { myWeek, weekAhead, dueLabel, formatDue } from './lib/week'
import { googleAddEventUrl } from './lib/classcal'
import CalendarFeedButton from './CalendarCard'
import SyncHealth from './SyncHealth'
import { syncFailure } from './lib/synchealth'
import { ping, pingMuted, setPingMuted } from './lib/ping'
import * as pen from './lib/pen'

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
  return (
    <>
      {view.name === 'module' ? (
        <ModulePage code={view.code} isViewer={isViewer} userId={session.user.id} onBack={() => setView({ name: 'dashboard' })} />
      ) : (
        <Dashboard isViewer={isViewer} userId={session.user.id} onOpenModule={(code) => setView({ name: 'module', code })} />
      )}
      {/* The Tests & Exams bubble rides above every view. Lize (viewer) sees the codes too — they're
          class-wide — but read-only: no add/fix, no editing (enforced by RLS and hidden in the UI). */}
      <ExamAccessFab userId={session.user.id} isViewer={isViewer} />
    </>
  )
}

function Centered({ children }) {
  return <div className="min-h-screen flex items-center justify-center muted">{children}</div>
}

// Relative time for the failure banner's "last try": "just now" / "3h ago" / "2d ago", else a date.
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

// The sync fails SILENTLY by design (no push, no email), so the hub is the only loud surface.
// TWO surfaces now, answering two different questions, and they must not be confused:
//
//   • the header line (SyncHealth) — "how long since one WORKED?" Freshness, including a schedule
//     that has quietly stopped firing. It owns staleness, at 14h.
//   • this banner — "did the last run FAIL, and what do I do about it?" A failure is worth saying
//     the moment it happens rather than waiting 14h for the header to go amber, and it is the only
//     place that can tell her WHICH thing broke and where to go and fix it.
//
// The 26h stale window that used to live here is gone: it was a second, looser answer to the
// header's question, and two thresholds for one idea is how you end up trusting neither.
function SyncAlert({ lastSync }) {
  const problem = syncFailure(lastSync)
  if (!problem) return null
  const when = timeAgo(lastSync.finished_at || lastSync.started_at)
  // A partial run still delivered most of the work, so it warns in amber rather than shouting red.
  const colour = problem === 'partial' ? '#f0b232' : 'var(--red)'
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
      {/* Kept from the retired panel line, which was the only thing that ever showed "· partial".
          It matters more than it looks: a partial run is not 'ok', so it never refreshes last_ok,
          and the header would sit quiet for 14h before admitting anything was wrong. */}
      {problem === 'partial' && (
        <>⚠️ <b>eFundi sync only partly finished</b> on its last run ({when}) — some modules may be
          out of date. Check the log: GitHub → nwu-hub → Actions → eFundi sync.</>
      )}
    </div>
  )
}

// 🔊 / 🔇 for the tick-off ping. It has an off switch on purpose: a sound with no way to silence
// it is a nuisance the first time you tick something off in a lecture. Per device, so a phone and
// a laptop keep their own answer — and so Lize's device does too (she ticks her own To Do List,
// even though the deadline and assessment ticks are hidden for a viewer).
//
// Unmuting plays the ping straight away, so the button demonstrates what it just switched on
// rather than leaving you to go and tick something to find out.
function PingToggle() {
  const [muted, setMuted] = useState(pingMuted)
  return (
    <button
      onClick={() => { const next = !muted; setPingMuted(next); setMuted(next); if (!next) ping() }}
      className="icon-btn"
      aria-label={muted ? 'Turn the tick sound on' : 'Turn the tick sound off'}
      title={muted ? 'Tick sound is off' : 'Tick sound is on'}
      style={{ padding: 0, width: 38, justifyContent: 'center', fontSize: 15,
        color: muted ? 'var(--muted)' : 'var(--cyan)',
        borderColor: muted ? 'var(--line)' : 'var(--cyan)' }}
    >{muted ? '🔇' : '🔊'}</button>
  )
}

// `sub` is a full-width line UNDER the brand row (the sync-health line uses it). It is deliberately
// not part of the right-hand button cluster: on a 390px phone that cluster is already full at three
// icons, and a sentence squeezed in beside them would wrap into a ribbon — the exact s18 failure.
function Header({ children, onBack, sub }) {
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
      {/* No padding of its own: `sub` may render nothing (the sync line hides itself when its RPC
          fails), and an empty padded strip would leave a dead gap under the brand row. The spacing
          belongs to whatever is inside. */}
      {sub && <div className="max-w-5xl mx-auto px-6">{sub}</div>}
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

function Dashboard({ isViewer, userId, onOpenModule }) {
  const [name, setName] = useState('')
  const [modules, setModules] = useState([])
  const [deadlines, setDeadlines] = useState([])
  const [goals, setGoals] = useState([])
  const [showDone, setShowDone] = useState(false)
  const [justDone, setJustDone] = useState(null)   // last deadline ticked off — holds the undo line
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
      // The To Do List, fetched for BOTH accounts since s22 (Lize asked for her own).
      //
      // `goals` carries 0001's owner-only RLS — 0002 deliberately left it OUT of the shared
      // hub_read/hub_write pair so personal goals stay private. That one rule already gives each
      // account its own list: this identical query returns Megan's rows to Megan and Lize's to
      // Lize, and neither can see the other's. Lize's therefore starts empty and only ever holds
      // what she types in, since the eFundi agent writes its goals under Megan's owner id.
      //
      // Done ones are fetched too but hidden by default (tucked under the "Done" toggle so a
      // mistaken tick can be undone); active ones show, ordered by target date.
      const g = await supabase.from('goals').select('*, modules(code,colour)')
        .order('done').order('target_date', { nullsFirst: false })
      setGoals(g.data || [])
      if (!isViewer) {
        // Latest eFundi sync run (owner-only via RLS, the 0005 owner_all policy). This feeds the
        // FAILURE banner only — freshness is the header line's job, off the sync_health() RPC.
        // Table may not exist pre-0005 → error object, not a throw, so this stays silent and the
        // banner simply hides.
        const ls = await supabase.from('efundi_sync_runs')
          .select('started_at, finished_at, status')
          .order('started_at', { ascending: false }).limit(1).maybeSingle()
        setLastSync(ls.data || null)
      }
    })()
  }, [isViewer])

  // My Week: at most one upcoming line per module (its next deadline) plus a red line for a
  // just-missed one (4-day grace, inherited from the retired Quest Log). Hidden modules are
  // already filtered out of `deadlines`.
  const myWeekRows = myWeek(deadlines)

  // Classes are agent-tagged goals (kind='class'), shown on their own and scoped to ONE week (Mon–Sun)
  // — the home screen shows what's on now, not the whole semester. A one-off class shows only in the
  // week its date falls in, then drops off. A recurring class (recurring=true — the lecturer said it
  // runs weekly on a standing link) always shows, placed on its weekday for the shown week (weekday
  // derived from target_date). Date strings sort/compare lexically.
  // On SUNDAYS the window rolls forward to next week, so the Sunday-evening sync surfaces the week
  // ahead (Sunday itself is effectively spent — uni classes don't run then).
  const todayStr = new Date().toISOString().slice(0, 10)
  const showNextWeek = weekdayIndex(todayStr) === 6   // 6 = Sunday
  const weekStartStr = mondayOf(showNextWeek ? addDays(todayStr, 1) : todayStr)
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

  // ---- ticking a deadline off (s22) ----------------------------------------------------------
  // Megan, 2026-08-24: "why is it screaming at me? you never added a way to tick it off?" — right.
  // `assessments.status` has held ('upcoming','submitted','graded','missed') since 0001 and NOTHING
  // in the app has ever written it, so every deadline stayed `upcoming` for ever and the red OVERDUE
  // row could only age out on the 4-day grace. No migration needed: the column exists, authenticated
  // already holds UPDATE on all 15 columns, and `hub_write` gates it to the owner (a viewer's tick
  // would be refused by RLS anyway — the button is hidden for them regardless).
  //
  // The dashboard only ever fetches status='upcoming' (and myWeek now drops non-upcoming rows too),
  // so a ticked item leaves the card at once. `justDone` keeps ONE undo line on screen afterwards:
  // without it, a mis-tap could only be fixed by walking into the module page, and the row that
  // vanished would be a missed deadline she still needs. The sync can't resurrect it either —
  // sync/write.js updates only worker-owned fields and never touches status.
  async function markDone(d) {
    ping()
    setDeadlines((ds) => ds.filter((x) => x.id !== d.id))
    setJustDone(d)
    const { error: e } = await supabase.from('assessments').update({ status: 'submitted' }).eq('id', d.id)
    if (e) {
      setDeadlines((ds) => [...ds, d])
      setJustDone(null)
      setError('Could not tick that off — ' + e.message)
    }
  }

  // Undo puts it back to 'upcoming'. The row is only restored to the list AFTER the write lands —
  // the opposite order to markDone above, on purpose: a failed undo must leave the line saying
  // "ticked off" (which is still true of the database) rather than showing a deadline that isn't.
  async function undoDone(d) {
    const { error: e } = await supabase.from('assessments').update({ status: 'upcoming' }).eq('id', d.id)
    if (e) { setError('Could not undo that — ' + e.message); return }
    setJustDone(null)
    setDeadlines((ds) => [...ds, d])
  }

  // Optimistic tick: flip `done` locally, then persist. On failure, revert and surface it.
  async function toggleGoal(goal) {
    const done = !goal.done
    // Only on the way IN. Unticking is a correction, not an achievement — rewarding it would
    // make the sound meaningless, and double-tapping a row would turn into a toy.
    // Fired before the await, like the optimistic state flip right below it: a ping that waits
    // for the round trip lands after the thumb has left the screen and stops feeling like a
    // response to the tap. The trade is a ping on a save that then fails — rare, and the row
    // visibly springs back with the error, so it can't be mistaken for a save that worked.
    if (done) ping()
    setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, done } : g)))
    const { error: e } = await supabase.from('goals').update({ done }).eq('id', goal.id)
    if (e) {
      setGoals((gs) => gs.map((g) => (g.id === goal.id ? { ...g, done: goal.done } : g)))
      setError('Could not save that — ' + e.message)
    }
  }

  // Add something by hand (s22 — Megan's ask, and the only way Lize's list ever gets anything).
  //
  // kind stays 'task' and is_test stays at its false default, ON PURPOSE: those are the two
  // columns send-push filters on (`kind='class'` for the ~45-min class nudge, `is_test=true` for
  // the test-morning one), so a hand-written item can never set off a phone notification for
  // either of them. source stays null too, which is what marks it hand-made — the eFundi agent
  // stamps 'efundi-agent', and its update path only ever reconsiders rows where kind='class',
  // so it can't reach these.
  //
  // owner must be set explicitly: the goals insert policy checks `owner = auth.uid()`, and there
  // is no column default, so an insert without it is rejected rather than silently mis-filed.
  async function addGoal({ text, targetDate, moduleId }) {
    const row = {
      owner: userId,
      module_id: moduleId || null,
      text: text.trim().slice(0, 300),
      target_date: targetDate || null,
      kind: 'task',
      done: false,
    }
    const { data, error: e } = await supabase.from('goals')
      .insert(row).select('*, modules(code,colour)').single()
    if (e) { setError('Could not add that — ' + e.message); return false }
    setGoals((gs) => [...gs, data])
    return true
  }

  // Only offered on hand-added rows (source null) — see the To Do List section below. Agent-written
  // objectives keep the tick alone, so a tap can't quietly delete something eFundi put there.
  async function deleteGoal(goal) {
    const before = goals
    setGoals((gs) => gs.filter((g) => g.id !== goal.id))
    const { error: e } = await supabase.from('goals').delete().eq('id', goal.id)
    if (e) {
      setGoals(before)
      setError('Could not delete that — ' + e.message)
    }
  }

  return (
    <div className="min-h-screen">
      {/* 📅 = the classes-in-my-calendar options (s22). Owner-only: the button also self-hides
          for anyone my_ics_token() returns null for, but the guard keeps it out of a viewer's
          render pass entirely, same pattern as the Classes and Objectives sections below. */}
      {/* The sync-health line rides under the brand row: quiet grey when eFundi is landing, an
          amber pill once the newest successful sync is over 14h old. Owner-only, same guard as the
          calendar button — a stuck sync is Megan's to act on, not Lize's to worry about. */}
      <Header sub={!isViewer && <SyncHealth />}><PingToggle />{!isViewer && <CalendarFeedButton />}</Header>
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
            {/* The "eFundi · synced 3h ago" line used to sit here. Megan's ruling 2026-09-02: fold
                the two freshness indicators into one. It said the same thing as the header line but
                counted from the last run of ANY status, so a run that failed still read as freshly
                synced — the exact reassurance that let six silent days pass. Its one unique piece,
                "· partial", moved into SyncAlert above rather than being dropped. */}
          </div>
        </div>

        <Section title="My Week · next deadline per module"
          empty={!myWeekRows.length && !justDone && 'Nothing coming up — all clear. 🎉'}>
          {myWeekRows.length > 0 && (
            <div className="panel">
              {myWeekRows.map((d) => {
                const c = d.overdue ? 'var(--red)' : (d.modules?.colour || 'var(--cyan)')
                // flexWrap: the date is nowrap by the s18 rule, so on a narrow phone it must drop
                // to its own line — NOT squeeze the title into a one-word-per-line ribbon (Megan's
                // 2026-08-17 phone screenshot). minWidth:120 forces the drop early enough that the
                // title keeps a readable column.
                return (
                  <div className="row" key={d.id} style={{ borderLeft: `3px solid ${c}`, paddingLeft: 14, gap: 10, flexWrap: 'wrap', rowGap: 4 }}>
                    <span className="chip" style={{ color: c, borderColor: c, flex: '0 0 auto' }}>{d.modules?.code}</span>
                    <span style={{ color: '#eaf4ff', minWidth: 120, flex: '1 1 0' }}>
                      {d.title}
                      {/* Others closing the same day. Named rather than hidden — the line used to
                          show one of four EDCC125 tests and looked like the only one. */}
                      {d.alsoDue > 0 && (
                        <span className="muted text-sm" style={{ marginLeft: 6 }}>
                          + {d.alsoDue} more due that day
                        </span>
                      )}
                    </span>
                    {/* Date and ✓ travel together in ONE right-hand group so the s19 wrap fix still
                        holds: on a narrow phone the whole group drops to its own line instead of the
                        tick stranding itself below a squeezed title. */}
                    <span style={{ marginLeft: 'auto', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="text-sm" style={{ whiteSpace: 'nowrap', color: d.overdue || d.thisWeek ? c : 'var(--muted, #8aa0b8)' }}>
                        {d.overdue ? `OVERDUE · was ${formatDue(d.due_date)}` : `${d.thisWeek ? '⏰ ' : ''}${formatDue(d.due_date)} · ${dueLabel(d.days)}`}
                      </span>
                      {!isViewer && (
                        <button onClick={() => markDone(d)} className="icon-btn"
                          aria-label={`Mark ${d.title} as done`} title="Mark as done"
                          style={{ padding: 0, width: 38, justifyContent: 'center', color: 'var(--muted)', fontSize: 15 }}>✓</button>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {justDone && (
            <div className="panel p-3 mt-3 flex items-center gap-3" style={{ flexWrap: 'wrap', rowGap: 8 }}>
              <span className="text-sm muted" style={{ minWidth: 120, flex: '1 1 0' }}>
                ✓ {justDone.modules?.code} · {justDone.title} — ticked off.
              </span>
              <button onClick={() => undoDone(justDone)} className="btn small ghost" style={{ flex: '0 0 auto' }}>Undo</button>
            </div>
          )}
          {!myWeekRows.length && justDone && (
            <p className="muted text-sm mt-3">Nothing else coming up — all clear. 🎉</p>
          )}
        </Section>

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

        {/* Quest Log retired s19 — My Week (above) is the calm replacement and inherited its
            overdue grace. Full deadline lists still live on each module's Assessments section. */}

        {!isViewer && (
          <Section title={`Classes · ${showNextWeek ? 'Next' : 'This'} Week`}
            empty={!classes.length && `No classes scheduled ${showNextWeek ? 'next' : 'this'} week.`}>
            <div className="panel">
              {classes.map((g) => <ClassRow key={g.id} g={g} />)}
            </div>
          </Section>
        )}

        {/* 📅 Classes-in-my-calendar moved to a header icon in s22 (it was a full card here) —
            subscribing is a once-off and the instructions were costing a screen of dashboard for
            ever after. See <Header> above. */}

        {/* To Do List — "Objectives" until s22. Shown to BOTH accounts now (Lize's ask); RLS makes
            it per-person, so each sees only her own. No `empty` prop on the Section: `empty`
            replaces the children outright, which would hide the add form on the very list that
            needs it most — an empty one. The panel says "all clear" itself instead. */}
        {(() => {
          const todos = goals.filter((g) => g.kind !== 'class')
          const active = todos.filter((g) => !g.done)
          const done = todos.filter((g) => g.done)
          return (
            <Section title="To Do List">
              <div className="panel">
                {active.length
                  ? active.map((g) => (
                      <ObjectiveRow key={g.id} g={g} onToggle={toggleGoal}
                        onDelete={g.source ? null : deleteGoal} />
                    ))
                  : <div className="row"><span className="muted text-sm">All clear — nothing outstanding.</span></div>}
                <AddTodoRow modules={modules} onAdd={addGoal} />
              </div>
              {done.length > 0 && (
                <div className="mt-3">
                  <button onClick={() => setShowDone((v) => !v)} className="btn small ghost"
                    aria-expanded={showDone}
                    style={{ borderColor: 'var(--line-strong)', color: 'var(--muted)' }}>
                    {showDone ? '▾' : '▸'} Done ({done.length})
                  </button>
                  {showDone && (
                    <div className="panel mt-2" style={{ opacity: 0.9 }}>
                      {done.map((g) => (
                        <ObjectiveRow key={g.id} g={g} onToggle={toggleGoal}
                          onDelete={g.source ? null : deleteGoal} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Section>
          )
        })()}

        <RemindersCard />
      </main>
    </div>
  )
}

// 🔔 Reminders — opt-in for push notifications (classes ~45 min before, tests/exams the morning of).
// Shown to the owner AND opted-in viewers (Lize gets the same class-wide reminders — her call).
// Subscribes THIS device and stores it under owner-RLS; the send-push Edge Function on pg_cron does
// the actual firing. Hidden until the VAPID public key is set AND the browser supports push (on
// iPhone that means the hub is installed to the Home Screen) — so it never shows a dead toggle.
function RemindersCard() {
  const [state, setState] = useState('loading')   // loading|unsupported|unconfigured|blocked|on|off
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { pushState().then(setState) }, [])

  // Nothing to offer: no push support (or not installed on iOS), or the key hasn't been set yet.
  if (state === 'loading' || state === 'unsupported' || state === 'unconfigured') return null

  async function turnOn() {
    setBusy(true); setErr('')
    const r = await enablePush()
    setBusy(false)
    if (!r.ok) {
      setErr(r.reason === 'denied' ? 'Permission was declined — allow notifications to turn these on.'
        : r.reason === 'unsupported' ? 'This device can’t do reminders.'
        : `Could not turn on reminders — ${r.reason}`)
      setState(await pushState())
      return
    }
    setState('on')
  }
  async function turnOff() {
    setBusy(true); setErr('')
    await disablePush()
    setBusy(false)
    setState('off')
  }

  return (
    <div className="panel bracket p-5">
      <div className="flex items-center gap-4">
        <div style={{
          width: 44, height: 44, borderRadius: 12, flex: '0 0 auto', fontSize: 22,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: `2px solid ${state === 'on' ? 'var(--cyan)' : 'var(--line-strong)'}`,
          color: state === 'on' ? 'var(--cyan)' : 'var(--muted)', background: 'rgba(2,8,22,.5)',
        }}>🔔</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="section-label">Reminders</div>
          <div className="text-sm muted mt-1">
            {state === 'on' ? 'On for this device — classes ~45 min before, tests & exams the morning of.'
              : state === 'blocked' ? 'Notifications are blocked in your browser/phone settings. Allow them there, then reload.'
              : 'Get a push on this device before classes, and the morning of a test or exam (with the access code).'}
          </div>
          {err && <div className="text-sm mt-1" style={{ color: 'var(--red)' }}>{err}</div>}
        </div>
        {state !== 'blocked' && (
          state === 'on'
            ? <button onClick={turnOff} disabled={busy} className="btn small ghost"
                style={{ borderColor: 'var(--line-strong)', color: 'var(--muted)' }}>
                {busy ? '…' : 'Turn off'}
              </button>
            : <button onClick={turnOn} disabled={busy} className="btn small"
                style={{ borderColor: 'var(--cyan)', color: 'var(--cyan)', whiteSpace: 'nowrap' }}>
                {busy ? '…' : '🔔 Turn on'}
              </button>
        )}
      </div>
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
      {/* Per-class add-to-calendar — covers the same-day gap the subscribed feed can miss
          (Google re-reads that feed on its own schedule, PLAN-calendar-feed.md §3). Only shown
          once the row has a date to build an event from. */}
      {g.target_date && (
        <a
          href={googleAddEventUrl(g)}
          target="_blank"
          rel="noopener noreferrer"
          title="Add this class to Google Calendar"
          style={{
            flex: '0 0 auto', width: 36, height: 36, borderRadius: 9,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1px solid var(--line-strong)', color: 'var(--muted)', fontSize: 16,
            textDecoration: 'none',
          }}
        >📅</a>
      )}
    </div>
  )
}

// One objective row. Ticking it moves it out of the active list (vanishes) into the "Done"
// tab — no strike-through, no pile-up. Untick from the Done tab to bring it back.
function ObjectiveRow({ g, onToggle, onDelete }) {
  // The eFundi agent prefixes its own text with "CODE: " (s17), so a chip there would say the
  // module twice. A hand-added item carries the module in the column instead — chip it.
  const code = g.modules?.code
  const showChip = !!code && !String(g.text || '').startsWith(code)
  return (
    <div className="row" style={{ gap: 12, flexWrap: 'wrap', rowGap: 6 }}>
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
      <span style={{ flex: '1 1 140px', minWidth: 0, color: g.done ? 'var(--muted)' : 'var(--text)' }}>
        {showChip && (
          <span className="chip" style={{ marginRight: 8, color: g.modules?.colour || 'var(--cyan)', borderColor: g.modules?.colour || 'var(--cyan)' }}>{code}</span>
        )}
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
      {g.target_date && <span className="muted text-sm" style={{ whiteSpace: 'nowrap' }}>{g.target_date}</span>}
      {onDelete && (
        <button onClick={() => onDelete(g)} aria-label={`Delete ${g.text}`} title="Delete"
          style={{
            flex: '0 0 auto', width: 30, height: 30, borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--line)', background: 'transparent', color: 'var(--muted)',
            fontSize: 13, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>✕</button>
      )}
    </div>
  )
}

// The "add something" row that sits at the bottom of the To Do List panel (s22). Deliberately a
// <form> so Enter submits — on a phone that's the difference between typing a to-do and hunting
// for a button. Module and date are both optional; a bare line of text is a valid to-do.
function AddTodoRow({ modules, onAdd }) {
  const [text, setText] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [moduleId, setModuleId] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    const ok = await onAdd({ text, targetDate, moduleId })
    setBusy(false)
    // Only clear on success — a failed insert must not eat what she typed.
    if (ok) { setText(''); setTargetDate(''); setModuleId('') }
  }

  return (
    <form onSubmit={submit} className="row" style={{ gap: 8, flexWrap: 'wrap', rowGap: 8 }}>
      <input className="input" value={text} onChange={(e) => setText(e.target.value)}
        aria-label="Add something to do" placeholder="Add something to do…"
        maxLength={300} style={{ flex: '1 1 180px', minWidth: 0 }} />
      <input className="input" type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)}
        aria-label="Date (optional)" style={{ flex: '0 0 auto', width: 150 }} />
      <select className="input" value={moduleId} onChange={(e) => setModuleId(e.target.value)}
        aria-label="Module (optional)" style={{ flex: '0 0 auto', width: 132 }}>
        <option value="">No module</option>
        {modules.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
      </select>
      <button className="btn small" disabled={!text.trim() || busy} style={{ flex: '0 0 auto' }}>
        {busy ? 'Adding…' : '＋ Add'}
      </button>
    </form>
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
  const [studyLog, setStudyLog] = useState([])
  const [profiles, setProfiles] = useState({})
  const [openSummary, setOpenSummary] = useState(null)
  const [showKit, setShowKit] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [statusError, setStatusError] = useState('')

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
      const [u, s, a, res, pp, profs, sl] = await Promise.all([
        supabase.from('study_units').select('*').eq('module_id', m.id).order('number'),
        supabase.from('summaries').select('id,title,kind,unit_id,assessment_id,html').eq('module_id', m.id).order('created_at'),
        supabase.from('assessments').select('*').eq('module_id', m.id).order('due_date'),
        supabase.from('resources').select('*').eq('module_id', m.id).order('created_at'),
        supabase.from('past_papers').select('*').eq('module_id', m.id)
          .order('year', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }),
        supabase.from('profiles').select('id, display_name, role'),
        // Owner-only RLS (0001) — a viewer's query just comes back empty, so the badge silently
        // doesn't show for them rather than erroring. This is Megan's own motivator, not shared data.
        supabase.from('study_log').select('unit_id, minutes').eq('module_id', m.id),
      ])
      setUnits(u.data || [])
      setSummaries(s.data || [])
      setAssessments(a.data || [])
      setResources(res.data || [])
      setPapers(pp.data || [])
      setStudyLog(sl.data || [])
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
  const minutesFor = (unitId) => studyLog
    .filter((l) => l.unit_id === unitId)
    .reduce((sum, l) => sum + (l.minutes || 0), 0)
  const formatMinutes = (mins) => mins < 60 ? `${mins}m` : `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h`
  // A "(START HERE)" brief covers the whole assessment set, so float it to the top of the
  // section instead of nesting it under whichever single assessment it happens to be linked to.
  const isOverviewBrief = (s) => /\(start here\)/i.test(s.title || '')
  const overviewBriefs = summaries.filter((s) => s.assessment_id && isOverviewBrief(s))
  const briefsFor = (assessmentId) => summaries.filter((s) => s.assessment_id === assessmentId && !isOverviewBrief(s))
  const accent = mod.colour || 'var(--cyan)'

  // The permanent home of the tick (s22). The dashboard's ✓ is the quick one and keeps a single
  // undo line; THIS list shows every assessment whatever its status, so a tick made days ago is
  // still findable and reversible here. Optimistic, with a revert on failure.
  async function toggleAssessment(a) {
    const status = a.status === 'upcoming' ? 'submitted' : 'upcoming'
    if (status === 'submitted') ping()  // not on the ↺ — see toggleGoal
    setStatusError('')
    setAssessments((as) => as.map((x) => (x.id === a.id ? { ...x, status } : x)))
    const { error: e } = await supabase.from('assessments').update({ status }).eq('id', a.id)
    if (e) {
      setAssessments((as) => as.map((x) => (x.id === a.id ? { ...x, status: a.status } : x)))
      setStatusError('Could not save that — ' + e.message)
    }
  }

  return (
    <div className="min-h-screen">
      <Header onBack={onBack}>
        <PingToggle />
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
            {mod.lecturer_name != null && (
              <span className="chip">
                {mod.lecturer_email ? <a href={`mailto:${mod.lecturer_email}`} style={{ color: 'inherit' }}>{mod.lecturer_name}</a> : mod.lecturer_name}
              </span>
            )}
          </div>
        </div>

        {(() => {
          // This Week card — the one question the page should answer first: "what do I do now?"
          // Hidden entirely when the module has no dated upcoming assessments at all.
          const wk = weekAhead(assessments)
          if (!wk.thisWeek.length && !wk.next) return null
          return (
            <div className="panel bracket p-4" style={{ '--accent': accent }}>
              <div className="section-label" style={{ color: accent }}>This week</div>
              {/* flex-wrap on these rows too: nowrap dates drop below the title on narrow phones
                  instead of squeezing it (same fix as the My Week rows). */}
              {wk.thisWeek.length ? wk.thisWeek.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 mt-2">
                  <span style={{ color: '#eaf4ff', minWidth: 120, flex: '1 1 0' }}>⏰ {a.title}</span>
                  <span className="text-sm" style={{ color: accent, whiteSpace: 'nowrap', flex: '0 0 auto', marginLeft: 'auto' }}>
                    {formatDue(a.due_date)} · {dueLabel(a.days)}
                  </span>
                </div>
              )) : (
                <div className="mt-2">
                  <div className="muted">✅ Nothing due this week.</div>
                  <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
                    <span className="muted" style={{ minWidth: 120, flex: '1 1 0' }}>Next up: <span style={{ color: '#eaf4ff' }}>{wk.next.title}</span></span>
                    <span className="muted text-sm" style={{ whiteSpace: 'nowrap', flex: '0 0 auto', marginLeft: 'auto' }}>
                      {formatDue(wk.next.due_date)} · {dueLabel(wk.next.days)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )
        })()}

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
                {minutesFor(u.id) > 0 && (
                  <div className="muted text-sm mt-1">⏱ {formatMinutes(minutesFor(u.id))} logged so far</div>
                )}
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
          {statusError && (
            <div className="panel p-3 mb-3 text-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{statusError}</div>
          )}
          <div className="space-y-3">
            {assessments.map((a) => {
              const briefs = briefsFor(a.id)
              const done = a.status !== 'upcoming'
              return (
                <div key={a.id} className="panel p-4" style={done ? { opacity: 0.55 } : undefined}>
                  <div className="flex items-center gap-3" style={{ flexWrap: 'wrap', rowGap: 6 }}>
                    <span style={{ color: '#eaf4ff', minWidth: 140, flex: '1 1 0',
                      textDecoration: done ? 'line-through' : 'none' }}>{a.title}</span>
                    <span style={{ marginLeft: 'auto', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span className="muted text-sm" style={{ whiteSpace: 'nowrap' }}>{a.due_date || 'date TBC'}</span>
                      {/* Tick / untick. Hidden for the viewer (Lize) — hub_write would refuse it
                          anyway, so showing the button would only ever produce an error. */}
                      {!isViewer && (
                        <button onClick={() => toggleAssessment(a)} className="icon-btn"
                          aria-label={done ? `Put ${a.title} back on the list` : `Mark ${a.title} as done`}
                          title={done ? 'Put it back on the list' : 'Mark as done'}
                          style={{ padding: 0, width: 38, justifyContent: 'center', fontSize: 15,
                            color: done ? 'var(--cyan)' : 'var(--muted)',
                            borderColor: done ? 'var(--cyan)' : 'var(--line)' }}>{done ? '↺' : '✓'}</button>
                      )}
                    </span>
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

// ---- Summary pen · highlight + typed notes (PLAN-summary-pen.md) ----
// Prose-ish kinds only — flashcards/quiz/mindmap/diagram are interactive apps, not text to mark up.
const PEN_ENABLED_KINDS = ['notes', 'timeline', 'other']

// Traffic-light three carry a fixed meaning the tutor reads (read-notes.mjs); the free three are
// hers to use however she likes. Order matters here — shown in this order everywhere (legend,
// toolbar, popovers).
const PEN_COLORS = [
  // No yellow: her colour docs use yellow highlights of their own, so a pen-yellow is
  // indistinguishable from the doc's (her ruling 2026-08-29). Blue is the meaning-carrier
  // and the one-tap default instead.
  { key: 'blue', dot: '🔵', bg: 'rgba(56, 130, 255, .38)', label: 'Important — use this' },
  { key: 'pink', dot: '🩷', bg: 'rgba(255, 105, 180, .42)', label: "Don't understand — teach this first" },
  { key: 'green', dot: '🟢', bg: 'rgba(52, 245, 197, .38)', label: "I've got this" },
  { key: 'purple', dot: '🟣', bg: 'rgba(170, 100, 255, .4)', label: 'Free colour — no meaning' },
  { key: 'orange', dot: '🟠', bg: 'rgba(255, 150, 60, .42)', label: 'Free colour — no meaning' },
]

// Mark colours as translucent backgrounds (not solid) so her colourful docs stay legible
// underneath, and print-color-adjust so Save-as-PDF keeps them instead of the browser stripping
// backgrounds by default.
function injectPenStyle(doc) {
  if (doc.getElementById('pen-style')) return
  const style = doc.createElement('style')
  style.id = 'pen-style'
  style.textContent = `
    mark[data-pen-id] { color: inherit; border-radius: 2px; padding: 0 1px; cursor: pointer;
      -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    ${PEN_COLORS.map((c) => `mark[data-pen-color="${c.key}"] { background: ${c.bg}; }`).join('\n    ')}
  `
  ;(doc.head || doc.documentElement).appendChild(style)
}

function penBtnStyle(kind) {
  const base = { fontSize: 12, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontFamily: 'sans-serif' }
  if (kind === 'primary') return { ...base, border: '1px solid #38e1ff', background: 'rgba(56,225,255,.18)', color: '#dce9ff' }
  if (kind === 'danger') return { ...base, border: '1px solid #24344a', background: 'rgba(255,92,122,.12)', color: '#ff5c7a' }
  return { ...base, border: '1px solid #24344a', background: 'transparent', color: '#dce9ff' }
}

// Prevent the browser's default mousedown/pointerdown behaviour (focus shift, selection
// collapse) so tapping a toolbar button doesn't destroy the very selection/toolbar it's acting
// on before the click fires — the classic mousedown-before-click race.
function noCollapse(el) {
  el.addEventListener('mousedown', (e) => e.preventDefault())
  el.addEventListener('pointerdown', (e) => e.preventDefault())
}

function SummaryViewer({ summary, accent, onClose }) {
  const iframeRef = useRef(null)
  const docRef = useRef(null)
  const cleanupRef = useRef(null)
  const penEnabled = PEN_ENABLED_KINDS.includes(summary.kind)

  const [notes, setNotes] = useState([])
  const notesRef = useRef(notes)
  useEffect(() => { notesRef.current = notes }, [notes])
  const [panelOpen, setPanelOpen] = useState(false)
  const [toast, setToast] = useState('')
  const toastTimer = useRef(null)

  function showToast(msg) {
    setToast(msg)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 4000)
  }

  function savePdf() {
    const w = iframeRef.current?.contentWindow
    if (w) { w.focus(); w.print() }
  }

  function jumpTo(note) {
    if (docRef.current) pen.scrollToMark(docRef.current.body, note.id)
  }

  // Orphans never carry a DOM mark, so deleting one is a plain DB delete — no unwrap needed.
  async function deleteOrphan(note) {
    setNotes((ns) => ns.filter((n) => n.id !== note.id))
    const { error } = await supabase.from('summary_notes').delete().eq('id', note.id)
    if (error) {
      setNotes((ns) => [...ns, note].sort((a, b) => a.position - b.position))
      showToast('Could not delete — ' + error.message)
    }
  }

  function onIframeLoad() {
    const doc = iframeRef.current?.contentDocument
    if (!doc || !penEnabled) return
    docRef.current = doc
    injectPenStyle(doc)

    let disposed = false
    let toolbarEl = null
    let popoverEl = null

    function removeFloaters() {
      toolbarEl?.remove(); toolbarEl = null
      popoverEl?.remove(); popoverEl = null
    }

    function placeNear(el, rect) {
      const win = doc.defaultView
      Object.assign(el.style, {
        position: 'absolute',
        top: (rect.bottom + win.scrollY + 8) + 'px',
        left: Math.max(4, Math.min(rect.left + win.scrollX, win.innerWidth - 220)) + 'px',
        zIndex: 999999,
      })
      doc.body.appendChild(el)
    }

    function floaterBase(row) {
      const el = doc.createElement('div')
      Object.assign(el.style, {
        display: 'flex', flexDirection: row ? 'row' : 'column', gap: 8, alignItems: row ? 'center' : 'stretch',
        background: '#0b1524', border: '1px solid #24344a', borderRadius: 10,
        padding: row ? '6px 8px' : '8px 10px', boxShadow: '0 4px 16px rgba(0,0,0,.45)',
        fontFamily: 'sans-serif', maxWidth: 220,
      })
      return el
    }

    // Shared by the new-highlight toolbar, the note editor, and the existing-mark popover.
    // `activeKey` pre-outlines the current colour; picking one re-outlines instantly.
    function buildDotRow(onPick, activeKey) {
      const row = doc.createElement('div')
      Object.assign(row.style, { display: 'flex', gap: 6, alignItems: 'center' })
      const buttons = []
      PEN_COLORS.forEach(({ key, dot, label }) => {
        const b = doc.createElement('button')
        b.type = 'button'
        b.textContent = dot
        b.title = label
        Object.assign(b.style, {
          fontSize: 18, lineHeight: 1, border: 0, background: 'transparent', cursor: 'pointer',
          padding: 3, borderRadius: 6, outline: key === activeKey ? '2px solid #fff' : 'none',
        })
        noCollapse(b)
        b.addEventListener('click', (e) => {
          e.preventDefault()
          buttons.forEach((btn, i) => { btn.style.outline = PEN_COLORS[i].key === key ? '2px solid #fff' : 'none' })
          onPick(key)
        })
        buttons.push(b)
        row.appendChild(b)
      })
      return row
    }

    function buildNoteTextarea(initial) {
      const ta = doc.createElement('textarea')
      ta.value = initial || ''
      ta.placeholder = 'How will you use this? (optional)'
      Object.assign(ta.style, {
        width: 190, minHeight: 60, background: 'rgba(2,8,22,.6)', color: '#dce9ff',
        border: '1px solid #24344a', borderRadius: 8, padding: 6, font: '13px sans-serif', resize: 'vertical',
      })
      // No noCollapse here: preventing mousedown/pointerdown on a textarea blocks click-to-focus,
      // so it could never take a caret (the S Pen bug, 2026-08-30). The selection it was guarding
      // is already captured by the time this box exists, so collapsing it costs nothing.
      return ta
    }

    // ---- new highlight: mini toolbar (dots + 📝) below the selection ----
    function showToolbar(sel) {
      const captured = pen.captureSelection(doc.body, sel)
      if (!captured) return
      const range = sel.getRangeAt(0).cloneRange()
      const rect = range.getBoundingClientRect()
      if (!rect.width && !rect.height) return
      removeFloaters()
      const bar = floaterBase(true)
      bar.appendChild(buildDotRow((color) => saveHighlight(captured, range, color, null)))
      const noteBtn = doc.createElement('button')
      noteBtn.type = 'button'
      noteBtn.textContent = '📝'
      noteBtn.title = 'Add a note'
      Object.assign(noteBtn.style, { fontSize: 16, border: 0, background: 'transparent', cursor: 'pointer', padding: '3px 5px' })
      noCollapse(noteBtn)
      noteBtn.addEventListener('click', (e) => { e.preventDefault(); showNoteEditor(captured, range) })
      bar.appendChild(noteBtn)
      placeNear(bar, rect)
      toolbarEl = bar
    }

    function showNoteEditor(captured, range) {
      const rect = range.getBoundingClientRect()
      removeFloaters()
      const box = floaterBase(false)
      let chosen = 'blue'
      box.appendChild(buildDotRow((c) => { chosen = c }, chosen))
      const ta = buildNoteTextarea('')
      box.appendChild(ta)
      const row = doc.createElement('div')
      Object.assign(row.style, { display: 'flex', gap: 8, justifyContent: 'flex-end' })
      const cancel = doc.createElement('button')
      cancel.type = 'button'; cancel.textContent = 'Cancel'
      Object.assign(cancel.style, penBtnStyle('ghost'))
      noCollapse(cancel)
      cancel.addEventListener('click', (e) => { e.preventDefault(); removeFloaters() })
      const save = doc.createElement('button')
      save.type = 'button'; save.textContent = 'Save'
      Object.assign(save.style, penBtnStyle('primary'))
      noCollapse(save)
      save.addEventListener('click', (e) => { e.preventDefault(); saveHighlight(captured, range, chosen, ta.value.trim() || null) })
      row.appendChild(cancel); row.appendChild(save)
      box.appendChild(row)
      placeNear(box, rect)
      popoverEl = box
      ta.focus()
    }

    async function saveHighlight(captured, range, color, note) {
      removeFloaters()
      doc.getSelection()?.removeAllRanges()
      const id = crypto.randomUUID()
      const marks = pen.wrapRange(range, id, color)
      if (!marks.length) return
      const optimistic = {
        id, summary_id: summary.id, quote: captured.quote, prefix: captured.prefix, suffix: captured.suffix,
        color, note, position: captured.position, orphaned: false,
      }
      setNotes((ns) => [...ns, optimistic].sort((a, b) => a.position - b.position))
      const { data, error } = await supabase.from('summary_notes')
        .insert({ summary_id: summary.id, quote: captured.quote, prefix: captured.prefix, suffix: captured.suffix, color, note, position: captured.position })
        .select().single()
      if (disposed) return
      if (error || !data) {
        pen.unwrap(doc.body, id)
        setNotes((ns) => ns.filter((n) => n.id !== id))
        showToast('Could not save highlight — ' + (error?.message || 'not authorised'))
        return
      }
      marks.forEach((m) => { m.dataset.penId = data.id })
      setNotes((ns) => ns.map((n) => (n.id === id ? { ...data } : n)).sort((a, b) => a.position - b.position))
    }

    // ---- existing mark: popover (note text, colour, delete) ----
    function showMarkPopover(note, markEl) {
      const rect = markEl.getBoundingClientRect()
      removeFloaters()
      const box = floaterBase(false)
      box.appendChild(buildDotRow((color) => {
        const cur = notesRef.current.find((n) => n.id === note.id) || note
        updateNote(cur, { color })
      }, note.color))
      const ta = buildNoteTextarea(note.note)
      box.appendChild(ta)
      const row = doc.createElement('div')
      Object.assign(row.style, { display: 'flex', gap: 8, justifyContent: 'space-between' })
      const del = doc.createElement('button')
      del.type = 'button'; del.textContent = 'Delete'
      Object.assign(del.style, penBtnStyle('danger'))
      noCollapse(del)
      del.addEventListener('click', (e) => { e.preventDefault(); deleteNote(notesRef.current.find((n) => n.id === note.id) || note) })
      const save = doc.createElement('button')
      save.type = 'button'; save.textContent = 'Save'
      Object.assign(save.style, penBtnStyle('primary'))
      noCollapse(save)
      save.addEventListener('click', (e) => {
        e.preventDefault()
        const cur = notesRef.current.find((n) => n.id === note.id) || note
        updateNote(cur, { note: ta.value.trim() || null })
        removeFloaters()
      })
      row.appendChild(del); row.appendChild(save)
      box.appendChild(row)
      placeNear(box, rect)
      popoverEl = box
    }

    async function updateNote(note, fields) {
      const prev = { color: note.color, note: note.note }
      setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, ...fields } : n)))
      if (fields.color) pen.recolor(doc.body, note.id, fields.color)
      const { error } = await supabase.from('summary_notes').update(fields).eq('id', note.id)
      if (disposed) return
      if (error) {
        setNotes((ns) => ns.map((n) => (n.id === note.id ? { ...n, ...prev } : n)))
        if (fields.color) pen.recolor(doc.body, note.id, prev.color)
        showToast('Could not save — ' + error.message)
      }
    }

    async function deleteNote(note) {
      removeFloaters()
      pen.unwrap(doc.body, note.id)
      setNotes((ns) => ns.filter((n) => n.id !== note.id))
      const { error } = await supabase.from('summary_notes').delete().eq('id', note.id)
      if (disposed) return
      if (error) {
        // The mark is gone (unwrap merged its text nodes), so restoring means re-finding the
        // quote fresh rather than remembering old DOM coordinates.
        const range = pen.findQuote(doc.body, note)
        if (range) pen.wrapRange(range, note.id, note.color)
        setNotes((ns) => [...ns, note].sort((a, b) => a.position - b.position))
        showToast('Could not delete — ' + error.message)
      }
    }

    // Trailing debounce, NOT per-event: selectionchange fires continuously while the S Pen drags,
    // and showToolbar() re-scans the whole document (buildIndex) plus tears down and rebuilds the
    // toolbar each call — measured 120 full rescans in one simulated drag on a 55K-char doc, which
    // saturated her tablet until the page glitched/went white (2026-08-30). Now a changing
    // selection only resets the timer; the one scan happens 250 ms after the pen settles. The
    // collapsed check stays synchronous so the toolbar still vanishes instantly on deselect.
    // (setTimeout, not requestAnimationFrame: rAF doesn't run for a non-rendered document.)
    let pending = null
    function onSelectionMaybe() {
      const win = doc.defaultView
      if (pending) { win.clearTimeout(pending); pending = null }
      const sel = doc.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) { toolbarEl?.remove(); toolbarEl = null; return }
      pending = win.setTimeout(() => {
        pending = null
        const settled = doc.getSelection()
        if (!settled || settled.isCollapsed || !settled.rangeCount) { toolbarEl?.remove(); toolbarEl = null; return }
        showToolbar(settled)
      }, 250)
    }
    doc.addEventListener('selectionchange', onSelectionMaybe)
    doc.addEventListener('mouseup', onSelectionMaybe)
    doc.addEventListener('pointerup', onSelectionMaybe)

    function onBodyClick(e) {
      if ((toolbarEl && toolbarEl.contains(e.target)) || (popoverEl && popoverEl.contains(e.target))) return
      const mark = e.target.closest && e.target.closest('mark[data-pen-id]')
      if (!mark) { removeFloaters(); return }
      e.preventDefault()
      const note = notesRef.current.find((n) => n.id === mark.dataset.penId)
      if (note) showMarkPopover(note, mark)
    }
    doc.body.addEventListener('click', onBodyClick)

    // ---- load + render existing highlights; reconcile orphan status against reality ----
    supabase.from('summary_notes').select('*').eq('summary_id', summary.id).order('position')
      .then(({ data, error }) => {
        if (disposed || error || !data) return
        const toOrphan = [], toUnorphan = []
        data.forEach((n) => {
          const range = pen.findQuote(doc.body, n)
          if (range) {
            pen.wrapRange(range, n.id, n.color)
            if (n.orphaned) toUnorphan.push(n.id)
          } else if (!n.orphaned) {
            toOrphan.push(n.id)
          }
        })
        setNotes(data.map((n) => ({
          ...n,
          orphaned: toOrphan.includes(n.id) ? true : toUnorphan.includes(n.id) ? false : n.orphaned,
        })))
        if (toOrphan.length) supabase.from('summary_notes').update({ orphaned: true }).in('id', toOrphan).then(() => {})
        if (toUnorphan.length) supabase.from('summary_notes').update({ orphaned: false }).in('id', toUnorphan).then(() => {})
      })

    cleanupRef.current = () => {
      disposed = true
      if (pending) { doc.defaultView?.clearTimeout(pending); pending = null }
      doc.removeEventListener('selectionchange', onSelectionMaybe)
      doc.removeEventListener('mouseup', onSelectionMaybe)
      doc.removeEventListener('pointerup', onSelectionMaybe)
      doc.body.removeEventListener('click', onBodyClick)
      removeFloaters()
    }
  }

  useEffect(() => () => cleanupRef.current?.(), [])

  const visible = notes.filter((n) => !n.orphaned)
  const orphans = notes.filter((n) => n.orphaned)

  return (
    <div className="overlay p-3 sm:p-6" style={{ flexDirection: 'column' }}>
      <div className="panel w-full max-w-4xl flex-1 flex flex-col overflow-hidden" style={{ padding: 0 }}>
        <div className="flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid var(--line)' }}>
          <span className="section-label truncate">{summary.title}</span>
          <div className="flex items-center gap-2">
            {penEnabled && (
              <button onClick={() => setPanelOpen((v) => !v)} className="btn small ghost">
                📝 Notes{notes.length ? ` (${notes.length})` : ''}
              </button>
            )}
            <button onClick={savePdf} className="btn small" style={{ background: accent, borderColor: accent, color: '#04121f' }} title="Opens your browser's Save-as-PDF">⭳ Save as PDF</button>
            <button onClick={onClose} className="icon-btn">✕</button>
          </div>
        </div>
        {toast && <div className="px-4 py-2 text-sm" style={{ borderBottom: '1px solid var(--line)', color: 'var(--red)' }}>{toast}</div>}
        {penEnabled && panelOpen && (
          <div className="p-3 text-sm" style={{ borderBottom: '1px solid var(--line)', maxHeight: '38%', overflowY: 'auto', background: 'rgba(2,8,22,.4)' }}>
            <div className="flex flex-wrap gap-2 mb-3">
              {PEN_COLORS.map((c) => <span key={c.key} className="chip" title={c.label}>{c.dot} {c.label}</span>)}
            </div>
            {!notes.length && <p className="muted text-xs">Select text in the doc to highlight it.</p>}
            <ul className="space-y-1.5">
              {visible.map((n) => (
                <li key={n.id} onClick={() => jumpTo(n)} className="cursor-pointer" style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--line)' }}>
                  <div className="flex items-center gap-2">
                    <span>{PEN_COLORS.find((c) => c.key === n.color)?.dot}</span>
                    <span className="text-xs truncate" style={{ color: 'var(--text)' }}>&ldquo;{n.quote}&rdquo;</span>
                  </div>
                  {n.note && <div className="muted text-xs mt-1">{n.note}</div>}
                </li>
              ))}
            </ul>
            {!!orphans.length && (
              <>
                <div className="section-label mt-3 mb-1" style={{ color: 'var(--red)' }}>⚠ Lost their place</div>
                <ul className="space-y-1.5">
                  {orphans.map((n) => (
                    <li key={n.id} style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--line)' }}>
                      <div className="text-xs truncate muted">&ldquo;{n.quote}&rdquo;</div>
                      {n.note && <div className="muted text-xs mt-1">{n.note}</div>}
                      <button onClick={() => deleteOrphan(n)} className="btn small ghost mt-1" style={{ fontSize: 11 }}>Delete</button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <iframe ref={iframeRef} title={summary.title} srcDoc={summary.html} onLoad={onIframeLoad}
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

// =================================================================================================
// Tests & Exams — the always-reachable home for SALA "Exam opportunity" ACCESS CODES.
// A floating bubble on every view opens an overlay listing each exam's code (huge, tap-to-copy),
// its register window (the make-or-break minutes), the write time, the eFundi link + a scannable
// QR, soonest-first. Rows come from the sync agent (auto) and an owner add/fix form (manual).
// =================================================================================================

const EXAM_ACCENT = '#ffcf5c'   // warm gold — this bubble should stand out as "don't lose this"
const hhmm = (t) => (t ? String(t).slice(0, 5) : null)   // "08:30:00" -> "08:30"

// Module-scope so the input's component type is stable across ExamForm re-renders (a nested
// definition would remount the input every keystroke and drop focus).
function ExamField({ label, children }) {
  return (
    <label className="field" style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, color: 'var(--muted)', marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  )
}

function ExamAccessFab({ userId, isViewer }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState([])
  const [modules, setModules] = useState([])
  const [error, setError] = useState('')

  async function load() {
    const [ex, mods] = await Promise.all([
      supabase.from('exam_access').select('*, modules(code,colour)')
        .order('event_date', { ascending: true, nullsFirst: false }).order('created_at'),
      supabase.from('modules').select('id, code').order('code'),
    ])
    if (ex.error) { setError(ex.error.message); return }
    setError('')
    setRows(ex.data || [])
    setModules(mods.data || [])
  }
  useEffect(() => { load() }, [])

  // Refetch whenever the overlay opens. Critical for the deep-link case: a notification tap on an
  // already-open (possibly day-old) tab is a same-document #exams navigation — nothing reloads — so
  // without this the overlay would show yesterday's rows, missing the very exam the push was about.
  useEffect(() => { if (open) load() }, [open])

  // Deep-link: an exam-morning notification opens the hub at #exams — pop the overlay straight open
  // (on cold start and, via hashchange, when the notification focuses an already-open tab), then
  // clear the hash so a later reload doesn't re-open it.
  useEffect(() => {
    const openIfHash = () => {
      if (window.location.hash === '#exams') {
        setOpen(true)
        history.replaceState(null, '', window.location.pathname + window.location.search)
      }
    }
    openIfHash()
    window.addEventListener('hashchange', openIfHash)
    return () => window.removeEventListener('hashchange', openIfHash)
  }, [])

  // Badge = exams whose write date is within the next 7 days — nag her TOWARD the code, not away.
  const today = new Date().toISOString().slice(0, 10)
  const soonBy = addDays(today, 7)
  const soon = rows.filter((r) => r.event_date && r.event_date >= today && r.event_date <= soonBy).length

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Tests & Exams access codes"
        title="Tests & Exams — access codes"
        style={{
          position: 'fixed', right: 18, bottom: 18, zIndex: 40,
          width: 58, height: 58, borderRadius: 16, cursor: 'pointer',
          border: `2px solid ${EXAM_ACCENT}`, background: 'rgba(2,8,22,.82)', color: EXAM_ACCENT,
          fontSize: 24, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: `0 0 18px rgba(255,207,92,.35), 0 6px 18px rgba(0,0,0,.45)`,
          backdropFilter: 'blur(4px)',
        }}
      >
        🎫
        {soon > 0 && (
          <span style={{
            position: 'absolute', top: -6, right: -6, minWidth: 22, height: 22, padding: '0 5px',
            borderRadius: 999, background: 'var(--red)', color: '#fff', fontSize: 12, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '2px solid rgba(2,8,22,.9)',
          }}>{soon}</span>
        )}
      </button>
      {open && (
        <ExamAccessOverlay
          rows={rows} modules={modules} userId={userId} error={error} isViewer={isViewer}
          onClose={() => setOpen(false)} onChanged={load}
        />
      )}
    </>
  )
}

function ExamAccessOverlay({ rows, modules, userId, error, isViewer, onClose, onChanged }) {
  const [showPast, setShowPast] = useState(false)
  const [editing, setEditing] = useState(null)   // null = closed, {} = new, {…} = edit
  const today = new Date().toISOString().slice(0, 10)
  // Undated rows count as upcoming (never auto-hidden — she'd want to see a code even with no date).
  const upcoming = rows.filter((r) => !r.event_date || r.event_date >= today)
  const past = rows.filter((r) => r.event_date && r.event_date < today)

  return (
    <div className="overlay p-3 sm:p-6" style={{ flexDirection: 'column' }} onClick={onClose}>
      <div className="panel w-full max-w-2xl flex flex-col overflow-hidden"
        style={{ padding: 0, maxHeight: '92vh', borderColor: EXAM_ACCENT }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <span className="section-label" style={{ color: EXAM_ACCENT }}>🎫 Tests &amp; Exams · Access Codes</span>
          <div className="flex items-center gap-2">
            {!editing && !isViewer && (
              <button onClick={() => setEditing({})} className="btn small"
                style={{ background: EXAM_ACCENT, borderColor: EXAM_ACCENT, color: '#04121f' }}>＋ Add / fix</button>
            )}
            <button onClick={onClose} className="icon-btn">✕</button>
          </div>
        </div>

        <div className="overflow-y-auto px-4 py-4 space-y-4" style={{ minHeight: 80 }}>
          {error && (
            <div className="panel p-3 text-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
              {error} — if this mentions a missing table, migration 0012 hasn’t been run yet.
            </div>
          )}

          {editing && (
            <ExamForm
              row={editing} modules={modules} userId={userId}
              onDone={() => { setEditing(null); onChanged() }}
              onCancel={() => setEditing(null)}
            />
          )}

          {!editing && !upcoming.length && !past.length && (
            <p className="muted text-sm">No exam codes yet. They appear automatically when eFundi posts an
              “Exam opportunity”{isViewer ? '.' : ', or add one with ＋ Add / fix.'}</p>
          )}

          {upcoming.map((r) => (
            <ExamRow key={r.id} r={r} onEdit={() => setEditing(r)} canEdit={!isViewer} />
          ))}

          {past.length > 0 && (
            <div>
              <button onClick={() => setShowPast((v) => !v)} className="btn small ghost"
                aria-expanded={showPast} style={{ borderColor: 'var(--line-strong)', color: 'var(--muted)' }}>
                {showPast ? '▾' : '▸'} Past ({past.length})
              </button>
              {showPast && (
                <div className="mt-3 space-y-4" style={{ opacity: 0.85 }}>
                  {past.map((r) => <ExamRow key={r.id} r={r} onEdit={() => setEditing(r)} past canEdit={!isViewer} />)}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ExamRow({ r, onEdit, past, canEdit }) {
  const [copied, setCopied] = useState(false)
  const c = r.modules?.colour || EXAM_ACCENT
  const qr = r.efundi_url ? qrSvg(r.efundi_url, { size: 132 }) : null

  function copyCode() {
    if (!r.access_code) return
    navigator.clipboard?.writeText(r.access_code).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="panel p-4" style={{ borderLeft: `3px solid ${c}` }}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2" style={{ minWidth: 0 }}>
          {r.modules?.code && <span className="mono text-xs" style={{ color: c }}>{r.modules.code}</span>}
          <span style={{ color: '#eaf4ff', fontWeight: 600 }} className="truncate">{r.title}</span>
          <span className="chip">{r.kind}</span>
        </span>
        <div className="flex items-center gap-2" style={{ flex: '0 0 auto' }}>
          {r.event_date && <span className="muted text-sm">{r.event_date}</span>}
          {canEdit && <button onClick={onEdit} className="icon-btn" style={{ height: 30, padding: '0 9px', fontSize: 12 }}>✎</button>}
        </div>
      </div>

      <div className="mt-3 flex flex-col sm:flex-row gap-4">
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* THE HERO — the code she types into the Invigilator agent. Big, mono, tap-to-copy. */}
          {r.access_code ? (
            <button onClick={copyCode} title="Tap to copy"
              style={{
                display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                border: `1.5px solid ${EXAM_ACCENT}`, borderRadius: 12, padding: '10px 14px',
                background: 'rgba(2,8,22,.6)',
              }}>
              <div className="section-label" style={{ color: 'var(--muted)', marginBottom: 4 }}>
                Access code {copied ? '· copied ✓' : '· tap to copy'}
              </div>
              <div className="mono" style={{ fontSize: 30, fontWeight: 800, letterSpacing: 3, color: EXAM_ACCENT }}>
                {r.access_code}
              </div>
            </button>
          ) : (
            <p className="muted text-sm">No access code recorded{canEdit ? ' — tap ✎ to add it.' : ' yet.'}</p>
          )}

          <div className="mt-3 text-sm space-y-1" style={{ color: 'var(--text)' }}>
            {(hhmm(r.code_open) || hhmm(r.code_close)) && (
              <div>⏱ <b>Register window</b> {hhmm(r.code_open) || '—'}–{hhmm(r.code_close) || '—'}
                <span className="muted"> (enter the code here)</span></div>
            )}
            {hhmm(r.start_time) && <div>📝 <b>Write</b> {hhmm(r.start_time)} <span className="muted">(assessment opens)</span></div>}
            {r.detail && <div className="muted">{r.detail}</div>}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {r.efundi_url && (
              <a href={r.efundi_url} target="_blank" rel="noopener noreferrer" className="text-sm"
                style={{ color: 'var(--cyan)', fontWeight: 600 }}>Open on eFundi →</a>
            )}
            {r.qr_attachment_url && (
              <a href={r.qr_attachment_url} target="_blank" rel="noopener noreferrer" className="text-sm"
                style={{ color: 'var(--cyan)', fontWeight: 600 }}>⭳ Official QR</a>
            )}
          </div>
        </div>

        {/* Scannable QR of the eFundi link — scan → open the assessment on her phone. */}
        {qr && (
          <div style={{ flex: '0 0 auto', textAlign: 'center' }}>
            <div style={{ borderRadius: 10, overflow: 'hidden', width: 132, height: 132 }}
              dangerouslySetInnerHTML={{ __html: qr }} />
            <div className="muted text-xs mt-1">scan → eFundi</div>
          </div>
        )}
      </div>
    </div>
  )
}

// Owner-only add/fix form. `row` = {} for a new entry, or an existing row to edit. Empty strings
// save as null. Deletes are here too (cleanup). This is the manual safety net for the one time the
// sync agent misses a code or eFundi changes wording.
function ExamForm({ row, modules, userId, onDone, onCancel }) {
  const [f, setF] = useState({
    title: row.title || '', module_id: row.module_id || '', kind: row.kind || 'exam',
    access_code: row.access_code || '', event_date: row.event_date || '',
    code_open: hhmm(row.code_open) || '', code_close: hhmm(row.code_close) || '',
    start_time: hhmm(row.start_time) || '', efundi_url: row.efundi_url || '', detail: row.detail || '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const isEdit = !!row.id

  async function save() {
    if (!f.title.trim()) { setErr('Give it a title.'); return }
    setBusy(true); setErr('')
    const payload = {
      owner: userId,
      module_id: f.module_id || null,
      kind: f.kind === 'test' ? 'test' : 'exam',
      title: f.title.trim().slice(0, 200),
      access_code: f.access_code.trim() || null,
      event_date: f.event_date || null,
      code_open: f.code_open || null,
      code_close: f.code_close || null,
      start_time: f.start_time || null,
      efundi_url: f.efundi_url.trim() || null,
      detail: f.detail.trim() || null,
    }
    const q = isEdit
      ? supabase.from('exam_access').update(payload).eq('id', row.id)
      : supabase.from('exam_access').insert(payload)
    const { error } = await q
    setBusy(false)
    if (error) { setErr(error.message); return }
    onDone()
  }

  async function remove() {
    if (!isEdit) { onCancel(); return }
    if (!window.confirm('Delete this exam entry?')) return
    setBusy(true)
    const { error } = await supabase.from('exam_access').delete().eq('id', row.id)
    setBusy(false)
    if (error) { setErr(error.message); return }
    onDone()
  }

  return (
    <div className="system p-4" style={{ borderColor: EXAM_ACCENT }}>
      <div className="section-label mb-3" style={{ color: EXAM_ACCENT }}>{isEdit ? 'Edit exam' : 'New exam'}</div>
      {err && <p className="text-sm mb-3" style={{ color: 'var(--red)' }}>{err}</p>}
      <div className="grid sm:grid-cols-2 gap-3">
        <ExamField label="Title"><input className="input" value={f.title} onChange={set('title')} placeholder="MATH111 Exam opportunity 2" /></ExamField>
        <ExamField label="Module">
          <select className="input" value={f.module_id} onChange={set('module_id')}>
            <option value="">— none —</option>
            {modules.map((m) => <option key={m.id} value={m.id}>{m.code}</option>)}
          </select>
        </ExamField>
        <ExamField label="Access code"><input className="input mono" value={f.access_code} onChange={set('access_code')} placeholder="06f1d051" /></ExamField>
        <ExamField label="Kind">
          <select className="input" value={f.kind} onChange={set('kind')}>
            <option value="exam">exam</option>
            <option value="test">test</option>
          </select>
        </ExamField>
        <ExamField label="Write date"><input className="input" type="date" value={f.event_date} onChange={set('event_date')} /></ExamField>
        <ExamField label="Write time"><input className="input" type="time" value={f.start_time} onChange={set('start_time')} /></ExamField>
        <ExamField label="Register opens"><input className="input" type="time" value={f.code_open} onChange={set('code_open')} /></ExamField>
        <ExamField label="Register closes"><input className="input" type="time" value={f.code_close} onChange={set('code_close')} /></ExamField>
      </div>
      <div className="mt-3"><ExamField label="eFundi link"><input className="input" value={f.efundi_url} onChange={set('efundi_url')} placeholder="https://efundi.nwu.ac.za/x/…" /></ExamField></div>
      <div className="mt-3"><ExamField label="Note (optional)"><input className="input" value={f.detail} onChange={set('detail')} /></ExamField></div>
      <div className="flex items-center justify-between mt-4 gap-2">
        <button onClick={remove} disabled={busy} className="btn small ghost" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          {isEdit ? 'Delete' : 'Cancel'}
        </button>
        <div className="flex gap-2">
          {isEdit && <button onClick={onCancel} disabled={busy} className="btn small ghost">Cancel</button>}
          <button onClick={save} disabled={busy} className="btn small"
            style={{ background: EXAM_ACCENT, borderColor: EXAM_ACCENT, color: '#04121f' }}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
