# Personal workspace

A local daily overview for Jordan’s personal life and independent professional work. Start with a few priorities, add timed plans, and collect loose thoughts in Captures. Items can be edited, completed, moved to another day, or removed with an undo action. Personal and Independent work are separate filters; no Artek connections are configured.

## Run locally

Requires Node.js 22.13 or newer and npm. Dependencies are locked in `package-lock.json`.

```sh
npm ci
npm start
```

Open http://127.0.0.1:5173. `npm start` and `npm run dev` both run the local application. Stop with Ctrl-C. The server binds only to loopback and refuses to silently choose another port.

## Storage

Records live in `~/Data/personal-workspace/workspace.json`, outside this source tree. Each item has its own revision and timestamps. Record-level commands validate the resulting document, serialize writes, reject stale edits to the same item, flush a temporary file, and atomically replace the main file. Requests carry stable IDs so a retry is applied once. Removed items leave bounded tombstones, and `workspace.backup.json` keeps the previous saved version. Version-one files are migrated when read. This is a local app with optional Todoist, Google Calendar, Gmail, Plaid, iPhone, personal-site, and Chess capabilities described below. It has no remote deployment or workspace sign-in. The API is provided by the Vite middleware in `build/local-workspace.ts`; the build output alone is not a standalone data server.

To use an isolated directory for development, set `WORKSPACE_DATA_DIR` to an absolute path when starting the server. Do not use this override to point at another app’s data.

If another window edits the same item first, the stale window reloads the saved state and keeps the open draft. Review it and save again. Edits to different items can proceed independently. Captured text is cleared only after a successful save. Turning a Capture into a priority creates a new item, retains the original Capture, and records their relationship. The promotion keeps the same target and relation request across an uncertain retry, leaves the editor open when the link is incomplete, and surfaces link cleanup or restore failures instead of treating a partial result as complete. Local Workspace items use local calendar dates and wall-clock times; they do not create or modify provider records unless you explicitly choose a connected-service action.

## Recovery

If a process is killed during a save, `.write-lock` may remain in the data directory. The app checks its recorded PID and age and removes a lock only when the owning process is gone or the lock is safely stale. A live lock remains protected and returns a busy response. If manual recovery is ever needed, stop all Workspace server instances first, inspect the exact lock and PID, and make a dated copy of the data directory before changing anything. A leftover `workspace.<pid>.tmp` is ignored by reads and can be removed after the same process check.

If the main JSON file is damaged, the app refuses to overwrite it. Stop the server and copy the entire data directory to a dated backup. Inspect `workspace.backup.json` and, if it contains the desired previous state, copy it over `workspace.json` before restarting. This restores the previous save, so the latest change may need to be re-entered. Keep independent backups of `~/Data` for longer history.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

The storage tests use disposable temporary directories. They cover persistence, competing writers, revision conflicts, origin/host restrictions, validation, last-good backups, and corrupt-file preservation.

The page exposes optional WebMCP tools to read the selected day and open an unsaved item draft. A draft-start tool cannot overwrite an open editor or run during a save. Saving remains an explicit action in the editor.

## Todoist, Google Calendar, and Gmail sync

Open **Settings** in the desktop sidebar (or visit `http://127.0.0.1:5173/?connections=1`). All provider setup, connection status, and manual sync controls live there. These are connections owned by this local application; assistant connectors are not reused as application credentials.

### Scope

- Todoist: the project named **Personal**, plus its descendants. Artek and all descendants of an Artek project are excluded. The app never falls back to Inbox when Personal is missing. Task and calendar titles are not used to infer scope.
- Google Calendar: only **jordmburg@gmail.com**. Authorization must be through that Google account, with owner access to its primary calendar. Shared read access through the Artek account does not enable this integration.
- Gmail: only **jordmburg@gmail.com**. Recent Inbox messages are cached as bounded plain-text summaries. Messages with `Artek` anywhere in their Gmail label path, or a structured address header from the Artek domain or one of its subdomains, are excluded before they are saved or returned. This keeps obvious work mail out; forwarded content without those signals cannot be classified reliably.
- Each provider refreshes independently on opening a connected workspace, changing the selected day where relevant, and after its own writes. The local server also refreshes configured providers every five minutes while Workspace is running, with bounded retry delays after errors. One provider’s failure does not block the others. Manual per-provider sync and **Sync now** are available in Settings.
- Google fetches a rolling window around the selected date and expands recurring occurrences. Each provider replaces its cache only after every page succeeds; failures retain the last saved personal data. Removed or moved-out-of-scope Todoist projects are pruned when source metadata can be refreshed.

