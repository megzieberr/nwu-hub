# Briefing a Claude Code tutor on a module (fast, one query)

When you start a Claude Code tutor session for a module (e.g. to work on an assignment), the tutor
should **not** crawl the repo or list every file. Instead it runs **one** query against the
`module_context` view and gets briefed instantly.

## The one query

```sql
select * from module_context where code = 'ALDE122';
```

One row, with everything the tutor needs as compact JSON:

| Column | What it gives the tutor |
|---|---|
| `code`, `title`, `outcomes` | What the module is |
| `announcements` | **The lecturer's own words** — what was said about assignments, tests, classes. This is the context so you never have to relay it. Lightly stripped to readable text. |
| `objectives` | Your current goals for the module (agent-generated + hand-set), with due dates and done state |
| `assessments` | Deadlines: title, type, due date, status |
| `files` | Every file's `title` + `path` + `awaiting_summary` flag. **Titles only** — the tutor picks the one file it needs and downloads just that, rather than reading everything |
| `summaries` | Which summaries already exist (so it doesn't duplicate work) |

## Suggested tutor instruction

Add something like this to your Claude Code tutor's setup (CLAUDE.md / project instructions):

> At the start of a module session, run `select * from module_context where code = '<MODULE>'`
> to load the lecturer's announcements, current objectives, deadlines, and file list. Read the
> `announcements` for any brief the lecturer gave. To use a specific file, download it from its
> `path` in `files` (Supabase storage bucket `resources`) — don't read files you don't need.
> Files with `awaiting_summary: true` are new and have no summary yet — good candidates to turn
> into a summary if the student asks.

## Why this is fast

- One row instead of six table scans.
- File **titles + paths**, not contents — the tutor fetches only the file it actually needs.
- `awaiting_summary` is the tutor's work queue: it instantly sees what's new to summarize.

The view is `security_invoker` (respects row-level security), so it only ever returns the owner's
own data.
