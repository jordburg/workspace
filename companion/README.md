# Workspace companion for iPhone and iPad

Workspace is a native companion to the personal Workspace on your Mac. The iPhone keeps the parts that are useful away from the desk: the day ahead, quick capture, personal Todoist tasks, Climbing, the current Chess lesson, and a compact Apple Health summary. The iPad uses a desktop-style sidebar and adds wider views while the Mac is available. Both devices keep protected local snapshots of the core planning, Climbing, and Chess experience between deliberate sync sessions. The Mac remains the source of truth. An optional private CloudKit mirror carries only climbing photos and videos between the owner’s devices; it is not a Workspace data service or provider-credential store.

## What is available on iPhone

- **Today** combines local priorities and plans with the selected personal Google Calendar. It also shows a compact Apple Health summary for the day.
- **Capture** provides the same quick “A place to put it” entry point as the desktop overview, saving a capture to Workspace Captures for later review.
- **Tasks** shows active tasks from the selected Todoist Personal project and supports the task actions intended for use on the go.
- **Climbing** manages sessions, plans, goals, and versioned training routines. An individual climb in a session can link to a climb project, giving the project a reciprocal activity history, recorded attempts, latest work, and derived send state while the session retains its historical route snapshot. Manual project attempt totals stay separate from linked-session counts so older estimates are not double-counted, and missing attempt counts remain unknown. A project named by a plan is offered as a quick addition when logging the session but is not recorded automatically. Archived projects remain available for historical backfilling. Climb projects use route-specific fields for setting, discipline, optional rope style, grade, location, target, and send status. A saved goal can keep up to 12 private beta photos, videos, and HTTPS links; individual uploads are limited to 200 MB, with the Mac enforcing the shared storage quotas. A photo or video added or opened on a companion device is kept in protected local storage so that device can open it again while the Mac is away. Plans can be linked to reviewed Calendar events, goal actions can be linked to reviewed Todoist tasks, and sessions can reference an Apple Health workout without changing it.
- **Lesson** opens the current in-progress Chess lesson from the desktop Workspace. Its tap-to-move board, hints, authored explanations, and progress updates use the same private Chess record as the Mac.

Open **Settings** from the gear button or iPad sidebar. It is the single place on each device for Mac pairing, manual sync, connection status, and climbing links. Apple Health permissions, history import, and pending Health write approvals appear only on iPhone. The iPad reads the Health summary already saved on the Mac and never writes HealthKit data.

Mail, Finance, Writing, the full Chess catalog and review queue, and detailed Health views are available in the iPad layout while the Mac is reachable; they are not retained in the offline snapshot. The focused iPhone layout leaves them on the Mac. Plaid credentials and bank connections, Google OAuth, Todoist token setup, personal account/source selection, and site export and recovery remain Mac actions. Companion devices never receive provider credentials.

## Install

1. Open `WorkspaceHealth.xcodeproj` in Xcode.
2. If Xcode requests it, install the iOS platform component under **Xcode → Settings → Components**.
3. Select the **WorkspaceHealth** target, open **Signing & Capabilities**, and choose your personal Apple development team. HealthKit is already enabled. If `com.jordburg.workspace.health` is unavailable to your team, choose a unique personal bundle identifier.
4. Connect and unlock the iPhone or iPad, select it as the run destination, then build and run. Follow Apple's prompts for trust and Developer Mode when shown.

The project targets iOS/iPadOS 17 or later and has no third-party app dependencies. A free Personal Team can run the local-cache, Mac-bridge, and HealthKit paths, although its provisioning normally expires after seven days. Private CloudKit media requires a paid Developer Program team, the app’s iCloud/CloudKit capability, and the permanent `iCloud.com.jordburg.workspace` container. HealthKit collection and writes are intentionally limited to a physical iPhone; Local Network and CloudKit behavior also need physical devices for complete verification.

## Private iCloud climbing media

