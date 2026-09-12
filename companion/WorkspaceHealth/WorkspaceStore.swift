import Foundation
import Combine

struct RevisionConflict<Value: Equatable & Sendable>: Identifiable, Equatable, Sendable {
    let id = UUID()
    let draft: Value
    let latest: Value
    let message: String
}

private struct EmptyBridgeBody: Codable, Sendable {}
private struct SavedBridgeResponse: Decodable, Sendable { let saved: Bool }
private struct WeightCommandsResponse: Decodable, Sendable { let commands: [WeightCommand] }

private enum WorkspaceItemChange: Sendable {
    case upsert(WorkspaceItem)
    case remove(String)

    func applying(to state: WorkspaceState) -> WorkspaceState {
        var result = state
        switch self {
        case .upsert(let item):
            if let index = result.items.firstIndex(where: { $0.id == item.id }) {
                result.items[index] = item
            } else {
                result.items.append(item)
            }
        case .remove(let id):
            result.items.removeAll { $0.id == id }
        }
        return result
    }
}

@MainActor
final class WorkspaceStore: ObservableObject {
    @Published private(set) var credentials: BridgeCredentials?
    @Published private(set) var capabilities: BridgeCapabilities?

    @Published private(set) var workspace: WorkspaceState = .empty
    @Published private(set) var climbing: ClimbingState = .empty
    @Published private(set) var finance: FinanceView = .empty
    @Published private(set) var writing: WritingView = .empty
    @Published private(set) var integrations: IntegrationView = .empty
    @Published private(set) var healthView: PhoneHealthView?
    @Published private(set) var healthSnapshot: HealthSnapshot?

    @Published private(set) var workspaceConflict: RevisionConflict<WorkspaceState>?
    @Published private(set) var climbingConflict: RevisionConflict<ClimbingState>?
    @Published private(set) var loadedAreas: Set<WorkspaceArea> = []
    @Published private(set) var busyAreas: Set<WorkspaceArea> = []
    @Published private(set) var areaErrors: [WorkspaceArea: String] = [:]

    @Published private(set) var commands: [WeightCommand] = []
    @Published private(set) var dayCount = 0
    @Published private(set) var sleepStatus = "Sleep history has not been imported in this session."
    @Published private(set) var importingHistory = false
    @Published var status = "Pair with your Mac to begin."
    @Published var error: String?

    let health: HealthStore
    private var cancelHistoryRequested = false
    private var clearAfterUnpair = false
    private var pairingEpoch = 0
    private var unpairing = false
    private var postUnpairStatus: String?
    private var workspaceConflictChange: WorkspaceItemChange?

    var isPaired: Bool { credentials != nil }
    var hasWorkspaceAccess: Bool {
        capabilities?.workspace ?? (credentials?.scope == .workspace)
    }
    var busy: Bool { !busyAreas.isEmpty }

    init(credentials suppliedCredentials: BridgeCredentials? = nil, health: HealthStore = HealthStore()) {
        self.health = health
        if let suppliedCredentials {
            credentials = suppliedCredentials
            status = suppliedCredentials.scope == .workspace
                ? "Ready to load your workspace from the Mac."
                : "Ready to sync Health with your Mac."
        } else {
            do {
                credentials = try BridgeKeychain.load()
                if let credentials {
                    status = credentials.scope == .workspace
                        ? "Ready to load your workspace from the Mac."
                        : "Ready to sync Health with your Mac."
                }
            } catch {
                credentials = nil
                self.error = error.localizedDescription
            }
        }
    }

    func isLoading(_ area: WorkspaceArea) -> Bool { busyAreas.contains(area) }

    func clearError(_ area: WorkspaceArea? = nil) {
        if let area { areaErrors.removeValue(forKey: area) }
        else { areaErrors.removeAll() }
        error = areaErrors.values.first
    }

