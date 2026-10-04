/* hub-window — a narrow window onto the hub owner's SHARED course material, for the second
   learner's Claude Code tutors to read at the start of a session. Built from section 4 of the
   private hub-window spec (a PLAN-*.md on Megan's disk — gitignored, because it names a person;
   this file never does). Same shape as the proven tutor-progress function in the Re:Lefela project.

   THE SCOPE RULE. Read this before adding a single query.
   Every query in this function is one of exactly two kinds:
     (1) a SHARED read, pinned to `owner = <the hub owner's user id>` AND to a module that is not
         hidden and is not TPED178; or
     (2) a PERSONAL read or write, pinned to `owner = <the token's user_id>`.
   There is no third kind. Do not add a query that is neither. The owner's id is resolved once per
   request from `profiles` where `role = 'owner'` — never hardcoded, and never returned to the
   caller.

   TABLES THIS FUNCTION MAY TOUCH: profiles (display_name only), modules, study_units, assessments,
   resources, summaries, past_papers, exam_access, tutor_docs, goals, study_log, and the private
   `resources` storage bucket (signed URLs only).

   TABLES IT MAY NEVER TOUCH, named here so a future edit does not quietly add one: announcements,
   summary_notes, push_subscriptions, efundi_site_map, efundi_sync_runs, project_parts,
   hub_tutor_tokens (beyond the auth lookup at the top), auth.users.

   COLUMN STRIP. `assessments.mark` is the owner's own mark and is never selected, anywhere, for any
   reason. Every select below names its columns; `select('*')` is banned in this file, because a
   column added to a table later would otherwise start flowing out on its own.

   AUTH. Deployed with verify_jwt = false ON PURPOSE, exactly as tutor-progress is: the caller
   presents a tutor token, not a Supabase JWT, so the gateway has to let the request reach this
   custom check. A wrong token costs one indexed primary-key lookup and returns 401 with no data.
   Only the SHA-256 of a token is ever stored (public.hub_tutor_tokens, 0020_hub_window.sql), so a
   database leak cannot reveal a live token, and revoking is one UPDATE.

   WRITES. Exactly three, all pinned to the token's user_id and nothing else:
     - one study_log row per POST `log`, at most 20 per calendar day;
     - one goals row per POST `todo-add`, at most 10 per calendar day;
     - `done = true` on one of the token holder's OWN goals per POST `todo-done`.
   The last two run only when the token row carries `can_write_goals = true`, which starts off. The
   `owner = uid` pin on todo-done is what stops any reach into the hub owner's rows; a matching row
   that is not hers simply updates nothing and answers 404.

   SIZE. A tutor reads `overview` at the start of every session, so it is deliberately compact
   (target under 8 kB): counts rather than lists, hard caps with an honest `truncated` message when
   a list clips, and document bodies paged at 50 000 characters. The 55 kB first cut of
   tutor-progress is the lesson this is avoiding.

   No CORS headers: nothing in a browser calls this. The caller is a small PowerShell helper on the
   learner's own laptop. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/* Modules out of the window whatever their `hidden` flag says. TPED178 is the hub owner's teaching
   practice — her own reflective work, not shared course material (her ruling). `hidden = true` is
   filtered separately, so a module that is hidden for any other reason drops out too. */
const OUT_OF_SCOPE_CODES = ["TPED178"];

const PART_CHARS = 50_000;        // one page of a summary or a tutor doc
const DEADLINES_MAX = 30;
const FUTURE_ASSESSMENTS_MAX = 200; // read once, feeds both `deadlines` and each module's next_due
const EXAM_ACCESS_MAX = 30;
const SCHEDULE_MAX = 30;
const SCHEDULE_BACK_DAYS = 2;     // a class two days old is still worth reading out
const MY_TODO_MAX = 60;
const STUDY_LOG_DAYS = 21;
const STUDY_LOG_MAX = 40;
const MODULE_LIST_MAX = 400;      // resources/summaries per module; true totals come from count
const WHATSNEW_MAX = 100;
const WHATSNEW_PER_TABLE = 200;
const WHATSNEW_MAX_DAYS = 120;
const SIGNED_URL_SECONDS = 300;   // matches src/App.jsx downloadResource()
const LOG_PER_DAY = 20;
const TODO_PER_DAY = 10;
const NOTE_MAX = 1000;
const TODO_TEXT_MAX = 300;
const MINUTES_MIN = 1;
const MINUTES_MAX = 600;
const TARGET_DATE_MAX_DAYS = 365;

