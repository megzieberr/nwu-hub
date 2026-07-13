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
know what/when. Always include, in this order: the module code, the weekday + date, and the time.
Format them like "MATV121 online class — Wed 17 Jul, 19:00" (the module code is given in the message).
If the announcement gives a join/meeting URL (Teams, Zoom, Google Meet, etc.), put that full URL in
the goal's "link" field; otherwise set link to null. Only classes/sessions get a link — leave it
null for ordinary tasks.

If a clear date is stated set target_date to it (YYYY-MM-DD); otherwise null. Never invent dates.
A date may omit the year — resolve it using "today" (given in the message) to the current or next
upcoming occurrence, and NEVER output a year earlier than today's. Return at most 3 goals.`;

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
        required: ['text', 'target_date', 'link', 'kind'],
        properties: {
          text: { type: 'string' },
          target_date: { type: ['string', 'null'] },
          link: { type: ['string', 'null'] },
          kind: { type: 'string', enum: ['task', 'class'] },
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
  let created = 0;

  for (const a of pending) {
    try {
      const mod = a.modules || {};
      const body = toText(a.body_html);
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        system: SYSTEM,
        messages: [{
          role: 'user',
          content: `Today is ${today}.\nModule ${mod.code ?? ''} — ${mod.title ?? ''}\nAnnouncement: "${a.title}"\n${body}`,
        }],
      });

      const text = (msg.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
      let goals = [];
      try { goals = JSON.parse(text)?.goals ?? []; } catch { goals = []; }

      for (const g of goals.slice(0, 3)) {
        if (!g?.text) continue;
        const { error: ge } = await sb.from('goals').insert({
          owner: a.owner, module_id: a.module_id,
          text: String(g.text).slice(0, 300), target_date: validDate(g.target_date),
          link: validUrl(g.link), kind: g.kind === 'class' ? 'class' : 'task',
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

  console.log(`✓ Objectives agent: ${created} goal(s) from ${pending.length} new announcement(s).`);
  return created;
}
