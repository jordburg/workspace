# Workspace for iPhone

Workspace for iPhone is a focused native companion to the personal Workspace on your Mac. It keeps the parts that are useful while away from the desk: the day ahead, quick capture, personal Todoist tasks, Climbing, the current Chess lesson, and a compact Apple Health summary. The phone is designed to spend most of its time away from the Mac, using a protected local snapshot between deliberate sync sessions. The Mac remains the source of truth and no Workspace cloud service is involved.

## What is available on iPhone

- **Today** combines local priorities and plans with the selected personal Google Calendar. It also shows a compact Apple Health summary for the day.
- **Capture** provides the same quick “A place to put it” entry point as the desktop overview, saving a capture to Workspace Captures for later review.
- **Tasks** shows active tasks from the selected Todoist Personal project and supports the task actions intended for use on the go.
- **Climbing** manages sessions, plans, goals, and versioned training routines. Climb projects use route-specific fields for setting, discipline, optional rope style, grade, location, attempts, target, and send status. A saved goal can keep up to 12 private beta photos, videos, and HTTPS links; individual uploads are limited to 200 MB, with the Mac enforcing the shared storage quotas. Plans can be linked to reviewed Calendar events, goal actions can be linked to reviewed Todoist tasks, and sessions can reference an Apple Health workout without changing it.
- **Lesson** opens the current in-progress Chess lesson from the desktop Workspace. Its tap-to-move board, hints, authored explanations, and progress updates use the same private Chess record as the Mac.

Open **Settings** from the gear button. It is the single place on iPhone for Mac pairing, manual sync, connection status, Apple Health permissions and history import, pending Health write approvals, and climbing links.

Mail, Finance, Writing, the full Chess catalog and review queue, detailed Health and Sleep analysis, and a standalone Health dashboard remain in Workspace on the Mac. Plaid credentials and bank connections, Google OAuth, Todoist token setup, personal account/source selection, and site export and recovery also remain Mac actions. The phone never receives provider credentials.

## Install

1. Open `WorkspaceHealth.xcodeproj` in Xcode.
2. If Xcode requests it, install the iOS platform component under **Xcode → Settings → Components**.
3. Select the **WorkspaceHealth** target, open **Signing & Capabilities**, and choose your personal Apple development team. HealthKit is already enabled. If `com.jordburg.workspace.health` is unavailable to your team, choose a unique personal bundle identifier.
4. Connect and unlock the iPhone, select it as the run destination, then build and run. Follow Apple's prompts for trust and Developer Mode when shown.

The project targets iOS 17 or later and has no third-party app dependencies. A free Personal Team is sufficient for this prototype, although its provisioning normally expires after seven days. HealthKit data and Local Network permission require a physical iPhone; the Simulator cannot verify them.

## Pair with the Mac

1. Start the desktop Workspace and leave the Mac awake. Connect both devices to the same private Wi-Fi.
2. On the Mac, open **Settings → iPhone and Apple Health**, enable the iPhone connection for the current Wi-Fi address, and download a new Workspace pairing file.
3. AirDrop the JSON file to the iPhone. Open **Settings** from the gear button and choose the file. It expires after ten minutes and can be used once. Delete the transferred file after pairing.
4. Return to Today. The app can reach the Mac only while Workspace is running on the same network; manual refresh remains in Settings.

Version 2 pairing explicitly grants this iPhone access to the focused companion allowlist for daily planning, capture, Todoist, Calendar, Climbing, the current Chess lesson, and Health. Pairing replaces the previous phone token. An older version 1 Health pairing remains valid for Health sync only and cannot read the Workspace, Climbing, Chess, Calendar, or Todoist data; download and import a new file to use those areas.

If the connection fails, check that the Mac is awake, Workspace is running, the saved Wi-Fi IP is still current, and the network does not isolate devices. A changed IP, renewed certificate, expired certificate, revoked token, or disabled iPhone connection requires a new pairing.

## Apple Health

