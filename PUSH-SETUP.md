# PUSH-SETUP.md — turning on phone reminders for the NWU Study Hub

This switches on **push reminders to your phone**: a nudge **~45 min before a class**, and on the
**morning of a test or exam** (the exam one even carries the access code + register window, and taps
straight through to the Tests & Exams tab). Only **you** get them — Lize (the read-only viewer) never
does. Reuses the same recipe as Circle Quest / Shower Schedule, so it should feel familiar. Allow
about **20–25 minutes**.

> **Your project ref is `aefjicdxeflqnquiebvc`** (the bit in your Supabase URL). It's already filled
> into `supabase/cron.sql`, so you only paste one secret there.

> The database migration (`0013_push_reminders.sql`) is **already applied** — I did it via MCP. So
> Part 3 below is just an FYI; you don't run it.

---

## Part 1 — Make the notification keys (VAPID)

1. Open **PowerShell**, then:
   ```powershell
   cd "$HOME\Desktop\Claude Code Projects\nwu-hub"
   python tools\gen_vapid.py
   ```
   (If it complains, run `python -m pip install cryptography` first.)
2. It prints a **PUBLIC** key and a **PRIVATE** key. Copy each into a notes app, labelled
   `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`. Treat the PRIVATE one like a password.

---

## Part 2 — Put the public key in the app

1. Open **`src/lib/push-config.js`**.
2. Paste your **PUBLIC** key between the quotes:
   ```js
   export const VAPID_PUBLIC_KEY = 'BPxabc...your public key...xyz'
   ```
3. Save. (I'll build, commit and push this for you — the 🔔 Reminders card on the dashboard stays
   hidden until this key is set, so nothing looks broken before then.)

---

## Part 3 — The database table *(already done — FYI only)*

Migration `0013_push_reminders.sql` added the `push_subscriptions` table plus the reminder columns
(`goals.target_time`, `goals.is_test`, `goals.reminded_at`, `exam_access.reminded_at`). It's already
applied to the live database via MCP — **nothing to do here.**

---

## Part 4 — Turn on the scheduler, and make a CRON secret

### 4a. Switch on two extensions
1. Supabase → **Database** → **Extensions**.
2. Turn **pg_cron** ON, and **pg_net** ON. *(Or skip — `cron.sql` in Part 7 enables them too.)*

### 4b. Make a CRON secret
3. In PowerShell:
   ```powershell
   python -c "import secrets; print(secrets.token_hex(24))"
   ```
4. Copy it into notes, labelled `CRON_SECRET`. You'll use the **exact same value** in Part 5 and Part 7.

---

## Part 5 — Store the secrets in Supabase

1. Supabase → **Edge Functions** → **Secrets** (Manage secrets).
2. Add these **four** (Name exactly as shown, paste the Value, Save):

   | Name | Value |
   | --- | --- |
   | `VAPID_PRIVATE_KEY` | your PRIVATE key from Part 1 |
   | `VAPID_PUBLIC_KEY` | your PUBLIC key from Part 1 |
   | `VAPID_SUBJECT` | `mailto:megzieberr@gmail.com` |
   | `CRON_SECRET` | your CRON_SECRET from Part 4b (must match Part 7 exactly) |

   You do **not** add the service-role key — Supabase gives that to the function automatically.

---

## Part 6 — Deploy the notification function

1. Supabase → **Edge Functions** → **Create a function** → name it exactly `send-push`.
2. Open **`supabase/functions/send-push/index.ts`**, select all, copy, and paste it over the sample.
3. Turn **Verify JWT** **OFF** (the scheduler calls it with the CRON_SECRET, not a login token).
4. **Deploy.**

*(Or, if you'd rather, tell me and I'll deploy it for you via MCP — the function code holds no
secrets, it reads them from the secrets you set in Part 5.)*

---

## Part 7 — Schedule the reminders

1. Open **`supabase/cron.sql`**, replace `<CRON_SECRET>` with your CRON_SECRET from Part 4b. Save.
2. Supabase → **SQL Editor** → **New query** → paste the whole file → **Run**.
   - Check: `select jobname, schedule from cron.job;` should list `nwu-hub-reminders` at `*/15 * * * *`.

The job runs every 15 minutes and only sends when something is actually due — most runs send nothing.

---

## Part 8 — Turn it on and test

1. **On your phone**, open the installed hub (see the install note below), then on the dashboard tap
   **🔔 Turn on** → **Allow**.
2. In Supabase → **Edge Functions → send-push → Invoke**:
   - Body: `{ "test": true }`
   - Header: `x-cron-secret` = your CRON_SECRET.
   - Send → within a few seconds you should get a test notification.

### 📱 iPhone caveat (important)
On iPhone, web push works **only** if the hub is **added to the Home Screen and opened from that
icon** — never a Safari tab, and never inside WhatsApp. To install: open the hub in **Safari** →
**Share** (□↑) → **Add to Home Screen** → **Add**, then open it from the new icon and log in. On
Android/Chrome: **⋮** → **Install app**. The 🔔 card only appears once push is available (so on iPhone
it shows up *after* you've installed and opened from the icon).

### If a notification doesn't arrive
- Make sure you tapped **Allow** (not Block), and the phone isn't on Do-Not-Disturb/Focus.
- **iPhone:** confirm you opened it from the Home-Screen icon, not a tab.
- Supabase → **Edge Functions → send-push → Logs**: a `401` means the `x-cron-secret` in Part 5 and
  Part 7 don't match; re-check they're identical.
- Re-open the app once after installing — that's when the device registers.

---

## How the reminders actually fire (for reference)
- **Classes** — the sender pings ~45 min before `target_time` on the class's day (recurring classes
  every week on their weekday). A class with no time gets a 07:00 nudge instead.
- **Exams** (a Tests & Exams row) — 07:00 on the write date; the message carries the **access code +
  register window + write time**, and tapping it opens the Tests & Exams tab.
- **Written tests** flagged by the agent (`is_test`) — 07:00 on the date; suppressed if an exam row
  already covers that module + date (so one sitting never double-pings).
- Nothing ever fires twice (a `reminded_at` stamp), and past events never fire.