### Connect Todoist

1. Ensure **Personal** exists in the intended Todoist account. The workspace never creates or substitutes a project automatically.
2. Copy the account's personal API token from Todoist Settings → Integrations → Developer.
3. Paste it into the Todoist password field under **Settings → Planning and mail** and choose **Connect**. Do not put the token into chat, source files, or Git.

The backend verifies the project boundary before storing the token or mutating tasks. Imported tasks remain in Todoist. The dedicated **Tasks** view groups overdue, today, deadline, upcoming, and undated work. When Todoist supplies both a due date and a deadline, Workspace uses the earlier date for daily attention. Use **Add task** to create a synced task, click a task to edit its title or ordinary date, and use its completion circle to complete it in Todoist. Completing a recurring task advances its occurrence. Recurring and timed due dates are edited in Todoist to preserve their rules, time zones, and reminders. Task deletion requires a separate confirmation; Todoist may also delete completed subtasks. Tasks with active subtasks must be deleted directly in Todoist.

### Connect Google Calendar

Follow Google's [Node Calendar setup](https://developers.google.com/workspace/calendar/api/quickstart/nodejs): use a dedicated personal Google Cloud project, enable the Google Calendar API, and configure Google Auth Platform with audience **External**. While its publishing status is **Testing**, add `jordmburg@gmail.com` under **Audience → Test users**. Create an OAuth client of type **Desktop app** and download that client's JSON file.

**If Google shows `403: org_internal`:** the OAuth app is configured for an Internal organization audience, which cannot authorize a personal Gmail account. In the dedicated personal project's **Google Auth Platform → Audience**, change the user type to **External**, choose **Testing**, and add the Gmail test user, then start **Connect Google Calendar** again. If the existing client belongs to a shared Artek app, create a separate personal project and upload its Desktop client JSON here instead of changing the shared app's audience. See [Google's audience guidance](https://support.google.com/cloud/answer/15549945).

Choose the JSON file under **Settings → Planning and mail**, then **Connect Google Calendar**. The app opens Google's authorization page in the Mac's default browser. Sign in as `jordmburg@gmail.com`. The loopback callback returns to Settings. The local server must keep running during authorization.

Requested scopes are `calendar.calendarlist.readonly` and `calendar.events.owned`. The backend enforces the one allowed calendar even though Google's scope can cover other owned calendars. OAuth uses a short-lived one-use state and PKCE verifier, checks granted scopes and calendar ownership, and refreshes access tokens server-side. An External Google OAuth app left in Testing usually requires reconnection after seven days; see [Google's token expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration).

Use **Add event** for personal solo events. Click an imported event to edit its title, dates, or times. An edit to a recurring occurrence affects only that occurrence, never its parent series. Guest meetings, series masters, and special/locked events link to Google Calendar for editing. The app does not create guests or send invitation messages. Unchanged event time boundaries are preserved on title-only edits, and Google ETags protect updates/deletes against concurrent edits.

### Connect Gmail

Enable the **Gmail API** in the same dedicated personal Google Cloud project used for Calendar. The Desktop OAuth client file already saved in Workspace is reused, while Gmail receives its own optional authorization and token. Under **Settings → Planning and mail**, choose **Connect Gmail**, keep the local Workspace running, and authorize `jordmburg@gmail.com` in the browser.

