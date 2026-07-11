# eFundi recon worksheet (Phase 0.2 + 0.3)

**Who does this:** Megan, in her own browser, logged into her own eFundi account. ~5–10 min.
**Why:** capture the two facts the plan can't guess — the exact CAS login form fields, and which Sakai `/direct/` JSON endpoints NWU left enabled. Fill in the blanks marked `➡️ ANSWER:` and hand this back. Opus builds the worker from these values.

**Browser:** use **Firefox or Edge** (NWU-recommended) or Chrome — all have the same DevTools. Screenshots are fine instead of typing, if easier.

> ⚠️ **When you paste answers back, redact your password.** In the login POST (Part B) the password shows in plain text — black it out / replace with `***`. Everything else (usernames, tokens, site IDs) is safe to share. Do not paste your password anywhere in this file.

---

## Part A — Open DevTools and start recording (30 sec)

1. Open a **fresh/incognito** window so you start logged out.
2. Press **F12** (or right-click → *Inspect*) to open DevTools.
3. Click the **Network** tab.
4. Tick **Preserve log** (Firefox: "Persist Logs"). This keeps entries across the login redirects — important, or they vanish when the page navigates.
5. Leave it open. Now go to `https://efundi.nwu.ac.za` and click **Login** so you land on the purple CAS page.

---

## Part B — Capture the login form (Phase 0.2)

**B1. The login page fields (the form itself):**
On the CAS login page, before typing anything: right-click the page → *View Page Source* (or in DevTools **Elements/Inspector**, find the `<form>`). Look for the `<form action="...">` and every `<input type="hidden" ...>` inside it.

- ➡️ ANSWER — form `action` URL: `__________`
- ➡️ ANSWER — list each hidden input's `name` and whether it has a value (e.g. `execution = e1s1`, `lt = LT-123...`, `_eventId = submit`). Also note the visible field names for username/password:
  ```
  (paste the hidden <input name=...> lines here)
  ```

**B2. The login POST (what actually gets submitted):**
Now type your student number + password and click **LOGIN**. In the Network tab, find the request that is a **POST** to the CAS login URL (method column = POST; it'll be the one right when you clicked login).
- Click it → **Request/Payload** tab (Firefox: "Request" → "Form data").
- ➡️ ANSWER — copy the **form-data field names and values**, but **replace the password value with `***`**:
  ```
  (e.g. username=<student-number>, password=***, execution=e1s1, _eventId=submit, ...)
  ```

**B3. The redirect chain after login:**
Still in Network, look at the requests that fire right after the POST (with Preserve log on, they'll be listed in order).
- ➡️ ANSWER — do you see a redirect to a URL containing **`?ticket=ST-...`**? Paste the host/path (ticket value can be truncated): `__________`
- ➡️ ANSWER — after landing back in eFundi, in DevTools **Application** (Chrome/Edge) or **Storage** (Firefox) → **Cookies** → `efundi.nwu.ac.za`: is there a **`JSESSIONID`** cookie? (yes/no): `__________`

---

## Part C — Probe the Sakai `/direct/` JSON API (Phase 0.3) — the important one

Now that you're logged in, **open each URL below in a new tab in the same browser** (your session cookie comes along automatically). For each: does it return **JSON** (starts with `{` or `[`), an **HTML page**, or an **error** (403 Forbidden / 404 Not Found)?

Tip: if a page shows raw JSON, great — that's what we want. If it downloads a file or shows a formatted page, note that. You don't need to understand the contents; just the type.

| # | URL to open | ➡️ ANSWER: JSON / HTML / 403 / 404 |
|---|---|---|
| 1 | `https://efundi.nwu.ac.za/direct/site.json` | |
| 2 | `https://efundi.nwu.ac.za/direct/membership.json` | |
| 3 | `https://efundi.nwu.ac.za/direct/announcement/user.json` | |
| 4 | `https://efundi.nwu.ac.za/direct/assignment/my.json` | |
| 5 | `https://efundi.nwu.ac.za/direct/content/user.json` | |
| 6 | `https://efundi.nwu.ac.za/direct/session.json` | |
| 7 | `https://efundi.nwu.ac.za/direct/gradebook.json` | |

**C1. Grab your real site (module) IDs** — needed for the per-site endpoints:
- Open **#1** (`/direct/site.json`). It lists your enrolled sites. In the JSON, find the `"id"` values (long strings like `83de4fc2-3c82-4248-b0fc-...`) and the matching `"title"` (your module names).
- ➡️ ANSWER — paste 1–2 of your real module sites as `id → title`:
  ```
  (e.g. 83de4fc2-... → STAT101 Statistics)
  ```

**C2. Now the per-site endpoints** — take ONE `siteId` from C1 and paste it into each URL below in place of `SITE_ID`, then open them:

| # | URL (replace SITE_ID) | ➡️ ANSWER: JSON / HTML / 403 / 404 |
|---|---|---|
| 8 | `https://efundi.nwu.ac.za/direct/announcement/site/SITE_ID.json` | |
| 9 | `https://efundi.nwu.ac.za/direct/assignment/site/SITE_ID.json` | |
| 10 | `https://efundi.nwu.ac.za/direct/content/site/SITE_ID.json` | |
| 11 | `https://efundi.nwu.ac.za/direct/gradebook/site/SITE_ID.json` | |

**C3.** For whichever of #1–#11 returned **JSON**, if you can, paste the **first ~15 lines** of one or two of them (announcement + content/files are the most useful) so Opus can see the field names (title, id, date, file size, download URL). Redact nothing here — this is just structure. If it's huge, the top is enough.
  ```
  (paste a short JSON sample or two here)
  ```

---

## Part D — What Opus does with this

- **B1–B3** → writes `sync/auth.js` (the CAS form-replay) against your exact field names instead of guessed ones.
- **C (which endpoints are JSON)** → decides per content-type whether to use the clean `/direct/` JSON path or fall back to HTML parsing. **The more that returned JSON, the more robust and less breakable the sync.** If most returned 403/HTML, Opus is told to lean on HTML parsing and flag reduced robustness to you.
- **C1 site IDs** → seeds the `efundi_site_map` table (eFundi site → hub module).

Once this worksheet is filled in and handed back, the plan's Phase 0 is fully closed and Opus can start on Phase 1 (the `0005_efundi_sync.sql` migration) and Phase 2 (the worker).

---

### Quick reference: what "good" looks like
- Login is one POST with `username`/`password` + an `execution` token → ✅ (classic CAS, already confirmed).
- Several `/direct/*.json` endpoints return JSON → ✅ robust sync.
- Everything 403s except the login → ⚠️ workable but scrape-based and more fragile; Opus will say so.
