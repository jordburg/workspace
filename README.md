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

Records live in `~/Data/personal-workspace/workspace.json`, outside this source tree. Saves validate the full document, serialize writes, check a revision number, flush a temporary file, and atomically replace the main file. `workspace.backup.json` keeps the previous saved version. This is a local app: it has no sign-in, cloud sync, calendar connections, or remote deployment. The API is provided by the Vite middleware in `build/local-workspace.ts`; the build output alone is not a standalone data server.

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