Gmail requests only `gmail.modify`, which Google documents for reading, composing, sending, and ordinary mailbox changes. It does not allow immediate permanent deletion. Workspace exposes a narrower set of actions: mark read or unread, star or unstar, archive, move to Gmail Trash, compose, and reply. See [Google's Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes), [send method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), and [Trash method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/trash).

Sending always begins as an editable Workspace draft and requires an explicit **Send** action. A reply keeps Gmail's original recipient, subject, and thread metadata. If Gmail may have accepted a send but the response is lost, Workspace refuses to send that request again and asks you to check Sent before starting a fresh draft. Mail deletion means moving one message to Gmail Trash; Workspace has no permanent-delete or bulk-delete route. HTML bodies, remote images, tracking pixels, and attachments are not fetched or rendered. Use **Open in Gmail** for the complete conversation and attachments.

Google classifies `gmail.modify` as a restricted scope. A personal-use app can qualify for Google's verification exception, although an External project left in Testing still normally issues refresh tokens that expire after seven days. Move the OAuth project to Production when you want durable personal sync, and keep its user type External.

### Sync storage and conflicts

Connection credentials, tokens, mutation receipts, cross-area links, and the imported cache are stored in `~/Data/personal-workspace/integrations.private.json`, with owner-only file permissions, outside the repository. The browser receives a sanitized connection view, never the saved tokens or OAuth client secret. **Disconnect** forgets the local connection and its cache; it does not revoke the provider's grant or change source records. Provider grants can be revoked in the provider's account settings.

Local priorities, captures, and plans continue to use `workspace.json` and stay local. They are not silently uploaded or merged into provider records. A small typed relationship index records explicit links such as Capture → priority, climbing goal → Todoist task, climbing plan → Calendar event, and Gmail message → follow-up task or time block. The source app continues to own each provider record.

Todoist commands use stable UUIDs for idempotency and source/version preflight checks. Todoist does not document atomic compare-and-swap for these task edits, so a narrow race between its preflight read and write remains possible. Google uses conditional `If-Match` writes. Each provider mutation holds its own cross-process lock, so a delayed Calendar request does not block Todoist or Gmail. The shared integration-file lock is held only while taking a snapshot or committing a revision-aware three-way merge; saves use unique atomic temporary files. This prevents concurrent Workspace processes from losing receipts, cached provider changes, or links. When a conflict is reported, retain/copy the draft as needed, close the editor, sync, and review the latest version before editing again. A request ID is bound to one payload; changing a previously attempted draft requires a new edit. If an `integrations.private.json*.lock` file remains after a stopped process, use the stopped-process/PID verification procedure in **Recovery** before removing that exact lock.

Integration tests use simulated provider responses and isolated temporary data, including OAuth/PKCE, refresh, pagination, scope enforcement, recurring completion, stale revisions, preserved event boundaries, Gmail filtering and actions, cross-process locking, linked-item repair, and cached-data retention. No real Todoist, Calendar, or Gmail records are mutated by tests. A live credential-based round trip remains necessary after connecting your accounts.

## Finances

Open **Settings → Banking**. Create or use your own [Plaid developer account](https://dashboard.plaid.com/signup), enable Transactions, and obtain Production access (including an eligible Trial plan). Enter the client ID and the secret for the selected environment in the local app. Sandbox is labeled and contains sample data only. No bank accounts are connected until you complete Plaid Link yourself.

Plaid's published [US coverage](https://plaid.com/documents/us_institution_coverage.csv) lists Capital One, Bank of America, and Rivermark Community Credit Union for Transactions and Balance. Live Link availability depends on the login/account. Eligible Trial accounts have a **10 lifetime Item** limit, including deleted connections; check the current plan in the Plaid dashboard. Use a normal Chrome/Safari window for bank OAuth popups; this local integration intentionally omits a Production redirect URI.

Choose your **personal accounts** after linking. No accounts are selected automatically. Work-named and business accounts cannot be selected. Only selected checking, savings, and credit-card accounts are queried through separate `/transactions/sync` account streams. Transactions and their cursors are committed after complete pagination; interrupted cycles retain the previous cache. One active selected connection per institution prevents accidentally counting a second Link session twice. Use **Repair connection** for renewed bank consent.

Balances are cached, may be null, and are kept in their supplied currency. Credit balances represent amounts owed. Month spending uses posted purchases less refunds, excluding pending items, transfers, income, loan payments, loan disbursements, and any item you explicitly exclude. It is a summary of imported data, not a comprehensive budget or real-time available balance. Personal category labels and transaction notes are editable **locally**, with conflict checks, and survive imported updates. Bank records are not modified. No payment or transfer APIs are implemented. Pending-to-posted transactions carry local notes across their provider ID change.

The finance page checks for updates hourly while open; manual sync is under **Settings → Banking**. Plaid generally receives bank updates a few times daily. The app does not force paid real-time balance or transaction refreshes. **Disconnect bank** revokes the Plaid Item before removing its local records; if revocation fails, the connection is retained so you can retry.

Credentials, selected account data, transactions, cursors, and notes live in `~/Data/personal-workspace/finance.private.json` with owner-only permissions. Provider credentials and access tokens are never included in the browser's status response.

## Workspace for iPhone

Open **Settings → iPhone and Apple Health**. The native project and installation guide are in [`companion/README.md`](companion/README.md). The iPhone app is a focused companion with five tabs: **Today**, **Capture**, **Tasks**, **Climbing**, and **Lesson**. Settings opens from the gear button. The Mac remains the source of truth: provider credentials, Plaid Link, and Google/Todoist connection setup stay on the Mac, while the paired phone reads the sanitized views and sends revision-checked edits through the same local services.

The app connects only while the Mac Workspace is running on the same private Wi-Fi. Its dedicated HTTPS listener uses a certificate pinned during pairing and a bearer token stored in the iPhone Keychain. The desktop web server, provider credentials, and private data files remain loopback-only. A new Workspace companion pairing explicitly grants the focused allowlist for planning, capture, Todoist, Calendar, Climbing, the current Chess lesson, and Health. Existing Health-only tokens continue to sync Health but cannot read the other companion areas. Download a new pairing file after installing the companion app.

The companion supports a daily overview with a compact Health summary, quick capture to Workspace Captures, the selected Todoist Personal task list, Climbing records, and the current in-progress Chess lesson. It is designed to spend most of the day disconnected: protected planning, task, climbing, and lesson snapshots open normally without a connection warning on every tab. Today shows one quiet planning-freshness line, while pairing, exact sync status, last Mac contact, manual sync, Apple Health permissions and history import, pending Health write approvals, and climbing links live in iPhone Settings. Mail, Finance, Writing, the full Chess catalog and review queue, detailed Health and Sleep analysis, and a standalone Health view remain on the Mac.

This Mac app cannot access HealthKit directly; Workspace for iPhone uses HealthKit with your selected permissions.

The companion sends a complete **30-day snapshot** of daily steps, calendar-day asleep time, latest daily resting heart rate and body mass, and workouts. Missing values mean no accessible data, which can include denied permission; they are not converted to zero. Sleep intervals are merged before totaling, and steps use HealthKit statistics instead of summing raw phone/watch records. Each new complete snapshot replaces the preceding one, including records you have deleted in Apple Health.

**Log weight** creates a pending request only. Open the companion Settings from the gear button, sync, review the exact measurement and time, and confirm it there. Successful HealthKit saves use stable sync identifiers/version metadata, payload hashes, and local Keychain receipts to prevent duplicate writes after uncertain retries. The Mac marks an entry saved only after receiving its matching receipt. Other providers' Health records are never edited or deleted by this app. Workouts are currently imported, not created.

Phone sync is **disabled by default**. Enabling it starts a separate HTTPS listener on the selected private Wi-Fi IP, normally port 5174. It exposes only an allowlist of versioned phone operations after a Workspace companion pairing; Mail, Finance, Writing, and Chess-review mutation routes are absent, and integration responses omit Gmail state and message summaries. The browser application and ordinary data APIs remain on loopback. No firewall, privacy, or device settings are changed automatically. Pairing files expire after 10 minutes, work once, and contain a temporary credential; delete the transferred file after pairing. A new successful pairing revokes the previous device token. Disabling sync also revokes pairing immediately.

The iPhone client permits only HTTPS on private IPv4 addresses, validates the paired certificate fingerprint, trusts that certificate only for its session, checks its SAN/expiry, and refuses redirects. App Transport Security has no insecure HTTP exceptions; the connection requires TLS 1.2 or later. Device credentials/receipts use non-synchronizing, unlocked-device-only Keychain storage. No iCloud or hosted Workspace transport is used. The Mac certificate is valid for one year; disable/re-enable and re-pair to renew it or change the Wi-Fi IP.

The Mac must be awake with Workspace running, and the iPhone must be unlocked on the same private Wi-Fi. Sync runs on demand and makes one short attempt when the companion opens; expected offline failures remain quiet and automatic retries back off. A USB cable does not currently carry Workspace app data. Snapshots, pending entries, receipts, and token hashes are stored in `~/Data/personal-workspace/health.private.json`; the local TLS key/certificate are alongside it with owner-only permissions. Reopening Workspace resumes a previously enabled listener. Disabling pairing retains the saved snapshot and entry history.

### Sleep workspace

On the Mac, **Health → Sleep** preserves source-labelled HealthKit stages and supports a nightly timeline, 7/30/90-day trends, same-source baseline medians, personal fragmentation thresholds, consecutive runs, timing variability, daily physiological/activity context, clock-hour awake distribution, and local diary notes. The browser loads a compact summary for the selected range and fetches one night’s detailed intervals on demand; conditional requests avoid resending unchanged data. Diary notes and comparison settings live in a small sidecar, so editing them does not rewrite the raw Sleep archive. The iPhone presents only a compact daily Health summary in Today. The inspiration transcript is not imported as measurements or used to establish diagnoses.

Install/run the updated app, then open **Settings** from the gear button to review Health permissions and choose **Sync Apple Health** for recent sleep. **Import older sleep history** sends older records in complete 30-day batches from a chosen date (default January 2020); keep the app open and the Mac awake. Stop import keeps completed ranges. A retry starts at the selected date and safely replaces those ranges. An existing Health-only pairing stays valid for these Health operations; pair again to use the companion’s other areas.

The separate `~/Data/personal-workspace/sleep.private.json` archive retains raw UUIDs, source bundle/device model, source version and timezone metadata when present, daily context, observed coverage ranges, comparison settings, and diary revisions. Regular sync refreshes 30 days and retains older history. Each queried range replaces currently accessible records, including corrections, deletions, or changes in read visibility. HealthKit does not distinguish denied read permission from no data. Review permissions before reimporting; missing data stays missing. Diary notes and comparison settings are preserved by health refreshes. Nothing is sent to a cloud or written back into Health by the sleep feature.

Nights use one selected source, chosen once initially and then kept through backfill. The longest inferred session ending on a date is the main night; other sessions are reported separately. Intervals up to three hours apart are grouped; overlapping conflicting spans longer than 20 hours are excluded. Elapsed durations handle DST. Clock displays and daily context use the explicit Gregorian reporting timezone. Original sample timezone is retained, but travel-era clock times are displayed in the reporting zone, not reconstructed in each original local zone.

Gaps and conflicting stages remain unknown. Records near a coverage boundary (including an unfinished current night) are marked partial. More than 5% unknown time or partial boundaries exclude a night from duration/awake medians and short-sleep classification. Recorded awake time can still flag a known lower-bound excess. Sleep share is asleep divided by the first-to-last recorded sleep span, not clinical time-in-bed efficiency. Medians require seven qualifying nights per comparison window. Missing dates interrupt consecutive runs. Wearable readings and context differences are descriptive, not diagnostic or causal findings.

The baseline for a selected trend window is its preceding 28 calendar days, with per-metric sample counts. Context compares the prior calendar day with its own preceding 28 days. Context summaries are daily means for resting HR, HRV (SDNN), respiration and oxygen; daily totals for steps, active energy and exercise. They can combine HealthKit sources and are not restricted to overnight samples. Diary text survives in-app navigation until saved/discarded, warns on leaving the page, and uses revision conflicts to protect edits in other windows. Sleep comparison settings also use revision checks.

### Finance and health save recovery

Finance and health mutations use cross-process locks (`finance.private.json.lock`, `health.private.json.lock`) and unique atomic temporary files. If a process stops during a save, a lock may remain. Stop all Workspace processes, read only the PID in the relevant `.lock` file, and verify that process is no longer running before removing that exact lock. Never delete the private JSON data file as a lock fix. Preserve a private backup before manual data recovery; do not paste its contents into chat or commit it to Git.

## Climbing

The **Climbing** section has three connected views: sessions, goals, and routines. A session can be a short date/place/type note or a detailed log with duration, effort, readiness, individual climbs, and a completed training routine. Individual climbs keep the original discipline, rope style, grading system, grade label, outcome, attempt count, and notes. The app does not convert grades, average them, or compare labels from different systems and venues.

Consistency goals count non-removed sessions inside an explicit inclusive date range. A climb project records the route or problem name, gym or outdoor setting, boulder or route discipline, optional rope style, original grade label, location, cumulative attempts, send target, notes, next action, and beta references. Its card uses projecting, paused, or sent status instead of an arbitrary percentage. Skill, training, and custom goals retain user-entered progress and next-action notes. Routines contain ordered, user-authored workload steps. **Use routine** opens a session with a versioned snapshot of the purpose, planned duration, and steps; steps begin unmarked until the user records them as done, modified, or skipped. Session duration remains blank until actual time is entered. Later routine edits do not rewrite earlier sessions.

### Plan → do → reflect

1. **Plan:** Start from a climbing goal and optionally choose a routine. The climbing log owns the goal, plan, and versioned routine snapshot. A plan stays local until **Add to Google Calendar** is chosen. After that explicit link is created, Google Calendar owns the event schedule; edit its date and time through the linked Calendar event. The climbing plan continues to own its goal, venue/focus intent, and routine snapshot.
2. **Do:** Logging the planned outing creates one climbing session linked back to that plan. The session receives the plan's routine snapshot so the planned workload remains visible while each step is marked done, modified, or skipped. A Calendar event alone never counts as a completed session or advances a goal.
3. **Reflect:** The climbing session owns what actually happened: duration, effort, readiness, climbs, outcomes, routine results, and notes. An accessible Apple Health workout can be linked explicitly to one session as read-only context. Workspace does not infer sessions from workouts, copy Health values into the climbing log, edit Apple Health workouts, or create new workouts.

A climbing goal can explicitly create a linked next-action task in Todoist's Personal project. Todoist then owns whether that task is active or completed and its due state; the Workspace goal continues to own its progress, status, and next-step text. If a linked task is absent from the latest Todoist cache, the app treats that as ambiguous because it may have been completed, deleted, moved outside Personal, or temporarily unavailable. It does not complete the goal or recreate the task automatically.

Climbing data lives in `~/Data/personal-workspace/climbing.private.json` with owner-only permissions. Record-level commands validate the complete resulting log, serialize cross-process writes, atomically replace the file, and reject stale edits only for the affected plan, session, goal, or routine. Stable request IDs make command retries idempotent. A stale window reloads the saved records while leaving its open editor intact. Removing a session writes a restorable tombstone so older windows cannot bring it back accidentally and so goal and summary calculations can exclude it. Goals and routines are archived and can be restored.

Saved climbing goals can keep up to 12 beta references: HTTPS links or uploaded JPEG, PNG, WebP, HEIC, HEIF, MP4, and QuickTime files up to 200 MB each. Uploads are capped at 1 GB per goal and 5 GB across Climbing, and Workspace keeps a 250 MB free-space reserve. Uploaded files stay private in `~/Data/personal-workspace/climbing-media`, are verified from their contents, and stream with byte-range support for video playback. The companion transfers and opens them through its authenticated, certificate-pinned connection to the Mac; this feature does not upload media to a cloud service. Goal references are stored separately from editable goal records so an older client cannot erase them during a normal goal save.

If `climbing.private.json.lock` remains after a stopped process, use the stopped-process/PID verification steps above before removing that exact lock. A corrupt climbing file is left untouched and is never replaced with an empty log.

## Writing for the personal site

**Writing → New entry** opens an editor for a note, idea, or work entry. Workspace reads the sibling `personal-site` repository and its existing archive entries. Save drafts here while developing the title, summary, Markdown body, topics, and thread connections. Drafts are stored in `~/Data/personal-workspace/writing.private.json`, with owner-only permissions, outside either repository. Saves use revision checks; unsaved editor text remains open while navigating to another Workspace section and prompts before a page unload.

After saving, **Add draft to site** creates one new file in `personal-site/src/content/entries/`. It always writes `draft: true`, so the entry appears in Astro development and is excluded from production. This is a handoff: continue editing the new file in the site project. Workspace retains its saved copy and receipt, but does not overwrite or delete site entries. It does not commit, push, publish, or run deployment commands.

The exporter checks the current archive for unique order and filename, known related entries, thread membership, reserved identifiers, and raw HTML. It parses Markdown so code examples and autolinks remain valid. Frontmatter is serialized with YAML; the timeframe remains a string. Symlinked content directories/files are refused. Repository-level export locking coordinates multiple Workspace instances, and exclusive atomic file creation prevents replacement of an existing entry. Manual edits in the site do not participate in Workspace’s locks; run the site’s normal `npm run verify` after handoff and review in `npm run dev` before publishing.

If an export was interrupted, **Recover saved draft** recognizes an already-created file by its exact content hash. Otherwise it releases the unfinished handoff so you can choose another address and retry, preserving any independently created file. An interrupted process can leave `writing.private.json.lock` or `personal-site/.workspace-writing.lock`. Follow the same stopped-process/PID verification procedure described above before removing an exact stale lock. Do not delete the saved drafts or an entry file to clear a lock.

Verification uses disposable repository fixtures for export, collisions, stale saves, Markdown, and recovery. A generated draft was also checked in an isolated copy of the actual personal site using its own `npm run verify`; the real site’s entries remain untouched.

## Chess practice

Chess brings the useful learning loop from the sibling `chess-desk` project into the personal Workspace through two focused repertoire courses. **Scotch Game** comes first and studies White’s immediate central break through the Schmidt and Classical branches; **Sicilian Defense** follows with Black’s Accelerated Dragon setup and thematic ...d5 break. Each course has a seven-position authored-move trainer, move-and-explanation reviews, progress, and recent study history. The daily overview stays compact and shows reviews due, the next review time, and lesson steps covered. The full course catalog and board live in **Chess**.

Lesson progress and reviews use `~/Data/personal-workspace/chess.private.json`. The service validates lesson, segment, step, move, and explanation identifiers against the bundled catalog. Revision checks protect concurrent edits, stable request IDs make retries idempotent, and private atomic writes keep the previous saved file intact when a request fails. A revealed lesson answer counts as a step covered; review accuracy is calculated only from submitted move-and-explanation attempts. If `chess.private.json.lock` remains after a stopped process, follow the stopped-process/PID verification procedure in **Recovery** before removing that exact lock.

**Block 20 minutes** and **Add review task** open reviewed drafts for the personal Google Calendar and Todoist Personal project. They do not create provider items automatically. Chess events and tasks are recognized by their `Chess ·` title for the daily context; durable provider links can be added if Chess later needs to own or reconcile those remote records.

The iPhone companion reads and writes the same Chess state through its pinned, scope-limited Mac bridge. Its **Lesson** tab opens only the current in-progress lesson, with the interactive tap-to-move board, hints, reveal, and saved progress. The course catalog, summaries, review queue, and review scheduling remain on the Mac, which must be running on the same private Wi-Fi.

The standalone Chess Desk Supabase account and its existing rows are not imported automatically, and Workspace does not copy its auth credentials. Stockfish is intentionally omitted because the authored lessons and review flow do not use engine analysis. Chess.com game and rating import remain separate from this integrated practice slice.
