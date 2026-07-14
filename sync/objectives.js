// objectives.js — the "read announcements, write objectives" agent.
//
// After each sync, this reads announcements the agent hasn't processed yet and turns the
// actionable ones into study goals/objectives (into the `goals` table, which the hub shows).
// Raw announcements are never displayed — this is what the student actually sees instead.
//
// Cost control (this is why it's cheap and safe):
//   • Cheapest model (Haiku), tiny max_tokens, structured output.
//   • Only NEW announcements (processed_at IS NULL) — each is read exactly once.
//   • No ANTHROPIC_API_KEY? -> skip silently (the sync still succeeds).
//   • Any per-announcement error -> leave it unprocessed and move on (retried next run).

import Anthropic from '@anthropic-ai/sdk';
import { parseExamAccess } from './exam-parse.js';

const MODEL = 'claude-haiku-4-5';   // user-chosen for cost; supports structured outputs

const SYSTEM = `You read a university course announcement and decide whether it contains something the
student must ACT on. Be strict — most announcements are not objectives, and a graveyard of trivial
goals is worse than none.

Create a goal ONLY for:
  • a task the student must do (prepare, submit, register, complete, attend), or
  • a scheduled class / test / session that has a specific date (include the time if given).

Return an EMPTY list for everything else: general reminders, FYI notices, greetings, encouragement,
clarifications about content, or anything that has already passed. These are NOT objectives — the
announcement is still kept on file for the student's AI tutor to reference, so never force a goal.

Set each goal's "kind":
  • "class" — ONLY a live class/lecture/tutorial/online session the student attends at a set time.
  • "task" — everything else, including tests, assignments, submissions and registrations.
Classes are shown in their own section and change often (new time / new link most weeks), so getting
this right matters.

Each goal: short, specific, max ~14 words. Tasks phrased as instructions ("Submit Assignment 1",
"Register for Test 2").

Classes/sessions must be UNAMBIGUOUS — the student should never have to open the announcement to
know what/when. Always start with the module code and include the time.
  • One-off class (a specific date): include the weekday + date, e.g. "MATV121 online class — Wed 15
    Jul, 19:00". Set recurring to false.
  • Recurring class (the announcement says it runs EVERY week / weekly / uses a standing link): name
    the weekday, not a single date, e.g. "MATV121 online class — Wednesdays, 19:00". Set recurring to
    true, and STILL set target_date to the next occurrence's date (the dashboard reads the weekday off
    it to place the class each week).
The module code is given in the message. If the announcement gives a join/meeting URL (Teams, Zoom,
Google Meet, etc.), put that full URL in the goal's "link" field; otherwise set link to null. Only
classes/sessions get a link and recurring=true — leave both off for ordinary tasks.

RECONCILING WITH CLASSES ALREADY ON THE DASHBOARD (this is important — the university often sends the
class TIME first and the join LINK days later, in a SEPARATE announcement). The message may list the
classes already on the dashboard for this module, each with an id. If this announcement is about one
of those SAME classes — it adds/updates the link, or moves the day/time — DO NOT create a second
class. Instead return one goal with "updates_id" set to that existing class's id, carrying the new
detail (the link, and the new day/time if it changed). Only ever use an id from the list you are
given. If you're adding a link and the time hasn't changed, you may repeat the existing text. For a
genuinely new class, or when no matching class is listed, leave updates_id null. (updates_id is
always null for tasks.)

If a clear date is stated set target_date to it (YYYY-MM-DD); otherwise null. Never invent dates.
A date may omit the year — resolve it using "today" (given in the message) to the current or next
upcoming occurrence, and NEVER output a year earlier than today's.

Also set two fields that drive phone reminders:
  • "target_time" — the class/test start time as "HH:MM" (24-hour), if the announcement gives one;
    otherwise null. (A class at "19:00" → "19:00"; "2pm" → "14:00".) This is the SAME time you put in
    the text — now also as data so the reminder can fire before it.
  • "is_test" — true ONLY when the goal is the student SITTING a written test/exam/quiz at a set time
    (e.g. "Write Test 1", "MATH121 semester test"). false for everything else, including registrations,
    submissions, prep and classes. When true the student gets a morning-of reminder.

Return at most 3 goals.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['goals'],
  properties: {
    goals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'target_date', 'target_time', 'link', 'kind', 'recurring', 'is_test', 'updates_id'],
        properties: {
          text: { type: 'string' },
          target_date: { type: ['string', 'null'] },
          target_time: { type: ['string', 'null'] },   // "HH:MM" 24h — for the pre-class reminder
          link: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['task', 'class'] },
          recurring: { type: 'boolean' },
          is_test: { type: 'boolean' },                  // true → student is SITTING a test/exam (morning-of reminder)
          // The id of an EXISTING class this announcement updates (adds a link / changes the time),
          // or null for a brand-new goal. Prevents duplicate class rows when the link arrives late.
          updates_id: { type: ['string', 'null'] },
        },
      },
    },
  },
};

function toText(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim().slice(0, 4000);
}

function validDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// "HH:MM" (24h) → normalized "HH:MM" for a Postgres time column; anything else → null.
function validTime(t) {
  if (typeof t !== 'string') return null;
  const m = t.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

// Only accept real http(s) URLs; anything else (a stray sentence, a mailto, null) -> no link.
function validUrl(u) {
  return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim()) ? u.trim() : null;
}

// Returns the number of goals created. Never throws — failures are logged and the run continues.
export async function generateObjectives(sb) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (objectives agent skipped — no ANTHROPIC_API_KEY set)');
    return 0;
  }

  const { data: pending, error } = await sb
    .from('announcements')
    .select('id, owner, module_id, title, body_html, source_id, modules(code, title)')
    .eq('source', 'efundi')
    .is('processed_at', null)
    .limit(50);
  if (error) { console.warn(`  objectives: load failed: ${error.message}`); return 0; }
  if (!pending?.length) return 0;

  const anthropic = new Anthropic();   // reads ANTHROPIC_API_KEY from env
  const today = new Date().toISOString().slice(0, 10);
  let created = 0, updated = 0, exams = 0;

  for (const a of pending) {
    try {
      const mod = a.modules || {};
      const body = toText(a.body_html);

      // Exam-access pass (Feature A) — deterministic, runs before the LLM and independently of it.
      // Its own try so a parse/write hiccup never blocks the objectives goal. Upsert on
      // (source, source_id) makes it idempotent; each announcement is processed once anyway.
      if (a.source_id) {
        try {
          const ex = parseExamAccess(a.title, body, today);
          if (ex) {
            const { error: xe } = await sb.from('exam_access').upsert({
              owner: a.owner, module_id: a.module_id,
              kind: ex.kind, title: ex.title, access_code: ex.access_code,
              code_open: ex.code_open, code_close: ex.code_close, start_time: ex.start_time,
              event_date: ex.event_date, efundi_url: ex.efundi_url,
              source: 'efundi-exam', source_id: a.source_id,
            }, { onConflict: 'source,source_id' });
            if (xe) console.warn(`  exam-access: upsert failed: ${xe.message}`);
            else exams++;
          }
        } catch (xe) { console.warn(`  exam-access: "${a.title}" failed: ${xe?.message ?? xe}`); }
      }

      // The agent's memory of what it already listed: the open classes for this module. Re-read each
      // announcement (cheap, single-user) so a class inserted earlier THIS run is visible too. The
      // model matches "here's the link" / "class moved" announcements against these instead of
      // duplicating them. module_id null (unmapped) -> no existing list.
      // Scope to CURRENTLY-RELEVANT classes only: a late link/reschedule is always about a recurring
      // class or one that's upcoming/just-passed — not a class from two months ago. (Classes have no
      // done-tick, so old one-offs linger at done=false; bounding here keeps the list clean & cheap.)
      let existing = [];
      if (a.module_id) {
        const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const { data: ex } = await sb.from('goals')
          .select('id, text, target_date, link, recurring')
          .eq('kind', 'class').eq('done', false).eq('module_id', a.module_id)
          .or(`recurring.eq.true,target_date.is.null,target_date.gte.${recentCutoff}`)
          .limit(12);
        existing = ex || [];
      }
      const existingIds = new Set(existing.map(c => c.id));
      const existingList = existing.length
        ? existing.map(c => `- id=${c.id} · "${c.text}"${c.target_date ? ` · ${c.target_date}` : ''}`
            + ` · ${c.link ? 'has link' : 'NO link yet'}${c.recurring ? ' · weekly' : ''}`).join('\n')
        : '(none yet)';

      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Today is ${today}.\nModule ${mod.code ?? ''} — ${mod.title ?? ''}\n`
            + `Classes already on the dashboard for this module (reconcile — do not duplicate):\n${existingList}\n\n`
            + `Announcement: "${a.title}"\n${body}`,
        }],
      });

      const text = (msg.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
      let goals = [];
      try { goals = JSON.parse(text)?.goals ?? []; } catch { goals = []; }

      for (const g of goals.slice(0, 3)) {
        // An update to an existing class (the link arrived late, or the time moved): patch that row
        // instead of inserting a duplicate. Only trust an id we actually handed the model.
        const updId = g?.updates_id && existingIds.has(g.updates_id) ? g.updates_id : null;
        if (updId) {
          const patch = { kind: 'class' };
          if (g.text) patch.text = String(g.text).slice(0, 300);
          if (validDate(g.target_date)) patch.target_date = validDate(g.target_date);
          // Time is sticky like the link — a new stated time updates it, a time-less update never wipes it.
          if (validTime(g.target_time)) patch.target_time = validTime(g.target_time);
          // Link is sticky: a newer real link replaces the old one, but a link-less update (e.g. a
          // time change) never wipes a link the lecturer already posted.
          if (validUrl(g.link)) patch.link = validUrl(g.link);
          if (typeof g.recurring === 'boolean') patch.recurring = g.recurring;
          const { error: ue } = await sb.from('goals').update(patch).eq('id', updId);
          if (ue) { console.warn(`  objectives: goal update failed: ${ue.message}`); continue; }
          updated++;
          continue;
        }

        if (!g?.text) continue;
        const { error: ge } = await sb.from('goals').insert({
          owner: a.owner, module_id: a.module_id,
          text: String(g.text).slice(0, 300), target_date: validDate(g.target_date),
          target_time: validTime(g.target_time),
          link: validUrl(g.link), kind: g.kind === 'class' ? 'class' : 'task',
          recurring: g.kind === 'class' && g.recurring === true,
          // Only a task can be a test sitting; a class is never a "test" for reminder purposes.
          is_test: g.kind !== 'class' && g.is_test === true,
          source: 'efundi-agent', source_id: a.source_id,
        });
        if (ge) { console.warn(`  objectives: goal insert failed: ${ge.message}`); continue; }
        created++;
      }

      // Mark processed only after a successful model call, so a transient failure retries next run.
      await sb.from('announcements').update({ processed_at: new Date().toISOString() }).eq('id', a.id);
    } catch (e) {
      console.warn(`  objectives: "${a.title}" failed: ${e?.message ?? e}`);
      // leave processed_at null -> retried next run
    }
  }

  console.log(`✓ Objectives agent: ${created} new + ${updated} updated goal(s)`
    + `${exams ? `, ${exams} exam-access row(s)` : ''} from ${pending.length} new announcement(s).`);
  return created;
}