/* The tag written on every goal this function creates. Deliberately impersonal: this repo is
   public, so no file in it carries a person's name. Anything querying these rows later must use
   this same string. */
const GOAL_SOURCE = "hub-window";
/* The only goals of the owner's that are ever served: the eFundi agent's dated class/task rows.
   Her hand-typed goals carry source NULL and never appear. */
const AGENT_SOURCE = "efundi-agent";

/* South African Standard Time, UTC+2, no DST. "Calendar day" in the daily caps means her day and
   the learner's day, not the server's UTC day. */
const SAST_OFFSET_MIN = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Row = Record<string, any>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/* Every refusal is one plain sentence and carries no data of any kind. */
function fail(message: string, status: number): Response {
  return json({ error: message }, status);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* Bearer header is the documented way in; ?token= exists so a plain curl can test the endpoint
   without header juggling. Same two doors as tutor-progress. */
function presentedToken(req: Request): string | null {
  const m = (req.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = new URL(req.url).searchParams.get("token");
  return q && q.trim() ? q.trim() : null;
}

/* The same tag strip as sync/objectives.js toText(), without its 4000-character clip — paging
   below replaces the clip, so nothing is silently lost mid-sentence. */
function stripHtml(html: string): string {
  return (html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function sastToday(now: Date): string {
  return new Date(now.getTime() + SAST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

function sastDayShift(now: Date, days: number): string {
  return new Date(now.getTime() + SAST_OFFSET_MIN * 60_000 + days * 864e5)
    .toISOString().slice(0, 10);
}

/* Start of the current SAST calendar day, expressed as a UTC timestamp for the query. */
function sastDayStartISO(now: Date): string {
  const shifted = new Date(now.getTime() + SAST_OFFSET_MIN * 60_000);
  const midnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return new Date(midnight - SAST_OFFSET_MIN * 60_000).toISOString();
}

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/* Cut a long body into 50 000-character pages. Returns null when the caller asked for a page that
   does not exist, so the answer is a plain 400 rather than an empty string that reads like "there
   was nothing there". */
function pageOf(text: string, partRaw: string | null): { part: number; parts: number; text: string } | null {
  const parts = Math.max(1, Math.ceil(text.length / PART_CHARS));
  let part = 1;
  if (partRaw !== null && partRaw !== "") {
    const n = Number(partRaw);
    if (!Number.isInteger(n) || n < 1 || n > parts) return null;
    part = n;
  }
  return { part, parts, text: text.slice((part - 1) * PART_CHARS, part * PART_CHARS) };
}

Deno.serve(async (req: Request) => {
  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "POST") {
    return fail("Use GET to read, or POST to record a study session.", 405);
  }

  const token = presentedToken(req);
  if (!token) {
    return fail("No token. Send header: Authorization: Bearer <your token>", 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data: tok, error: tokErr } = await admin
    .from("hub_tutor_tokens")
    .select("user_id,label,can_write_goals,revoked_at")
    .eq("token_sha256", await sha256Hex(token))
    .maybeSingle();

  if (tokErr) {
    console.error("token lookup failed", tokErr.message);
    return fail("Token lookup failed.", 500);
  }
  if (!tok || tok.revoked_at) {
    return fail("Unknown or revoked token.", 401);
  }

  /* From here on, `uid` is the only person this request may write for, or read personal rows for.
     Kind (2) of the scope rule. */
  const uid: string = tok.user_id as string;
  const now = new Date();
  const today = sastToday(now);

  try {
    /* Kind (1) of the scope rule starts here: resolve the hub owner, never hardcode. */
    const { data: owners, error: ownerErr } = await admin
      .from("profiles")
      .select("id,created_at")
      .eq("role", "owner")
      .order("created_at", { ascending: true });
    if (ownerErr) throw ownerErr;
    if (!owners || owners.length === 0) {
      return fail("The hub has no owner account, so there is nothing to show.", 500);
    }
    const ownerIds: string[] = owners.map((o: Row) => o.id as string);
    const ownerId: string = ownerIds[0];

    const { data: allMods, error: modErr } = await admin
      .from("modules")
      .select("id,code,title,lecturer_name,credits,participation_pct,exam_pct,exam_min,pass_min,outcomes")
      .eq("owner", ownerId)
      .eq("hidden", false)
      .order("code", { ascending: true });
    if (modErr) throw modErr;

    const modules: Row[] = (allMods ?? [])
      .filter((m: Row) => !OUT_OF_SCOPE_CODES.includes(String(m.code)));
    const moduleIds: string[] = modules.map((m: Row) => m.id as string);
    const codeOf = new Map<string, string>(modules.map((m: Row) => [m.id as string, m.code as string]));
    const byCode = new Map<string, Row>(modules.map((m: Row) => [String(m.code).toUpperCase(), m]));

    if (moduleIds.length === 0) {
      return fail("There are no modules in this window yet.", 404);
    }

    // ----------------------------------------------------------------
    // GET
    // ----------------------------------------------------------------
    if (method === "GET") {
      const url = new URL(req.url);
      const action = (url.searchParams.get("action") ?? "overview").trim().toLowerCase();

      if (action === "overview") {
        const sinceLog = new Date(now.getTime() - STUDY_LOG_DAYS * 864e5).toISOString();
        const scheduleFloor = sastDayShift(now, -SCHEDULE_BACK_DAYS);
        const inScope = `(${moduleIds.join(",")})`;

        const [learnerRes, unitRes, assessRes, examRes, schedRes, todoRes, logRes] = await Promise.all([
          admin.from("profiles").select("display_name").eq("id", uid).maybeSingle(),
          /* Units are curriculum-sized (tens of rows, added by hand), so reading them is safe under
             PostgREST's 1000-row ceiling. The three that grow on their own — resources, summaries,
             tutor_docs — are counted in the database instead, below. */
          admin.from("study_units").select("module_id,status")
            .eq("owner", ownerId).in("module_id", moduleIds),
          admin.from("assessments").select("module_id,title,type,due_date,weight_pct,status")
            .eq("owner", ownerId).in("module_id", moduleIds)
            .gte("due_date", today)
            .order("due_date", { ascending: true })
            .limit(FUTURE_ASSESSMENTS_MAX),
          admin.from("exam_access").select("module_id,title,kind,event_date,start_time")
            .eq("owner", ownerId).in("module_id", moduleIds)
            .gte("event_date", today)
            .order("event_date", { ascending: true })
            .limit(EXAM_ACCESS_MAX),
          /* The hard filter from the spec, section 3: only the eFundi agent's rows, only recent or
             recurring ones, and never a row belonging to an out-of-scope module. A goal with no
             module at all is a plain diary line and stays in. */
          admin.from("goals").select("text,kind,target_date,target_time,link,recurring")
            .eq("owner", ownerId).eq("source", AGENT_SOURCE)
            .or(`target_date.gte.${scheduleFloor},recurring.is.true`)
            .or(`module_id.is.null,module_id.in.${inScope}`)
            .order("target_date", { ascending: true, nullsFirst: false })
            .limit(SCHEDULE_MAX),
          admin.from("goals").select("id,text,module_id,target_date,done")
            .eq("owner", uid).eq("kind", "task")
            .order("done", { ascending: true })
            .order("target_date", { ascending: true, nullsFirst: false })
            .limit(MY_TODO_MAX),
          admin.from("study_log").select("module_id,studied_at,minutes,note")
            .eq("owner", uid).gte("studied_at", sinceLog)
            .order("studied_at", { ascending: false })
            .limit(STUDY_LOG_MAX),
        ]);

        const firstErr = [learnerRes, unitRes, assessRes, examRes, schedRes, todoRes, logRes]
          .find((r: Row) => r.error);
        if (firstErr?.error) throw firstErr.error;

        /* Three exact counts per module, done in the database. Selecting the rows and counting them
           here would silently undercount the moment a module passes PostgREST's 1000-row cap —
           resources is already at 236 and the eFundi sync adds to it twice a day. */
        const counts = await Promise.all(modules.map(async (m: Row) => {
          const [r, s, d] = await Promise.all([
            admin.from("resources").select("id", { count: "exact", head: true })
              .eq("owner", ownerId).eq("module_id", m.id),
            admin.from("summaries").select("id", { count: "exact", head: true })
              .eq("owner", ownerId).eq("module_id", m.id),
            admin.from("tutor_docs").select("id", { count: "exact", head: true })
              .in("owner", ownerIds).eq("module_id", m.id),
          ]);
          const bad = [r, s, d].find((x: Row) => x.error);
          if (bad?.error) throw bad.error;
          return { id: m.id as string, resources: r.count ?? 0, summaries: s.count ?? 0, tutor_docs: d.count ?? 0 };
        }));
        const countOf = new Map(counts.map((c) => [c.id, c]));

        const futureAssessments: Row[] = assessRes.data ?? [];
        const nextDue = new Map<string, string>();
        for (const a of futureAssessments) {
          const mid = a.module_id as string;
          if (a.due_date && !nextDue.has(mid)) nextDue.set(mid, a.due_date as string);
        }

        const units: Row[] = unitRes.data ?? [];

        return json({
          generated_at: now.toISOString(),
          learner: { display_name: learnerRes.data?.display_name ?? null },
          modules: modules.map((m: Row) => {
            const mine = units.filter((u: Row) => u.module_id === m.id);
            const c = countOf.get(m.id as string);
            return {
              code: m.code,
              title: m.title,
              units_total: mine.length,
              units_done: mine.filter((u: Row) => u.status === "done").length,
              resources: c?.resources ?? 0,
              summaries: c?.summaries ?? 0,
              tutor_docs: c?.tutor_docs ?? 0,
              next_due: nextDue.get(m.id as string) ?? null,
            };
          }),
          deadlines: futureAssessments.slice(0, DEADLINES_MAX).map((a: Row) => ({
            module: codeOf.get(a.module_id as string) ?? null,
            title: a.title,
            type: a.type,
            due_date: a.due_date,
            weight_pct: a.weight_pct,
            status: a.status,
          })),
          deadlines_truncated: futureAssessments.length > DEADLINES_MAX
            ? `showing the next ${DEADLINES_MAX} of ${futureAssessments.length} dated items`
            : false,
          exam_access: (examRes.data ?? []).map((e: Row) => ({
            module: codeOf.get(e.module_id as string) ?? null,
            title: e.title,
            kind: e.kind,
            event_date: e.event_date,
            start_time: e.start_time,
          })),
          /* Present this as the hub owner's class schedule, never as the learner's own list — she
             sometimes corrects a wrong date by hand, and this is the corrected copy. */
          schedule_from_megan: (schedRes.data ?? []).map((g: Row) => ({
            text: g.text,
            kind: g.kind,
            target_date: g.target_date,
            target_time: g.target_time,
            link: g.link,
            recurring: g.recurring,
          })),
          my_todo: (todoRes.data ?? []).map((g: Row) => ({
            id: g.id,
            text: g.text,
            module: g.module_id ? (codeOf.get(g.module_id as string) ?? null) : null,
            target_date: g.target_date,
            done: g.done,
          })),
          my_study_log_recent: (logRes.data ?? []).map((l: Row) => ({
            module: l.module_id ? (codeOf.get(l.module_id as string) ?? null) : null,
            studied_at: l.studied_at,
            minutes: l.minutes,
            note: l.note,
          })),
          how_to:
            /* Keep this line free of the four words proof row 12 greps for — it greps the whole
               response body, and a stray one here would look like a leak. */
            "GET ?action=module&code=SECL121 for one module; ?action=summary&id=<id>&part=1 (add " +
            "&html=1 for the raw HTML) and ?action=doc&id=<id>&part=1 for a body; " +
            "?action=file&id=<id> for a 300-second download link; ?action=whatsnew&since=YYYY-MM-DD " +
            "for changes. POST {\"action\":\"log\",\"module\":\"SECL121\",\"minutes\":45,\"note\":\"...\"} " +
            "to record one study session at the end of a real session.",
        });
      }

      if (action === "module") {
        const code = (url.searchParams.get("code") ?? "").trim().toUpperCase();
        const mod = byCode.get(code);
        /* Same answer for a module that does not exist and one that is out of scope. Do not leak
           that it exists. */
        if (!mod) return fail("That module is not in this window.", 404);

        const [unitRes, assessRes, sumRes, resRes, paperRes, docRes] = await Promise.all([
          admin.from("study_units").select("id,number,title,status,notes")
            .eq("owner", ownerId).eq("module_id", mod.id)
            .order("number", { ascending: true }),
          /* No `mark`. Never `mark`. */
          admin.from("assessments").select("id,title,type,due_date,weight_pct,status")
            .eq("owner", ownerId).eq("module_id", mod.id)
            .order("due_date", { ascending: true, nullsFirst: false }),
          /* html is read only to measure it; the body itself comes from ?action=summary. */
          admin.from("summaries").select("id,title,kind,unit_id,html", { count: "exact" })
            .eq("owner", ownerId).eq("module_id", mod.id)
            .order("title", { ascending: true })
            .limit(MODULE_LIST_MAX),
          admin.from("resources").select("id,title,kind,unit_id,size_bytes,created_at", { count: "exact" })
            .eq("owner", ownerId).eq("module_id", mod.id)
            .order("created_at", { ascending: false })
            .limit(MODULE_LIST_MAX),
          admin.from("past_papers").select("id,title,year,session,kind")
            .eq("owner", ownerId).eq("module_id", mod.id)
            .order("year", { ascending: false, nullsFirst: false }),
          /* Belt and braces: tutor_docs rows are only ever served when their owner is a hub owner,
             so a row somebody else managed to create could never be read out here. */
          admin.from("tutor_docs").select("id,title,doc_kind,chars,created_at")
            .in("owner", ownerIds).eq("module_id", mod.id)
            .order("created_at", { ascending: false })
            .limit(MODULE_LIST_MAX),
        ]);

        const firstErr = [unitRes, assessRes, sumRes, resRes, paperRes, docRes]
          .find((r: Row) => r.error);
        if (firstErr?.error) throw firstErr.error;

        const units: Row[] = unitRes.data ?? [];
        const unitNumber = new Map<string, number>(
          units.map((u: Row) => [u.id as string, u.number as number]),
        );

        return json({
          module: {
            code: mod.code,
            title: mod.title,
            lecturer_name: mod.lecturer_name,
            credits: mod.credits,
            participation_pct: mod.participation_pct,
            exam_pct: mod.exam_pct,
            exam_min: mod.exam_min,
            pass_min: mod.pass_min,
            outcomes: mod.outcomes,
          },
          units: units.map((u: Row) => ({
            number: u.number, title: u.title, status: u.status, notes: u.notes,
          })),
          assessments: (assessRes.data ?? []).map((a: Row) => ({
            id: a.id, title: a.title, type: a.type,
            due_date: a.due_date, weight_pct: a.weight_pct, status: a.status,
          })),
          summaries: (sumRes.data ?? []).map((s: Row) => ({
            id: s.id,
            title: s.title,
            kind: s.kind,
            unit: s.unit_id ? (unitNumber.get(s.unit_id as string) ?? null) : null,
            chars: stripHtml(String(s.html ?? "")).length,
          })),
          summaries_truncated: (sumRes.count ?? 0) > (sumRes.data?.length ?? 0)
            ? `showing ${sumRes.data?.length} of ${sumRes.count}`
            : false,
          resources: (resRes.data ?? []).map((r: Row) => ({
            id: r.id,
            title: r.title,
            kind: r.kind,
            unit: r.unit_id ? (unitNumber.get(r.unit_id as string) ?? null) : null,
            size_bytes: r.size_bytes,
            created_at: r.created_at,
          })),
          resources_truncated: (resRes.count ?? 0) > (resRes.data?.length ?? 0)
            ? `showing ${resRes.data?.length} of ${resRes.count}`
            : false,
          past_papers: (paperRes.data ?? []).map((p: Row) => ({
            id: p.id, title: p.title, year: p.year, session: p.session, kind: p.kind,
          })),
          tutor_docs: (docRes.data ?? []).map((d: Row) => ({
            id: d.id, title: d.title, doc_kind: d.doc_kind, chars: d.chars, created_at: d.created_at,
          })),
        });
      }

      if (action === "summary" || action === "doc") {
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!UUID_RE.test(id)) return fail("Send a valid id.", 400);

        let title: string | null = null;
        let moduleId: string | null = null;
        let raw = "";

        if (action === "summary") {
          const { data: row, error } = await admin.from("summaries")
            .select("title,module_id,html")
            .eq("id", id).eq("owner", ownerId).in("module_id", moduleIds)
            .maybeSingle();
          if (error) throw error;
          if (!row) return fail("That summary is not in this window.", 404);
          title = row.title as string;
          moduleId = row.module_id as string;
          raw = url.searchParams.get("html") === "1"
            ? String(row.html ?? "")
            : stripHtml(String(row.html ?? ""));
        } else {
          const { data: row, error } = await admin.from("tutor_docs")
            .select("title,module_id,body_text")
            .eq("id", id).in("owner", ownerIds).in("module_id", moduleIds)
            .maybeSingle();
          if (error) throw error;
          if (!row) return fail("That document is not in this window.", 404);
          title = row.title as string;
          moduleId = row.module_id as string;
          raw = String(row.body_text ?? "");
        }

        const page = pageOf(raw, url.searchParams.get("part"));
        if (!page) return fail("There is no such part of this text.", 400);

        return json({
          title,
          module: moduleId ? (codeOf.get(moduleId) ?? null) : null,
          part: page.part,
          parts: page.parts,
          text: page.text,
        });
      }

      if (action === "file") {
        const id = (url.searchParams.get("id") ?? "").trim();
        if (!UUID_RE.test(id)) return fail("Send a valid id.", 400);

        const { data: row, error } = await admin.from("resources")
          .select("title,storage_path,module_id")
          .eq("id", id).eq("owner", ownerId).in("module_id", moduleIds)
          .maybeSingle();
        if (error) throw error;
        if (!row) return fail("That file is not in this window.", 404);

        const { data: signed, error: signErr } = await admin.storage
          .from("resources")
          .createSignedUrl(String(row.storage_path), SIGNED_URL_SECONDS);
        /* The URL itself is never logged, here or anywhere: it is a working download link for five
           minutes. Only the error message goes to the log. */
        if (signErr || !signed?.signedUrl) {
          console.error("signing failed", signErr?.message ?? "no url returned");
          return fail("Could not make a link for that file.", 500);
        }

        return json({ title: row.title, url: signed.signedUrl, expires_in: SIGNED_URL_SECONDS });
      }

      if (action === "whatsnew") {
        const asked = (url.searchParams.get("since") ?? "").trim();
        if (!isRealDate(asked)) return fail("Send since=YYYY-MM-DD.", 400);

        const floor = sastDayShift(now, -WHATSNEW_MAX_DAYS);
        const clamped = asked < floor;
        const since = clamped ? floor : asked;
        const sinceTs = `${since}T00:00:00Z`;
        const inScope = `(${moduleIds.join(",")})`;

        const [resRes, sumRes, assessRes, examRes, docRes, unitRes, goalRes] = await Promise.all([
          admin.from("resources").select("id,title,module_id,created_at")
            .eq("owner", ownerId).in("module_id", moduleIds).gte("created_at", sinceTs)
            .order("created_at", { ascending: false }).limit(WHATSNEW_PER_TABLE),
          admin.from("summaries").select("id,title,module_id,updated_at")
            .eq("owner", ownerId).in("module_id", moduleIds).gte("updated_at", sinceTs)
            .order("updated_at", { ascending: false }).limit(WHATSNEW_PER_TABLE),
          admin.from("assessments").select("id,title,module_id,updated_at")
            .eq("owner", ownerId).in("module_id", moduleIds).gte("updated_at", sinceTs)
            .order("updated_at", { ascending: false }).limit(WHATSNEW_PER_TABLE),
          admin.from("exam_access").select("id,title,module_id,created_at")
            .eq("owner", ownerId).in("module_id", moduleIds).gte("created_at", sinceTs)
            .order("created_at", { ascending: false }).limit(WHATSNEW_PER_TABLE),
          admin.from("tutor_docs").select("id,title,module_id,created_at")
            .in("owner", ownerIds).in("module_id", moduleIds).gte("created_at", sinceTs)
            .order("created_at", { ascending: false }).limit(WHATSNEW_PER_TABLE),
          admin.from("study_units").select("id,number,title,status,module_id,updated_at")
            .eq("owner", ownerId).in("module_id", moduleIds).gte("updated_at", sinceTs)
            .order("updated_at", { ascending: false }).limit(WHATSNEW_PER_TABLE),
          admin.from("goals").select("id,text,module_id,created_at")
            .eq("owner", ownerId).eq("source", AGENT_SOURCE).gte("created_at", sinceTs)
            .or(`module_id.is.null,module_id.in.${inScope}`)
            .order("created_at", { ascending: false }).limit(WHATSNEW_PER_TABLE),
        ]);

        const firstErr = [resRes, sumRes, assessRes, examRes, docRes, unitRes, goalRes]
          .find((r: Row) => r.error);
        if (firstErr?.error) throw firstErr.error;

        const items: Row[] = [];
        const push = (kind: string, rows: Row[], stamp: string, titleOf: (r: Row) => string) => {
          for (const r of rows) {
            items.push({
              kind,
              module: r.module_id ? (codeOf.get(r.module_id as string) ?? null) : null,
              id: r.id,
              title: titleOf(r),
              at: r[stamp],
            });
          }
        };
        push("resource", resRes.data ?? [], "created_at", (r) => String(r.title));
        push("summary", sumRes.data ?? [], "updated_at", (r) => String(r.title));
        push("assessment", assessRes.data ?? [], "updated_at", (r) => String(r.title));
        push("exam", examRes.data ?? [], "created_at", (r) => String(r.title));
        push("tutor_doc", docRes.data ?? [], "created_at", (r) => String(r.title));
        push("unit_status", unitRes.data ?? [], "updated_at",
          (r) => `Unit ${r.number} — ${r.title} (${r.status})`);
        push("schedule", goalRes.data ?? [], "created_at", (r) => String(r.text));

        items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        const shown = items.slice(0, WHATSNEW_MAX);

        return json({
          since,
          since_note: clamped
            ? `You asked for ${asked}; this window only goes back ${WHATSNEW_MAX_DAYS} days, so it starts at ${since}.`
            : null,
          items: shown,
          truncated: items.length > WHATSNEW_MAX
            ? `showing the newest ${WHATSNEW_MAX} of ${items.length} changes — ask again with a later date`
            : false,
        });
      }

      return fail("That is not one of this window's actions. Ask for overview, module, summary, doc, file or whatsnew.", 405);
    }

    // ----------------------------------------------------------------
    // POST — the only writes in this file, every one pinned to `uid`.
    // ----------------------------------------------------------------
    let body: Row;
    try {
      body = await req.json() as Row;
    } catch {
      return fail("Send a JSON body with an action in it.", 400);
    }
    /* `null`, a number and an array are all valid JSON, and all of them would make the reads below
       throw. Refuse them here so the answer is a plain 400, not a 500. */
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return fail("Send a JSON object with an action in it.", 400);
    }
    const action = String(body.action ?? "").trim().toLowerCase();
    const dayStart = sastDayStartISO(now);

    if (action === "log") {
      const code = String(body.module ?? "").trim().toUpperCase();
      const mod = byCode.get(code);
      if (!mod) return fail("Send a module code that is in this window.", 400);

      let unitId: string | null = null;
      if (body.unit !== undefined && body.unit !== null && body.unit !== "") {
        const n = Number(body.unit);
        if (!Number.isInteger(n)) return fail("Unit must be a whole number.", 400);
        const { data: u, error: uErr } = await admin.from("study_units").select("id")
          .eq("owner", ownerId).eq("module_id", mod.id).eq("number", n)
          .maybeSingle();
        if (uErr) throw uErr;
        if (!u) return fail("That module has no unit with that number.", 400);
        unitId = u.id as string;
      }

      const minutes = Number(body.minutes);
      if (!Number.isInteger(minutes) || minutes < MINUTES_MIN || minutes > MINUTES_MAX) {
        return fail(`Minutes must be a whole number from ${MINUTES_MIN} to ${MINUTES_MAX}.`, 400);
      }

      const note = typeof body.note === "string" ? body.note.trim().slice(0, NOTE_MAX) : null;

      /* Counted before the insert so a looping tutor cannot fill the table. */
      const { count, error: cErr } = await admin.from("study_log")
        .select("id", { count: "exact", head: true })
        .eq("owner", uid).gte("created_at", dayStart);
      if (cErr) throw cErr;
      if ((count ?? 0) >= LOG_PER_DAY) {
        return fail(`That is ${LOG_PER_DAY} study sessions recorded today, which is the daily limit.`, 429);
      }

      /* studied_at is the server's clock, never the caller's. */
      const { data: ins, error: insErr } = await admin.from("study_log")
        .insert({
          owner: uid,
          module_id: mod.id,
          unit_id: unitId,
          minutes,
          note,
          studied_at: now.toISOString(),
        })
        .select("id,studied_at")
        .single();
      if (insErr) throw insErr;

      return json({ ok: true, id: ins.id, studied_at: ins.studied_at });
    }

    if (action === "todo-add" || action === "todo-done") {
      if (!tok.can_write_goals) {
        return fail("This token cannot change the to-do list.", 403);
      }

      if (action === "todo-add") {
        const text = String(body.text ?? "").trim().slice(0, TODO_TEXT_MAX);
        if (!text) return fail("Send some text for the to-do.", 400);

        let moduleId: string | null = null;
        if (body.module !== undefined && body.module !== null && String(body.module).trim() !== "") {
          const mod = byCode.get(String(body.module).trim().toUpperCase());
          if (!mod) return fail("Send a module code that is in this window.", 400);
          moduleId = mod.id as string;
        }

        let targetDate: string | null = null;
        if (body.target_date !== undefined && body.target_date !== null
            && String(body.target_date).trim() !== "") {
          const d = String(body.target_date).trim();
          if (!isRealDate(d)) return fail("A target date must look like YYYY-MM-DD.", 400);
          if (d > sastDayShift(now, TARGET_DATE_MAX_DAYS)) {
            return fail("A target date more than a year away is almost certainly a typo.", 400);
          }
          targetDate = d;
        }

        const { count, error: cErr } = await admin.from("goals")
          .select("id", { count: "exact", head: true })
          .eq("owner", uid).eq("source", GOAL_SOURCE).gte("created_at", dayStart);
        if (cErr) throw cErr;
        if ((count ?? 0) >= TODO_PER_DAY) {
          return fail(`That is ${TODO_PER_DAY} new to-do items today, which is the daily limit.`, 429);
        }

        const { data: ins, error: insErr } = await admin.from("goals")
          .insert({
            owner: uid,
            module_id: moduleId,
            text,
            target_date: targetDate,
            source: GOAL_SOURCE,
            kind: "task",
          })
          .select("id")
          .single();
        if (insErr) throw insErr;

        return json({ ok: true, id: ins.id });
      }

      const id = String(body.id ?? "").trim();
      if (!UUID_RE.test(id)) return fail("Send a valid id.", 400);

      /* `owner = uid` is the whole wall. A goal id belonging to anyone else matches nothing, so
         nothing is updated and the answer is the same 404 as a made-up id — no oracle either way. */
      const { data: upd, error: updErr } = await admin.from("goals")
        .update({ done: true })
        .eq("id", id).eq("owner", uid)
        .select("id");
      if (updErr) throw updErr;
      if (!upd || upd.length === 0) {
        return fail("There is no to-do with that id on this record.", 404);
      }

      return json({ ok: true, id });
    }

    return fail("That is not something this window can do. It can record a study session with action \"log\".", 405);
  } catch (err) {
    console.error(`hub-window failed: ${(err as Error)?.message ?? err}`);
    return fail("Something went wrong reading the hub.", 500);
  }
});