    func pair(_ url: URL) async {
        guard !unpairing, busyAreas.isEmpty else {
            record(BridgeError.message("Wait for the current sync or save to finish before changing the Mac pairing."), area: .pairing)
            return
        }
        guard begin(.pairing) else { return }
        defer { finish(.pairing) }
        postUnpairStatus = nil
        let expectedEpoch = pairingEpoch
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
            let data = try Data(contentsOf: url)
            guard data.count <= 64_000 else {
                throw BridgeError.message("Choose the small pairing JSON file from your Mac.")
            }
            let pairing = try bridgeDecoder().decode(PairingFile.self, from: data)
            let paired = try await BridgeClient.pair(pairing)
            guard expectedEpoch == pairingEpoch else {
                BridgeKeychain.remove()
                return
            }
            resetWorkspaceState()
            credentials = paired
            status = paired.scope == .workspace
                ? "Paired. Your Workspace is available while this Mac is awake on the same Wi-Fi."
                : "Paired for Health. Keep both devices on the same Wi-Fi."
            do {
                try await negotiateCapabilities(using: BridgeClient(paired))
            } catch {
                record(error, area: .pairing)
            }
        } catch {
            record(error, area: .pairing)
        }
    }

    func useCredentials(_ newCredentials: BridgeCredentials?) {
        guard newCredentials != credentials else { return }
        pairingEpoch += 1
        resetWorkspaceState()
        credentials = newCredentials
        status = newCredentials == nil ? "Pair with your Mac to begin." : "Ready to connect to your Mac."
    }

    func unpair() async {
        guard !unpairing else { return }
        guard !busyAreas.contains(.pairing) else {
            record(
                BridgeError.message("Wait for pairing or the current Workspace refresh to finish before unpairing."),
                area: .pairing
            )
            return
        }
        unpairing = true
        pairingEpoch += 1
        clearAfterUnpair = true
        let hadCredentials = credentials != nil
        let savedClient = credentials.flatMap { try? BridgeClient($0) }
        var completionStatus = "Pair with your Mac to begin."
        BridgeKeychain.remove()
        credentials = nil
        resetWorkspaceState()
        let revokingStatus = "This iPhone is unpaired locally. Asking the Mac to revoke its saved token…"
        postUnpairStatus = revokingStatus
        status = revokingStatus
        defer {
            BridgeKeychain.remove()
            credentials = nil
            resetWorkspaceState()
            postUnpairStatus = completionStatus
            status = completionStatus
            unpairing = false
            if busyAreas.isEmpty { clearAfterUnpair = false }
        }
        guard let savedClient else {
            if hadCredentials {
                completionStatus = "This iPhone is unpaired locally. The Mac did not confirm revocation, so disable iPhone sync on the Mac to invalidate its saved token."
            }
            return
        }
        do {
            try await savedClient.revokePairing()
        } catch {
            completionStatus = "This iPhone is unpaired locally. The Mac did not confirm revocation, so disable iPhone sync on the Mac to invalidate its saved token."
        }
    }

    func loadInitial() async {
        guard begin(.pairing) else { return }
        defer { finish(.pairing) }
        guard let client = makeClient() else { return }
        do {
            try await negotiateCapabilities(using: client)
        } catch {
            record(error, area: .pairing)
            return
        }
        guard hasWorkspaceAccess else { return }
        await load(.workspace)
        await load(.climbing)
        await load(.integrations)
        await load(.health)
    }

    func refreshAll() async {
        guard begin(.pairing) else { return }
        defer { finish(.pairing) }
        guard let client = makeClient() else { return }
        do {
            try await negotiateCapabilities(using: client)
        } catch {
            record(error, area: .pairing)
            return
        }
        guard hasWorkspaceAccess else {
            record(BridgeError.message("Pair again with a Workspace pairing file to load these areas."), area: .pairing)
            return
        }
        for area in [WorkspaceArea.workspace, .climbing, .finance, .writing, .integrations, .health] {
            await load(area, force: true)
        }
    }

    func load(_ area: WorkspaceArea, force: Bool = false) async {
        guard area != .pairing else { return }
        if !force, loadedAreas.contains(area) { return }
        guard begin(area) else { return }
        defer { finish(area) }
        guard let client = makeClient() else { return }
        do {
            if area != .health || credentials?.scope == .workspace {
                try await requireWorkspace(using: client)
            }
            switch area {
            case .workspace:
                workspace = try await client.get("v1/workspace")
            case .climbing:
                climbing = try await client.get("v1/climbing")
            case .finance:
                finance = try await client.get("v1/finance")
            case .writing:
                writing = try await client.get("v1/writing")
            case .integrations:
                integrations = try await client.get("v1/integrations")
            case .health:
                try await requireWorkspace(using: client)
                healthView = try await client.get("v1/health-view")
            case .pairing:
                return
            }
            loadedAreas.insert(area)
            clearRecordedError(area)
        } catch {
            record(error, area: area)
        }
    }

    @discardableResult
    func refreshIntegrations(on date: String = WorkspaceFormat.dayKey()) async -> Bool {
        guard begin(.integrations) else { return false }
        defer { finish(.integrations) }
        guard let client = workspaceClient(area: .integrations) else { return false }
        do {
            let request = IntegrationSyncRequest(date: date)
            integrations = try await client.send("v1/integrations/sync", input: request)
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            status = "Calendar and Todoist refreshed."
            return true
        } catch {
            record(error, area: .integrations)
            return false
        }
    }

    @discardableResult
    func saveWorkspace(_ draft: WorkspaceState) async -> Bool {
        guard allowWorkspaceMutation() else { return false }
        return await persistWorkspace(draft)
    }

    @discardableResult
    private func persistWorkspace(
        _ draft: WorkspaceState,
        change: WorkspaceItemChange? = nil
    ) async -> Bool {
        guard begin(.workspace) else { return false }
        defer { finish(.workspace) }
        guard let client = workspaceClient(area: .workspace) else { return false }
        do {
            workspace = try await client.send("v1/workspace", input: draft)
            workspaceConflict = nil
            workspaceConflictChange = nil
            loadedAreas.insert(.workspace)
            clearRecordedError(.workspace)
            status = "Workspace saved."
            return true
        } catch let bridge as BridgeError where bridge.statusCode == 409 {
            let latest = try? await client.get("v1/workspace") as WorkspaceState
            let revisionChanged = latest.map { $0.revision != draft.revision } ?? false
            let isRevisionConflict: Bool
            switch bridge.responseCode {
            case "store_busy":
                isRevisionConflict = false
            case "revision_conflict":
                isRevisionConflict = true
            default:
                // Older bridge builds did not always identify their 409s. Only
                // those missing or unknown codes need revision-based inference.
                isRevisionConflict = revisionChanged
            }
            if isRevisionConflict {
                let savedLatest = latest ?? workspace
                var retainedDraft = latest.flatMap { change?.applying(to: $0) } ?? draft
                retainedDraft.revision = savedLatest.revision
                workspace = savedLatest
                workspaceConflict = RevisionConflict(draft: retainedDraft, latest: savedLatest, message: bridge.localizedDescription)
                workspaceConflictChange = change
            } else {
                // The loopback store also uses 409 while its short write lock is held.
                // Keep any earlier actionable conflict, but do not invent a new one.
                if workspaceConflict == nil, let latest { workspace = latest }
            }
            record(bridge, area: .workspace)
            return false
        } catch {
            record(error, area: .workspace)
            return false
        }
    }

    @discardableResult
    func upsertWorkspaceItem(_ item: WorkspaceItem, openingState: WorkspaceState? = nil) async -> Bool {
        guard allowWorkspaceMutation() else { return false }
        if !loadedAreas.contains(.workspace) { await load(.workspace) }
        guard loadedAreas.contains(.workspace) else { return false }
        let change = WorkspaceItemChange.upsert(item)
        let base = openingState ?? workspace
        let draft = change.applying(to: base)
        return await persistWorkspace(draft, change: change)
    }

    @discardableResult
    func removeWorkspaceItem(id: String, openingState: WorkspaceState? = nil) async -> Bool {
        guard allowWorkspaceMutation() else { return false }
        if !loadedAreas.contains(.workspace) { await load(.workspace) }
        guard loadedAreas.contains(.workspace) else { return false }
        let change = WorkspaceItemChange.remove(id)
        let base = openingState ?? workspace
        let draft = change.applying(to: base)
        return await persistWorkspace(draft, change: change)
    }

    @discardableResult
    func toggleWorkspaceItem(id: String) async -> Bool {
        guard allowWorkspaceMutation() else { return false }
        if !loadedAreas.contains(.workspace) { await load(.workspace) }
        guard loadedAreas.contains(.workspace),
              let index = workspace.items.firstIndex(where: { $0.id == id }) else { return false }
        let base = workspace
        let changed = base.items[index]
        var toggled = changed
        toggled.done.toggle()
        return await upsertWorkspaceItem(toggled, openingState: base)
    }

    @discardableResult
    func retryWorkspaceConflict() async -> Bool {
        guard let conflict = workspaceConflict else { return false }
        var draft = workspaceConflictChange?.applying(to: conflict.latest) ?? conflict.draft
        draft.revision = conflict.latest.revision
        return await persistWorkspace(draft, change: workspaceConflictChange)
    }

    func discardWorkspaceConflict() {
        workspaceConflict = nil
        workspaceConflictChange = nil
    }

    @discardableResult
    func saveClimbing(_ draft: ClimbingState) async -> Bool {
        await persistClimbing(draft)
    }

    @discardableResult
    private func persistClimbing(_ draft: ClimbingState) async -> Bool {
        guard begin(.climbing) else { return false }
        defer { finish(.climbing) }
        guard let client = workspaceClient(area: .climbing) else { return false }
        do {
            climbing = try await client.send("v1/climbing", input: draft)
            climbingConflict = nil
            loadedAreas.insert(.climbing)
            clearRecordedError(.climbing)
            status = "Climbing saved."
            return true
        } catch let bridge as BridgeError where bridge.statusCode == 409 {
            let latest = try? await client.get("v1/climbing") as ClimbingState
            let revisionChanged = latest.map { $0.revision != draft.revision } ?? false
            let isRevisionConflict: Bool
            switch bridge.responseCode {
            case "store_busy":
                isRevisionConflict = false
            case "revision_conflict":
                isRevisionConflict = true
            default:
                isRevisionConflict = revisionChanged
            }
            if isRevisionConflict {
                let savedLatest = latest ?? climbing
                climbing = savedLatest
                climbingConflict = RevisionConflict(draft: draft, latest: savedLatest, message: bridge.localizedDescription)
            } else if let latest {
                // A transient 409 must not be presented as a revision conflict.
                climbing = latest
            }
            record(bridge, area: .climbing)
            return false
        } catch {
            record(error, area: .climbing)
            return false
        }
    }

    @discardableResult
    func upsertClimbingSession(
        _ session: ClimbingSession,
        openingState: ClimbingState,
        markLinkedPlanLogged: Bool
    ) async -> Bool {
        var draft = openingState
        if let index = draft.sessions.firstIndex(where: { $0.id == session.id }) {
            draft.sessions[index] = session
        } else {
            draft.sessions.append(session)
        }
        if markLinkedPlanLogged,
           let planId = session.planId,
           let index = draft.plans.firstIndex(where: { $0.id == planId }) {
            draft.plans[index].status = .logged
            draft.plans[index].sessionId = session.id
            draft.plans[index].updatedAt = session.updatedAt
        }
        return await persistClimbing(draft)
    }

    @discardableResult
    func upsertClimbingPlan(_ plan: ClimbingPlan, openingState: ClimbingState) async -> Bool {
        var draft = openingState
        if let index = draft.plans.firstIndex(where: { $0.id == plan.id }) {
            draft.plans[index] = plan
        } else {
            draft.plans.append(plan)
        }
        return await persistClimbing(draft)
    }

    @discardableResult
    func upsertClimbingGoal(_ goal: ClimbingGoal, openingState: ClimbingState) async -> Bool {
        var draft = openingState
        if let index = draft.goals.firstIndex(where: { $0.id == goal.id }) {
            draft.goals[index] = goal
        } else {
            draft.goals.append(goal)
        }
        return await persistClimbing(draft)
    }

    @discardableResult
    func upsertClimbingRoutine(_ routine: ClimbingRoutine, openingState: ClimbingState) async -> Bool {
        var draft = openingState
        if let index = draft.routines.firstIndex(where: { $0.id == routine.id }) {
            draft.routines[index] = routine
        } else {
            draft.routines.append(routine)
        }
        return await persistClimbing(draft)
    }

    func discardClimbingConflict() { climbingConflict = nil }

    func reportStaleRow(_ noun: String, area: WorkspaceArea) {
        record(
            BridgeError.message("This \(noun) changed or was removed on your Mac. Refresh and try again."),
            area: area
        )
    }

    @discardableResult
    func saveWritingDraft(_ input: WritingInput) async -> Bool {
        guard begin(.writing) else { return false }
        defer { finish(.writing) }
        guard let client = workspaceClient(area: .writing) else { return false }
        do {
            writing = try await client.send("v1/writing/save", input: input)
            loadedAreas.insert(.writing)
            clearRecordedError(.writing)
            status = "Writing draft saved."
            return true
        } catch {
            record(error, area: .writing)
            return false
        }
    }

    @discardableResult
    func saveWritingDraft(_ draft: WritingDraft) async -> Bool {
        await saveWritingDraft(draft.input)
    }

    @discardableResult
    func syncFinance() async -> Bool {
        guard begin(.finance) else { return false }
        defer { finish(.finance) }
        guard let client = workspaceClient(area: .finance) else { return false }
        do {
            finance = try await client.send("v1/finance/sync", input: EmptyBridgeBody())
            loadedAreas.insert(.finance)
            clearRecordedError(.finance)
            status = "Finances refreshed."
            return true
        } catch {
            record(error, area: .finance)
            return false
        }
    }

    @discardableResult
    func annotateFinance(_ input: FinanceNoteInput) async -> Bool {
        guard begin(.finance) else { return false }
        defer { finish(.finance) }
        guard let client = workspaceClient(area: .finance) else { return false }
        do {
            finance = try await client.send("v1/finance/annotate", input: input)
            loadedAreas.insert(.finance)
            clearRecordedError(.finance)
            status = "Transaction notes saved."
            return true
        } catch {
            record(error, area: .finance)
            return false
        }
    }

    @discardableResult
    func mutateIntegration(_ mutation: IntegrationMutation) async -> Bool {
        guard begin(.integrations) else { return false }
        defer { finish(.integrations) }
        guard let client = workspaceClient(area: .integrations) else { return false }
        do {
            var request = mutation
            if request.provider == .todoist,
               request.action == .update,
               request.date == nil,
               let task = integrations.tasks.first(where: { $0.id == request.id }),
               !task.recurring,
               task.dueTime == nil {
                request.encodesNilDate = true
            }
            integrations = try await client.send("v1/integrations/mutate", input: request)
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            status = mutation.provider == .google ? "Calendar updated." : "Todoist updated."
            return true
        } catch {
            record(error, area: .integrations)
            return false
        }
    }

    @discardableResult
    func unlinkIntegration(id: String) async -> Bool {
        guard begin(.integrations) else { return false }
        defer { finish(.integrations) }
        guard let client = workspaceClient(area: .integrations) else { return false }
        do {
            integrations = try await client.send("v1/integrations/unlink", input: IntegrationUnlinkRequest(id: id))
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            status = "The local connection link was forgotten."
            return true
        } catch {
            record(error, area: .integrations)
            return false
        }
    }

    func authorizeHealth() async {
        guard begin(.health) else { return }
        defer { finish(.health) }
        do {
            try await health.authorize()
            UserDefaults.standard.set(true, forKey: "healthPermissionsRequested")
            clearRecordedError(.health)
            status = "Health permissions reviewed. You can sync accessible data."
        } catch {
            record(error, area: .health)
        }
    }

    func syncHealth() async {
        guard begin(.health) else { return }
        defer { finish(.health) }
        guard let credentials, let client = makeClient() else { return }
        do {
            health.refreshCalendar()
            let snapshot = try await health.snapshot()
            let _: SavedBridgeResponse = try await client.call("snapshot", body: bridgeEncoder().encode(snapshot))
            healthSnapshot = snapshot

            let calendar = health.calendar
            let today = calendar.startOfDay(for: Date())
            let from = calendar.date(byAdding: .day, value: -29, to: today)!
            let to = calendar.date(byAdding: .day, value: 1, to: today)!
            let batch = try await health.sleepBatch(from: from, to: to)
            let _: SavedBridgeResponse = try await client.call("sleep-batch", body: bridgeEncoder().encode(batch))
            sleepStatus = "Recent sleep stages and daily context synced."

            let pending: WeightCommandsResponse = try await client.get("commands")
            var review: [WeightCommand] = []
            for command in pending.commands {
                if let receipt = credentials.receipts[command.id] {
                    guard receipt == command.payloadHash else {
                        throw BridgeError.message("A health request changed after it was saved. Check the Mac’s health queue.")
                    }
                    let body = try JSONSerialization.data(withJSONObject: ["id": command.id, "payloadHash": receipt])
                    let _: SavedBridgeResponse = try await client.call("receipt", body: body)
                } else {
                    review.append(command)
                }
            }
            commands = review
            dayCount = snapshot.days.count
            if hasWorkspaceAccess {
                healthView = try? await client.get("v1/health-view")
                if healthView != nil { loadedAreas.insert(.health) }
            }
            clearRecordedError(.health)
            status = "Synced at \(Date().formatted(date: .omitted, time: .shortened))."
        } catch {
            record(error, area: .health)
        }
    }

    func importHealthHistory(from requested: Date) async {
        guard begin(.health) else { return }
        importingHistory = true
        cancelHistoryRequested = false
        defer {
            importingHistory = false
            finish(.health)
        }
        guard let client = makeClient() else { return }
        do {
            health.refreshCalendar()
            let calendar = health.calendar
            var cursor = calendar.startOfDay(for: requested)
            let end = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date()))!
            while cursor < end, !cancelHistoryRequested {
                let next = min(calendar.date(byAdding: .day, value: 30, to: cursor)!, end)
                sleepStatus = "Importing \(cursor.formatted(date: .abbreviated, time: .omitted))…"
                let batch = try await health.sleepBatch(from: cursor, to: next)
                let _: SavedBridgeResponse = try await client.call("sleep-batch", body: bridgeEncoder().encode(batch))
                cursor = next
                sleepStatus = "Saved history through \(next.addingTimeInterval(-1).formatted(date: .abbreviated, time: .omitted))."
            }
            if cancelHistoryRequested {
                sleepStatus += " Import stopped; completed ranges are kept."
            } else {
                sleepStatus = "Sleep history imported. Open Sleep on your Mac."
            }
            clearRecordedError(.health)
        } catch {
            record(error, area: .health)
            sleepStatus += " Completed ranges are kept. Retrying is safe."
        }
    }

    func cancelHealthHistory() { cancelHistoryRequested = true }

    func confirmWeight(_ command: WeightCommand) async {
        guard begin(.health) else { return }
        defer { finish(.health) }
        guard var credentials, let client = makeClient() else { return }
        do {
            if let receipt = credentials.receipts[command.id], receipt != command.payloadHash {
                throw BridgeError.message("This health request changed after it was saved.")
            }
            if credentials.receipts[command.id] == nil {
                try await health.saveWeight(command)
                credentials.receipts[command.id] = command.payloadHash
                try BridgeKeychain.save(credentials)
                self.credentials = credentials
            }
            let body = try JSONSerialization.data(withJSONObject: ["id": command.id, "payloadHash": command.payloadHash])
            let _: SavedBridgeResponse = try await client.call("receipt", body: body)
            commands.removeAll { $0.id == command.id }
            clearRecordedError(.health)
            status = "Weight saved to Apple Health. Sync to update your Mac."
        } catch {
            record(error, area: .health)
        }
    }

    // Compatibility with the original Health-only view while the native shell is adopted.
    func authorize() async { await authorizeHealth() }
    func sync() async { await syncHealth() }
    func importHistory(from date: Date) async { await importHealthHistory(from: date) }
    func save(_ command: WeightCommand) async { await confirmWeight(command) }

    private func begin(_ area: WorkspaceArea) -> Bool {
        guard !unpairing, !busyAreas.contains(area) else { return false }
        busyAreas.insert(area)
        areaErrors.removeValue(forKey: area)
        error = areaErrors.values.first
        return true
    }

    private func finish(_ area: WorkspaceArea) {
        busyAreas.remove(area)
        // Unpairing is immediate even when an already-started request is winding
        // down. Do not let that request repopulate cached data afterward.
        if clearAfterUnpair, !unpairing {
            BridgeKeychain.remove()
            credentials = nil
            resetWorkspaceState()
            status = postUnpairStatus ?? "Pair with your Mac to begin."
            if busyAreas.isEmpty { clearAfterUnpair = false }
        }
    }

    private func makeClient() -> BridgeClient? {
        guard let credentials else {
            record(BridgeError.message("Pair this iPhone with your Mac first."), area: .pairing)
            return nil
        }
        do {
            return try BridgeClient(credentials)
        } catch {
            record(error, area: .pairing)
            return nil
        }
    }

    private func workspaceClient(area: WorkspaceArea) -> BridgeClient? {
        guard let client = makeClient() else { return nil }
        guard hasWorkspaceAccess else {
            record(BridgeError.message("Pair again with a Workspace pairing file to use this area."), area: area)
            return nil
        }
        return client
    }

    private func negotiateCapabilities(using client: BridgeClient) async throws {
        let value = try await client.negotiateCapabilities()
        guard value.health else {
            throw BridgeError.message("This Mac does not support the Health bridge expected by this app.")
        }
        capabilities = value
        if var credentials, credentials.scope != value.scope {
            credentials.scope = value.scope
            try BridgeKeychain.save(credentials)
            self.credentials = credentials
        }
        clearRecordedError(.pairing)
    }

    private func requireWorkspace(using client: BridgeClient) async throws {
        if capabilities == nil { try await negotiateCapabilities(using: client) }
        guard capabilities?.workspace == true else {
            throw BridgeError.message("This phone is paired for Health only. Pair again with a Workspace pairing file.")
        }
    }

    private func clearRecordedError(_ area: WorkspaceArea) {
        areaErrors.removeValue(forKey: area)
        error = areaErrors.values.first
    }

    private func allowWorkspaceMutation() -> Bool {
        guard workspaceConflict == nil else {
            record(
                BridgeError.message("Resolve the saved Workspace conflict before making another Workspace change."),
                area: .workspace
            )
            return false
        }
        return true
    }

    private func record(_ cause: Error, area: WorkspaceArea) {
        let message = cause.localizedDescription
        areaErrors[area] = message
        error = message
    }

    private func resetWorkspaceState() {
        capabilities = nil
        workspace = .empty
        climbing = .empty
        finance = .empty
        writing = .empty
        integrations = .empty
        healthView = nil
        healthSnapshot = nil
        commands = []
        dayCount = 0
        sleepStatus = "Sleep history has not been imported in this session."
        cancelHistoryRequested = true
        workspaceConflict = nil
        workspaceConflictChange = nil
        climbingConflict = nil
        loadedAreas = []
        areaErrors = [:]
        error = nil
    }
}