The app’s CloudKit code is guarded by `WorkspaceCloudMediaEnabled` in `Info.plist`. It remains `false` until the matching iCloud container entitlement and provisioning profile are active; while false, the app never constructs a `CKContainer` and continues using the protected device cache and Mac bridge normally. Change the flag to `true` only in the same signed build that contains the `iCloud.com.jordburg.workspace` entitlement.

With the capability active, **Settings → Climbing media → Review iCloud sync** first displays the exact number and total size of files that will be copied, plus any deletions to reconcile. The copy starts only after that visible confirmation and stays in the foreground. Approval is stored as a versioned record for the current Workspace pairing fingerprint and a SHA-256 digest of the private CloudKit account identity. It is cleared on unpair, replacement pairing, or an iCloud-account change, and enables later best-effort mirroring of new media only while both identities still match. The companion refreshes the authoritative attachment list from the Mac, reads its SHA-256 upload/deletion ledger, creates a custom zone in the user’s private CloudKit database, verifies each original’s digest and byte count, and stores the file as a `CKAsset`. Confirmed deletions become terminal, metadata-minimal CloudKit tombstones, so an older companion snapshot cannot restore a removed file. Each receipt sent back to the Mac is retry-safe and leaves the shared `ClimbingGoalReference` format unchanged.

Opening an attachment checks its protected local copy first, private iCloud second, and the paired Mac last. A successful iCloud or Mac download is imported into the protected local cache before preview. New uploads and confirmed removals also make a best-effort CloudKit update while the app is open; the Settings sync remains the complete, resumable reconciliation path. The Settings progress display reports the current foreground item, successful CloudKit records are counted separately from device downloads, and removing downloads never deletes the Mac or iCloud original.

CloudKit stores only attachment IDs, project IDs, media metadata, digests, lifecycle timestamps, and the asset in the user’s private database. It does not receive Workspace snapshots, Apple Health data, pairing tokens, Google/Todoist/Plaid credentials, or other provider data. Test representative image/video sizes, including the 200 MB application limit, on both physical devices before treating the mirror as production-ready.

## Pair with the Mac

1. Start the desktop Workspace and leave the Mac awake. Connect the Mac and companion device to the same private Wi-Fi.
2. On the Mac, open **Settings → Companion devices and Apple Health**, enable the companion connection for the current Wi-Fi address, and download the pairing file that matches the iPhone or iPad.
3. Transfer the JSON file to that device. Open **Settings** in the native app and choose the file. It expires after ten minutes and can be used once. Delete the transferred file after pairing.
4. Return to Today. The app can reach the Mac only while Workspace is running on the same network; manual refresh remains in Settings.

Repeat steps 2–3 with a fresh matching file for every device. Version 2 pairing binds the one-time file to its iPhone or iPad role, gives each device its own scoped token, and adds it without revoking existing devices. Workspace accepts up to eight devices total and exactly one Health-owning iPhone; importing a new iPhone file on that same phone rotates its credential, while a second iPhone is refused. Pairing any device again with the same Mac rotates only that device’s prior token. A dropped pairing response can replay the same result during a short retry window without consuming another device slot. Unpairing from Settings revokes only that device; disabling companion sync on the Mac revokes them all. An older version 1 Health pairing remains valid on iPhone for Health sync only and cannot read the other Workspace areas; download and import a new file to use those areas. The iPad accepts Workspace iPad pairing files only.

If the connection fails, check that the Mac is awake, Workspace is running, the saved Wi-Fi IP is still current, and the network does not isolate devices. A changed IP, renewed certificate, expired certificate, revoked token, or disabled companion connection requires a new pairing for the affected devices.

## Apple Health

On iPhone, open **Settings**, choose **Review Health permissions**, and allow only the categories you want to share. **Sync Apple Health** sends the current 30-day snapshot plus recent sleep stages and daily context directly to the Mac. **Import older sleep history** processes the chosen range in complete 30-day batches while the app stays open; stopping keeps completed batches, and retrying is safe. The latest daily values appear in Today on iPhone and in read-only Health views on iPad.

