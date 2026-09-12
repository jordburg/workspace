# Workspace for iPhone

Workspace for iPhone is the native companion to the personal Workspace on your Mac. It presents the same daily planning, Climbing, Chess, Health, Finance, Writing, Google Calendar, Gmail, and Todoist data through a direct local connection. The Mac remains the source of truth and no Workspace cloud service is involved.

## What is available on iPhone

- **Today** combines local priorities and plans with the selected personal Google Calendar and Todoist project. You can add or edit local items, review provider changes, and complete Todoist tasks.
- **Inbox** captures thoughts, turns them into priorities, and shows unscheduled Personal tasks from Todoist.
- **Climbing** manages sessions, plans, goals, and versioned training routines. Plans can be linked to reviewed Calendar events, goal actions can be linked to reviewed Todoist tasks, and sessions can reference an Apple Health workout without changing it.
- **Chess** shows the bundled Sicilian/Najdorf course, lesson progress, due reviews, and recent accuracy. Lessons and reviews use a tap-to-move board with move validation, hints, authored explanations, and safe progress sync to the same private record as the Mac.
- **Health** reads the Apple Health categories you allow, syncs recent summaries and detailed sleep data, imports older sleep history in batches, and asks for confirmation before saving a requested weight entry.
- **More** includes Mail for reviewing the bounded personal Gmail inbox, marking messages read, starring or archiving them, moving a message to Gmail Trash after confirmation, and composing or replying after an explicit Send action. It also shows Finance balances and transactions, edits local finance annotations, saves Writing drafts, shows provider status and climbing links, and manages pairing and sync.

Plaid credentials and bank connection changes, Google OAuth, Todoist token setup, personal account/source selection, site export and recovery, and detailed sleep analysis remain in Workspace on the Mac. Bank transactions and Apple Health workouts are read-only. Gmail actions pass through the paired Mac; the phone never receives provider credentials, and it has no permanent-delete or bulk-mail route. Writing on iPhone saves a Workspace draft; publishing to the site remains a separate, reviewable Mac action.

## Install

1. Open `WorkspaceHealth.xcodeproj` in Xcode.
2. If Xcode requests it, install the iOS platform component under **Xcode → Settings → Components**.
3. Select the **WorkspaceHealth** target, open **Signing & Capabilities**, and choose your personal Apple development team. HealthKit is already enabled. If `com.jordburg.workspace.health` is unavailable to your team, choose a unique personal bundle identifier.
4. Connect and unlock the iPhone, select it as the run destination, then build and run. Follow Apple's prompts for trust and Developer Mode when shown.

The project targets iOS 17 or later and has no third-party app dependencies. A free Personal Team is sufficient for this prototype, although its provisioning normally expires after seven days. HealthKit data and Local Network permission require a physical iPhone; the Simulator cannot verify them.

## Pair with the Mac

1. Start the desktop Workspace and leave the Mac awake. Connect both devices to the same private Wi-Fi.
2. On the Mac, open **Health → iPhone setup**, enable the iPhone connection for the current Wi-Fi address, and download a new Workspace pairing file.
3. AirDrop the JSON file to the iPhone. In **More → Pairing & Sync**, choose the file. It expires after ten minutes and can be used once. Delete the transferred file after pairing.
4. Return to Today or pull to refresh. The app can reach the Mac only while Workspace is running on the same network.

Version 2 pairing explicitly grants this iPhone access to the personal Workspace areas exposed by the phone allowlist. Pairing replaces the previous phone token. An older version 1 Health pairing remains valid for Health sync only and cannot read planning, Climbing, Chess, Finance, Writing, Calendar, Gmail, or Todoist data; download and import a new file to use those areas.

If the connection fails, check that the Mac is awake, Workspace is running, the saved Wi-Fi IP is still current, and the network does not isolate devices. A changed IP, renewed certificate, expired certificate, revoked token, or disabled iPhone connection requires a new pairing.

## Apple Health

Open **Health**, choose **Review Health permissions**, and allow only the categories you want to share. **Sync now** sends the current 30-day snapshot plus recent sleep stages and daily context directly to the Mac. **Import older sleep history** processes the chosen range in complete 30-day batches while the app stays open; stopping keeps completed batches, and retrying is safe.

Workspace cannot determine whether an empty HealthKit read means no records or denied read permission, so missing values remain missing. Review permissions before retrying an empty import. No workout, calorie, medication, diagnosis, or measurement is inferred from a plan or climbing session.

Workout grouping uses the workout start day in its saved HealthKit timezone, with the snapshot timezone as a fallback. An overnight workout therefore belongs to its start day. Metadata-free workouts can shift calendar day when old data is synced while traveling, and HealthKit queries still use the snapshot calendar boundaries, so an item very near an import boundary may appear in the next sync.

**Log weight** on the Mac creates a pending request. The iPhone shows the exact value and measurement time and saves it only after **Save to Apple Health** is selected. Stable HealthKit identifiers, payload hashes, and local receipts prevent duplicate writes after an uncertain network response. Body mass is the only supported Health write.

## Connection security

The desktop web server and ordinary data APIs stay on loopback. Enabling iPhone sync starts a separate HTTPS listener on the selected private IPv4 address, normally port 5174. That listener exposes an exact set of versioned phone routes and requires the scope-bearing bearer token created during one-use pairing.

The pairing file pins the Mac certificate fingerprint. The iPhone accepts only HTTPS on a private IPv4 address, validates that certificate for the paired host, requires TLS 1.2 or later, refuses redirects, disables cookies and cellular access, and stores the token and Health receipts in non-synchronizing, unlocked-device-only Keychain storage. App Transport Security has no insecure HTTP exception. Provider credentials and private data files are never returned to the phone.

## Current operating limits

Sync is on demand and when the app becomes active. There is no background Mac service, cloud relay, iCloud transport, or remote-network access. Keep the Mac app running on the same Wi-Fi for reads and writes. The app preserves an open draft when a service rejects a write and uses revision checks for Mac-owned state, but the Mac remains the place to resolve provider setup and account-level changes.

The app has been signed, installed, and launched on Jordan’s iPhone. Health and Local Network permissions, certificate validation across network changes, and real HealthKit/provider round trips remain dependent on the connected device and services.
