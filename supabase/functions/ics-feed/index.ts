// NWU Study Hub — the Google Calendar feed.
//
// GET .../functions/v1/ics-feed?t=<ics_token> → a live .ics of the token owner's classes
// (goals.kind='class'), so Google/Apple/Outlook re-fetch it on their own schedule and a class the
// eFundi sync adds or moves shows up without Megan doing anything (PLAN-calendar-feed.md).
//
// Verify-JWT is OFF for this function — Google's calendar fetcher carries no auth headers at all,
// so the token in the query string IS the whole access control. It is looked up with the SERVICE
// ROLE (bypasses RLS) against `profiles.ics_token`, a column that 0016_ics_token.sql deliberately
// pulled out of every normal table grant (see that migration's header) so a leaked/guessed short
// token is the only way in — never a Supabase session. Unknown/missing/malformed token → a bare
// 404, same shape either way, so the response itself never confirms a token format is "close".
//
// The actual calendar text is built by the pure, unit-tested ics.mjs (sync/verify-ics.mjs) — this
// file is just the I/O shell around it, same split as supabase/functions/send-push/index.ts.

import { createClient } from "npm:@supabase/supabase-js@2";
import { buildCalendar } from "./ics.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

const TOKEN_RE = /^[0-9a-f]{48}$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== "GET") {
    return new Response("method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  try {
    const url = new URL(req.url);
    const t = url.searchParams.get("t") ?? "";
    if (!TOKEN_RE.test(t)) {
      return new Response("", { status: 404, headers: CORS_HEADERS });
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .eq("ics_token", t)
      .maybeSingle();
    if (!profile) {
      return new Response("", { status: 404, headers: CORS_HEADERS });
    }

    const { data: goals, error } = await admin
      .from("goals")
      .select("id,text,target_date,target_time,recurring,link,created_at,modules(code)")
      .eq("owner", profile.id)
      .eq("kind", "class");
    if (error) throw error;

    const classes = (goals ?? []).map((g) => ({
      id: g.id,
      text: g.text,
      target_date: g.target_date,
      target_time: g.target_time,
      recurring: g.recurring,
      link: g.link,
      created_at: g.created_at,
      code: (g.modules as { code?: string } | null)?.code ?? "",
    }));

    const body = buildCalendar(classes, { now: new Date() });

    return new Response(body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "text/calendar; charset=utf-8",
        "Cache-Control": "no-cache, max-age=0",
        "Content-Disposition": 'inline; filename="nwu-classes.ics"',
      },
    });
  } catch (err) {
    console.error(`ics-feed failed: ${(err as Error)?.message ?? err}`);
    return new Response("could not build the calendar feed", { status: 500, headers: CORS_HEADERS });
  }
});