Workspace cannot determine whether an empty HealthKit read means no records or denied read permission, so missing values remain missing. Review permissions before retrying an empty import. No workout, calorie, medication, diagnosis, or measurement is inferred from a plan or climbing session.

Workout grouping uses the workout start day in its saved HealthKit timezone, with the snapshot timezone as a fallback. An overnight workout therefore belongs to its start day. Metadata-free workouts can shift calendar day when old data is synced while traveling, and HealthKit queries still use the snapshot calendar boundaries, so an item very near an import boundary may appear in the next sync.

**Log weight** on the Mac creates a pending request. Review pending Health writes in iPhone Settings; the app shows the exact value and measurement time and saves it only after **Save to Apple Health** is selected. Stable HealthKit identifiers, payload hashes, and local receipts prevent duplicate writes after an uncertain network response. Body mass is the only supported Health write.

## Connection security

The desktop web server and ordinary data APIs stay on loopback. Enabling companion sync starts a separate HTTPS listener on the selected private IPv4 address, normally port 5174. That listener exposes an exact set of versioned native routes and requires the calling device’s scope-bearing bearer token created during pairing. Shared companion routes cover the focused planning experience; additional Mail, Finance, Writing, Chess-review, read-only Health, and Gmail relationship operations require an iPad token. Apple Health uploads, commands, and receipts require the single iPhone token. iPhone integration responses omit Gmail state and message summaries, while iPad Mail receives only the public Gmail view.

The pairing file pins the Mac certificate fingerprint. Each native app accepts only HTTPS on a private IPv4 address, validates that certificate for the paired host, requires TLS 1.2 or later, refuses redirects, disables cookies and cellular access, and stores its token in non-synchronizing, unlocked-device-only Keychain storage. iPhone Health receipts use the same protection. App Transport Security has no insecure HTTP exception. Provider credentials and private data files are never returned to a companion device.

## Current operating limits

The app keeps a protected, versioned last-good snapshot of daily planning, Todoist tasks, Climbing, and the current Chess lesson. It also keeps protected offline copies of climbing photos and videos after they are added or opened on that device; Settings shows their count and can remove those downloaded copies without deleting the goal references. Those areas open directly from saved data while the Mac is away; ordinary disconnection is not presented as a warning on every page. Today carries one quiet freshness line, while Settings holds the exact connection state, last Mac contact, pending Capture count, and manual sync action. A prominent message is reserved for first-time setup, missing initial data, revoked access, conflicts, and other conditions that require action.

After Workspace pairing, Capture is the offline write path: its draft and queued entries persist across launches and flush with stable request IDs when the paired Mac becomes reachable. Capture state is bound to the pairing certificate fingerprint. Re-pairing retains captures only when the certificate still identifies the same Mac. Unpairing, a pairing for a different certificate, or a stored identity mismatch clears them, so an entry queued for one Mac is never delivered to another.

Workspace item saves, completion toggles, and deletes use record-level commands with per-item revisions. Climbing session, plan, goal, and routine saves use record-level commands with each record's last-update value; saving a session and marking its linked plan logged is one command. Retry-stable request IDs prevent an uncertain response from duplicating a change, while record conflicts keep the attempted edit available for review. Other offline edits are not queued and still require the paired Mac to accept the save.

Workspace makes one short connection attempt when the app launches. While the Mac is away, automatic retries back off for fifteen minutes and expected reachability failures stay quiet; returning to the app never replaces a usable snapshot with a connection warning. Calendar and Todoist do not start extra refresh attempts while the Mac is already known to be unavailable. **Settings** provides the deliberate sync action.

There is no background Mac service, general cloud relay, remote-network access, or USB data transport. The optional private iCloud path carries climbing-media assets only; all other Workspace network reads and writes still require the Mac app to be running and each syncing device to be on the same private Wi-Fi. A cable can keep a device powered and available for installation, but plugging it in alone does not currently transfer Workspace data.

The app has been signed, installed, and launched on Jordan’s iPhone and iPad. Health and Local Network permissions, certificate validation across network changes, and real HealthKit/provider round trips remain dependent on the connected devices and services.
