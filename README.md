# Personal workspace

A local daily overview for Jordan’s personal life and independent professional work. Start with a few priorities, add timed plans, and capture ideas in the inbox. Items can be edited, completed, moved to another day, or removed with an undo action. Personal and Independent work are separate filters; no Artek connections are configured.

## Run locally

Requires Node.js 22.13 or newer and npm. Dependencies are locked in `package-lock.json`.

```sh
npm ci
npm start
```

Open http://127.0.0.1:5173. `npm start` and `npm run dev` both run the local application. Stop with Ctrl-C. The server binds only to loopback and refuses to silently choose another port.

## Storage

Records live in `~/Data/personal-workspace/workspace.json`, outside this source tree. Saves validate the full document, serialize writes, check a revision number, flush a temporary file, and atomically replace the main file. `workspace.backup.json` keeps the previous saved version. This is a local app with optional Todoist and Google Calendar connections described below. It has no remote deployment or workspace sign-in. The API is provided by the Vite middleware in `build/local-workspace.ts`; the build output alone is not a standalone data server.

To use an isolated directory for development, set `WORKSPACE_DATA_DIR` to an absolute path when starting the server. Do not use this override to point at another app’s data.

If another window saves first, the stale window reloads the saved state and keeps the open draft. Review it and save again. Captured text is cleared only after a successful save. Dates and times are local calendar days and wall-clock times; there is no calendar or time-zone synchronization.

## Recovery

If a process is killed during a save, `.write-lock` may remain in the data directory. Stop all workspace server instances first. Read the PID recorded in that file and confirm that it is no longer running. Remove only that `.write-lock` file, then restart the app. Do not remove a lock while a writer is active. A leftover `workspace.<pid>.tmp` can be removed after the same check; the app reads only `workspace.json`.

If the main JSON file is damaged, the app refuses to overwrite it. Stop the server and copy the entire data directory to a dated backup. Inspect `workspace.backup.json` and, if it contains the desired previous state, copy it over `workspace.json` before restarting. This restores the previous save, so the latest change may need to be re-entered. Keep independent backups of `~/Data` for longer history.

## Checks

```sh
npm test
npm run typecheck
npm run build
```

The storage tests use disposable temporary directories. They cover persistence, competing writers, revision conflicts, origin/host restrictions, validation, last-good backups, and corrupt-file preservation.

The page exposes optional WebMCP tools to read the selected day and open an unsaved item draft. A draft-start tool cannot overwrite an open editor or run during a save. Saving remains an explicit action in the editor.

## Todoist and Google Calendar sync

Open **Connect your apps** in the daily overview (or visit `http://127.0.0.1:5173/?connections=1`). These are connections owned by this local application; assistant connectors are not reused as application credentials.

### Scope

- Todoist: the project named **Personal**, plus its descendants. Artek and all descendants of an Artek project are excluded. The app never falls back to Inbox when Personal is missing. Task and calendar titles are not used to infer scope.
- Google Calendar: only **jordmburg@gmail.com**. Authorization must be through that Google account, with owner access to its primary calendar. Shared read access through the Artek account does not enable this integration.
- The app refreshes on opening a connected workspace, changing the selected day, after a write, and every five minutes while the page is visible. It is not a background service when the app is closed. Manual **Sync now** is also available.
- Google fetches a rolling window around the selected date and expands recurring occurrences. Each provider replaces its cache only after every page succeeds; failures retain the last saved personal data. Removed or moved-out-of-scope Todoist projects are pruned when source metadata can be refreshed.

### Connect Todoist

1. Ensure **Personal** exists in the intended Todoist account. The workspace never creates or substitutes a project automatically.
2. Copy the account's personal API token from Todoist Settings → Integrations → Developer.
3. Paste it into the password field in the local app's Connections screen and choose **Connect**. Do not put the token into chat, source files, or Git.

The backend verifies the project boundary before storing the token or mutating tasks. Imported tasks remain in Todoist. Use **Add task** to create a synced task, click a task to edit its title or ordinary date, and use its completion circle to complete it in Todoist. Completing a recurring task advances its occurrence. Recurring and timed due dates are edited in Todoist to preserve their rules, time zones, and reminders. Task deletion requires a separate confirmation; Todoist may also delete completed subtasks. Tasks with active subtasks must be deleted directly in Todoist.

### Connect Google Calendar

Follow Google's [Node Calendar setup](https://developers.google.com/workspace/calendar/api/quickstart/nodejs): use a dedicated personal Google Cloud project, enable the Google Calendar API, and configure Google Auth Platform with audience **External**. While its publishing status is **Testing**, add `jordmburg@gmail.com` under **Audience → Test users**. Create an OAuth client of type **Desktop app** and download that client's JSON file.

**If Google shows `403: org_internal`:** the OAuth app is configured for an Internal organization audience, which cannot authorize a personal Gmail account. In the dedicated personal project's **Google Auth Platform → Audience**, change the user type to **External**, choose **Testing**, and add the Gmail test user, then start **Connect Google Calendar** again. If the existing client belongs to a shared Artek app, create a separate personal project and upload its Desktop client JSON here instead of changing the shared app's audience. See [Google's audience guidance](https://support.google.com/cloud/answer/15549945).

Choose the JSON file in Connections, then **Connect Google Calendar**. The app opens Google's authorization page in the Mac's default browser. Sign in as `jordmburg@gmail.com`. The loopback callback returns to this app. The local server must keep running during authorization.

Requested scopes are `calendar.calendarlist.readonly` and `calendar.events.owned`. The backend enforces the one allowed calendar even though Google's scope can cover other owned calendars. OAuth uses a short-lived one-use state and PKCE verifier, checks granted scopes and calendar ownership, and refreshes access tokens server-side. An External Google OAuth app left in Testing usually requires reconnection after seven days; see [Google's token expiration documentation](https://developers.google.com/identity/protocols/oauth2#expiration).

Use **Add event** for personal solo events. Click an imported event to edit its title, dates, or times. An edit to a recurring occurrence affects only that occurrence, never its parent series. Guest meetings, series masters, and special/locked events link to Google Calendar for editing. The app does not create guests or send invitation messages. Unchanged event time boundaries are preserved on title-only edits, and Google ETags protect updates/deletes against concurrent edits.

### Sync storage and conflicts

Connection credentials, tokens, mutation receipts, and the imported cache are stored in `~/Data/personal-workspace/integrations.private.json`, with owner-only file permissions, outside the repository. The browser receives a sanitized connection view, never the saved tokens or OAuth client secret. **Disconnect** forgets the local connection and its cache; it does not revoke the provider's grant or change source records. Provider grants can be revoked in the provider's account settings.

Local priorities, notes, and plans continue to use `workspace.json` and stay local. They are not silently uploaded or merged into provider records.

Todoist commands use stable UUIDs for idempotency and source/version preflight checks. Todoist does not document atomic compare-and-swap for these task edits, so a narrow race between its preflight read and write remains possible. Google uses conditional `If-Match` writes. When a conflict is reported, retain/copy the draft as needed, close the editor, sync, and review the latest version before editing again. A request ID is bound to one payload; changing a previously attempted draft requires a new edit.

Integration tests use simulated provider responses and isolated temporary data, including OAuth/PKCE, refresh, pagination, scope enforcement, recurring completion, stale revisions, preserved event boundaries, and cached-data retention. No real Todoist or Calendar records are mutated by tests. A live credential-based round trip remains necessary after connecting your accounts.