Open **Settings** from the gear button, choose **Review Health permissions**, and allow only the categories you want to share. **Sync Apple Health** sends the current 30-day snapshot plus recent sleep stages and daily context directly to the Mac. **Import older sleep history** processes the chosen range in complete 30-day batches while the app stays open; stopping keeps completed batches, and retrying is safe. The latest daily values appear as a summary in Today rather than in a separate Health tab.

Workspace cannot determine whether an empty HealthKit read means no records or denied read permission, so missing values remain missing. Review permissions before retrying an empty import. No workout, calorie, medication, diagnosis, or measurement is inferred from a plan or climbing session.

Workout grouping uses the workout start day in its saved HealthKit timezone, with the snapshot timezone as a fallback. An overnight workout therefore belongs to its start day. Metadata-free workouts can shift calendar day when old data is synced while traveling, and HealthKit queries still use the snapshot calendar boundaries, so an item very near an import boundary may appear in the next sync.

**Log weight** on the Mac creates a pending request. Review pending Health writes in iPhone Settings; the app shows the exact value and measurement time and saves it only after **Save to Apple Health** is selected. Stable HealthKit identifiers, payload hashes, and local receipts prevent duplicate writes after an uncertain network response. Body mass is the only supported Health write.

## Connection security

The desktop web server and ordinary data APIs stay on loopback. Enabling iPhone sync starts a separate HTTPS listener on the selected private IPv4 address, normally port 5174. That listener exposes an exact set of versioned phone routes and requires the scope-bearing bearer token created during one-use pairing. It has no Mail, Finance, Writing, or Chess-review mutation routes. Integration responses sent through it omit Gmail state and message summaries.

The pairing file pins the Mac certificate fingerprint. The iPhone accepts only HTTPS on a private IPv4 address, validates that certificate for the paired host, requires TLS 1.2 or later, refuses redirects, disables cookies and cellular access, and stores the token and Health receipts in non-synchronizing, unlocked-device-only Keychain storage. App Transport Security has no insecure HTTP exception. Provider credentials and private data files are never returned to the phone.

## Current operating limits

The app keeps a protected, versioned last-good snapshot of daily planning, Todoist tasks, Climbing, and the current Chess lesson. Those areas open directly from saved data while the Mac is away; ordinary disconnection is not presented as a warning on every page. Today carries one quiet freshness line, while Settings holds the exact connection state, last Mac contact, pending Capture count, and manual sync action. A prominent message is reserved for first-time setup, missing initial data, revoked access, conflicts, and other conditions that require action.

After Workspace pairing, Capture is the offline write path: its draft and queued entries persist across launches and flush with stable request IDs when the paired Mac becomes reachable. Capture state is bound to the pairing certificate fingerprint. Re-pairing retains captures only when the certificate still identifies the same Mac. Unpairing, a pairing for a different certificate, or a stored identity mismatch clears them, so an entry queued for one Mac is never delivered to another.

Workspace item saves, completion toggles, and deletes use record-level commands with per-item revisions. Climbing session, plan, goal, and routine saves use record-level commands with each record's last-update value; saving a session and marking its linked plan logged is one command. Retry-stable request IDs prevent an uncertain response from duplicating a change, while record conflicts keep the attempted edit available for review. Other offline edits are not queued and still require the paired Mac to accept the save.

Workspace makes one short connection attempt when the app launches. While the Mac is away, automatic retries back off for fifteen minutes and expected reachability failures stay quiet; returning to the app never replaces a usable snapshot with a connection warning. Calendar and Todoist do not start extra refresh attempts while the Mac is already known to be unavailable. **Settings** provides the deliberate sync action.

There is no background Mac service, cloud relay, iCloud transport, remote-network access, or USB data transport. The Mac app must be running and both devices must be on the same private Wi-Fi for network reads and writes. A cable can be part of the daily routine and keep the iPhone powered, but plugging it in alone does not currently transfer Workspace data.

The app has been signed, installed, and launched on Jordan’s iPhone. Health and Local Network permissions, certificate validation across network changes, and real HealthKit/provider round trips remain dependent on the connected device and services.
