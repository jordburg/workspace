# Workspace Health for iPhone

This companion reads permitted Apple Health data and sends it directly to your Mac. It also presents weight requests from the workspace for explicit confirmation before saving to Apple Health. It does not use a cloud service.

## Install

1. Open `WorkspaceHealth.xcodeproj` in Xcode on the Mac.
2. Install the iOS platform component shown as required in **Xcode → Settings → Components** if it is missing. The current iOS device build has been verified with the installed Xcode platform.
3. Select the **WorkspaceHealth** target → **Signing & Capabilities** → your personal Apple development team. The HealthKit entitlement is already included. If the bundle identifier is unavailable for your team, use a unique personal identifier.
4. Connect and unlock your iPhone, select it as the run destination, and follow Apple's device setup prompts. Developer Mode must be enabled on the iPhone when required. These device/security steps are performed by you.
5. Build and run. Free Personal Team provisioning expires after seven days and needs renewal/reinstallation through Xcode. A paid developer membership is optional for this personal prototype.

The project targets iOS 17 or later. There are no third-party app dependencies. Basic HealthKit access is supported with Personal Team signing; real data and local-network privacy behavior require a physical iPhone. A Simulator build alone does not verify either.

## Pair and sync

1. Leave the Mac workspace running. Put the Mac and iPhone on the same private Wi-Fi.
2. On the Mac, choose **Health → iPhone setup → Enable iPhone sync** using the current Wi-Fi address. This enables only the dedicated HTTPS health listener; it does not expose finances or the daily workspace.
3. Download the pairing JSON and AirDrop it to the iPhone. In the companion, choose **Import pairing file** and select it. Pairing expires after ten minutes and can be used once. Delete the pairing file after use.
4. Choose **Review Health permissions** and allow the measurements you want to share. Weight write permission is needed only for confirmed weight entries. Allow the Local Network prompt for direct access to your Mac.
5. Tap **Sync now**. The Mac's Health view updates within ten seconds. Opening the companion also requests a sync after Health permissions have been reviewed.

If the connection fails, verify the Mac is awake, Workspace is running, the Wi-Fi IP still matches, and both devices are on the same network. Guest networks may isolate devices. No firewall rules or privacy settings are changed by the workspace. A changed certificate, expired certificate, revoked token, or changed IP requires re-pairing. A new pairing replaces the previous phone token.

## Weight entries

On the Mac, **Log weight** accepts pounds or kilograms and the actual measurement time. The request remains pending until the companion receives it and you select **Save measurement** in its confirmation dialog. The companion saves a manual body-mass sample with a stable HealthKit sync identifier and acknowledges the exact payload hash. If the receipt cannot reach the Mac, the next sync retries acknowledgement without saving another sample.

No new workouts, calories, medications, diagnoses, or measurements are inferred from calendar plans. The current write feature is body mass only.

## Validation

The JavaScript test suite exercises TLS pairing, wrong certificate pins, one-use pairing, stale snapshots, scope checks, duplicate command IDs, and matching receipts using temporary stores. Swift source checking uses the installed iOS SDK. Physical installation, HealthKit permission behavior, Apple trust evaluation, and a real measurement round trip must still be verified on the user's iPhone after Xcode/device setup.

## Sleep update

Run this updated app from Xcode on the same iPhone; its pairing stays in Keychain. Choose **Review Health permissions** to review sleep, HRV, active energy, exercise minutes, respiratory rate and oxygen saturation alongside the existing measurements. Tap **Sync now** for 30 days of detailed sleep and daily context, then choose a start date under **Sleep history** and tap **Import sleep history** for the older archive.

Import runs in 30-day batches while the app remains open. **Stop import** finishes the active batch, then stops; completed ranges remain saved. Retrying is safe and starts at the chosen date. Reimport an older range to reflect deletions, corrections or changed read visibility. HealthKit cannot tell the app whether empty reads mean revoked permission or no records, so review permissions first. No background history import is promised.

Sleep snapshots include original sample IDs, stages (including unspecified sleep and in-bed), source/device model, software version and optional timezone metadata. Unavailable daily context is sent as null. Context uses HealthKit cumulative statistics for steps/active energy/exercise and daily averages for resting HR/HRV/respiration/oxygen. The Mac keeps sources separate for sleep and does not diagnose conditions from these readings.

The expanded companion passed a full unsigned iOS device build. Installation, renewed Health permissions and an actual sleep-history round trip still require verification on the physical iPhone.
