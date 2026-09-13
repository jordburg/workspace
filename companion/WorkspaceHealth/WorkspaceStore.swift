import Foundation
import Combine
import UniformTypeIdentifiers

struct RevisionConflict<Value: Equatable & Sendable>: Identifiable, Equatable, Sendable {
    let id = UUID()
    let draft: Value
    let latest: Value
    let message: String
}

private struct EmptyBridgeBody: Codable, Sendable {}
private struct SavedBridgeResponse: Decodable, Sendable { let saved: Bool }
private struct WeightCommandsResponse: Decodable, Sendable { let commands: [WeightCommand] }
private let capturePersistenceError = "This device could not protect the Capture draft. Keep this screen open and try again."

enum CompanionConnectionState: Equatable, Sendable {
    case unpaired
    case connecting
    case online
    case offlineWithCache
    case error(String)
}

enum CaptureDisposition: Equatable, Sendable {
    case delivered
    case queued
}

private struct CompanionSnapshotCache: Codable, Sendable {
    static let currentVersion = 1

    var version = currentVersion
    var savedAt = Date()
    var lastSuccessfulContact: Date?
    var areaSavedAt: [String: Date] = [:]
    var workspace: WorkspaceState?
    var climbing: ClimbingState?
    var chess: ChessView?
    var integrations: IntegrationView?
}

private struct CaptureOutboxEntry: Codable, Identifiable, Equatable, Sendable {
    let requestId: String
    let item: WorkspaceItem
    let createdAt: Date
    var id: String { requestId }
}

private enum WorkspaceItemChange: Equatable, Sendable {
    case upsert(WorkspaceItem)
    case restore(item: WorkspaceItem, expectedTombstoneRevision: Int)
    case remove(String)
    case toggle(id: String, done: Bool)

    var itemId: String {
        switch self {
        case .upsert(let item): item.id
        case .restore(let item, _): item.id
        case .remove(let id), .toggle(let id, _): id
        }
    }

    var attemptKey: String {
        switch self {
        case .upsert: "upsert:\(itemId)"
        case .restore: "restore:\(itemId)"
        case .remove: "delete:\(itemId)"
        case .toggle: "toggle:\(itemId)"
        }
    }

    func applying(to state: WorkspaceState) -> WorkspaceState {
        var result = state
        switch self {
        case .upsert(let item), .restore(let item, _):
            if let index = result.items.firstIndex(where: { $0.id == item.id }) {
                result.items[index] = item
            } else {
                result.items.append(item)
            }
        case .remove(let id):
            result.items.removeAll { $0.id == id }
        case .toggle(let id, let done):
            if let index = result.items.firstIndex(where: { $0.id == id }) {
                result.items[index].done = done
            }
        }
        if case .restore(let item, _) = self {
            result.tombstones?.removeAll { $0.id == item.id }
        }
        return result
    }

    func isSatisfied(by state: WorkspaceState) -> Bool {
        switch self {
        case .upsert(let item), .restore(let item, _):
            guard let saved = state.items.first(where: { $0.id == item.id }) else { return false }
            return saved.kind == item.kind
                && saved.title == item.title
                && saved.area == item.area
                && saved.date == item.date
                && saved.time == item.time
                && saved.endTime == item.endTime
                && saved.done == item.done
        case .remove(let id):
            return !state.items.contains { $0.id == id }
        case .toggle(let id, let done):
            return state.items.first(where: { $0.id == id })?.done == done
        }
    }
}

private struct WorkspaceRecordCommand: Encodable, Equatable, Sendable {
    let requestId: String
    let expectedItemRevision: Int?
    let change: WorkspaceItemChange

    private enum CodingKeys: String, CodingKey {
        case action, requestId, expectedItemRevision, expectedTombstoneRevision, item, id, done
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId, forKey: .requestId)
        switch change {
        case .upsert(let item):
            try values.encode("upsert", forKey: .action)
            if let expectedItemRevision {
                try values.encode(expectedItemRevision, forKey: .expectedItemRevision)
            } else {
                try values.encodeNil(forKey: .expectedItemRevision)
            }
            try values.encode(item, forKey: .item)
        case .restore(let item, let expectedTombstoneRevision):
            try values.encode("restore", forKey: .action)
            try values.encode(expectedTombstoneRevision, forKey: .expectedTombstoneRevision)
            try values.encode(item, forKey: .item)
        case .remove(let id):
            try values.encode("delete", forKey: .action)
            try values.encode(expectedItemRevision, forKey: .expectedItemRevision)
            try values.encode(id, forKey: .id)
        case .toggle(let id, let done):
            try values.encode("toggle", forKey: .action)
            try values.encode(expectedItemRevision, forKey: .expectedItemRevision)
            try values.encode(id, forKey: .id)
            try values.encode(done, forKey: .done)
        }
    }
}

private enum ClimbingRecordChange: Encodable, Equatable, Sendable {
    case session(expectedUpdatedAt: String?, value: ClimbingSession)
    case goal(expectedUpdatedAt: String?, value: ClimbingGoal)
    case routine(expectedUpdatedAt: String?, value: ClimbingRoutine)
    case plan(expectedUpdatedAt: String?, value: ClimbingPlan)

    var recordKey: String {
        switch self {
        case .session(_, let value): "session:\(value.id)"
        case .goal(_, let value): "goal:\(value.id)"
        case .routine(_, let value): "routine:\(value.id)"
        case .plan(_, let value): "plan:\(value.id)"
        }
    }

    func applying(to state: ClimbingState) -> ClimbingState {
        var result = state
        switch self {
        case .session(_, let value):
            if let index = result.sessions.firstIndex(where: { $0.id == value.id }) { result.sessions[index] = value }
            else { result.sessions.append(value) }
        case .goal(_, let value):
            if let index = result.goals.firstIndex(where: { $0.id == value.id }) { result.goals[index] = value }
            else { result.goals.append(value) }
        case .routine(_, let value):
            if let index = result.routines.firstIndex(where: { $0.id == value.id }) { result.routines[index] = value }
            else { result.routines.append(value) }
        case .plan(_, let value):
            if let index = result.plans.firstIndex(where: { $0.id == value.id }) { result.plans[index] = value }
            else { result.plans.append(value) }
        }
        return result
    }

    func isSatisfied(by state: ClimbingState) -> Bool {
        switch self {
        case .session(_, let value): state.sessions.first(where: { $0.id == value.id }) == value
        case .goal(_, let value): state.goals.first(where: { $0.id == value.id }) == value
        case .routine(_, let value): state.routines.first(where: { $0.id == value.id }) == value
        case .plan(_, let value): state.plans.first(where: { $0.id == value.id }) == value
        }
    }

    func isRetryEquivalent(to other: ClimbingRecordChange) -> Bool {
        switch (self, other) {
        case let (.session(leftExpected, leftValue), .session(rightExpected, rightValue)):
            var left = leftValue
            var right = rightValue
            left.updatedAt = ""
            right.updatedAt = ""
            if left.deletedAt != nil, right.deletedAt != nil {
                left.deletedAt = ""
                right.deletedAt = ""
            }
            return leftExpected == rightExpected && left == right
        case let (.goal(leftExpected, leftValue), .goal(rightExpected, rightValue)):
            var left = leftValue
            var right = rightValue
            left.updatedAt = ""
            right.updatedAt = ""
            if left.archivedAt != nil, right.archivedAt != nil {
                left.archivedAt = ""
                right.archivedAt = ""
            }
            return leftExpected == rightExpected && left == right
        case let (.routine(leftExpected, leftValue), .routine(rightExpected, rightValue)):
            var left = leftValue
            var right = rightValue
            left.updatedAt = ""
            right.updatedAt = ""
            return leftExpected == rightExpected && left == right
        case let (.plan(leftExpected, leftValue), .plan(rightExpected, rightValue)):
            var left = leftValue
            var right = rightValue
            left.updatedAt = ""
            right.updatedAt = ""
            return leftExpected == rightExpected && left == right
        default:
            return false
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, expectedUpdatedAt, value }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        let expected: String?
        switch self {
        case .session(let expectedUpdatedAt, let value):
            expected = expectedUpdatedAt
            try values.encode("session", forKey: .kind)
            try values.encode(value, forKey: .value)
        case .goal(let expectedUpdatedAt, let value):
            expected = expectedUpdatedAt
            try values.encode("goal", forKey: .kind)
            try values.encode(value, forKey: .value)
        case .routine(let expectedUpdatedAt, let value):
            expected = expectedUpdatedAt
            try values.encode("routine", forKey: .kind)
            try values.encode(value, forKey: .value)
        case .plan(let expectedUpdatedAt, let value):
            expected = expectedUpdatedAt
            try values.encode("plan", forKey: .kind)
            try values.encode(value, forKey: .value)
        }
        if let expected { try values.encode(expected, forKey: .expectedUpdatedAt) }
        else { try values.encodeNil(forKey: .expectedUpdatedAt) }
    }
}

private struct ClimbingRecordCommand: Encodable, Equatable, Sendable {
    let requestId: String
    let changes: [ClimbingRecordChange]
}

private struct ClimbingMediaLinkCommand: Encodable, Sendable {
    let requestId: String
    let reference: ClimbingGoalReference
}

private struct ClimbingMediaDeleteCommand: Encodable, Sendable {
    let requestId: String
    let goalId: String
    let referenceId: String
}

private struct CompanionLocalState: Codable, Sendable {
    static let currentVersion = 1

    var version = currentVersion
    var pairingIdentity: String?
    var captureDraft = ""
    var captureOutbox: [CaptureOutboxEntry] = []
}

private func companionPlanningSnapshot(_ value: IntegrationView) -> IntegrationView {
    IntegrationView(
        todoist: value.todoist,
        google: value.google,
        gmail: .empty,
        tasks: value.tasks,
        events: value.events,
        messages: [],
        links: value.links,
        range: value.range
    )
}

private enum CompanionPersistence {
    private static let directoryName = "Companion"
    private static let snapshotName = "snapshot-v1.json"
    private static let localStateName = "local-state-v1.json"

    static func loadSnapshot() -> CompanionSnapshotCache? {
        load(CompanionSnapshotCache.self, name: snapshotName).flatMap {
            $0.version == CompanionSnapshotCache.currentVersion ? $0 : nil
        }
    }

    static func loadLocalState() -> CompanionLocalState? {
        load(CompanionLocalState.self, name: localStateName).flatMap {
            $0.version == CompanionLocalState.currentVersion ? $0 : nil
        }
    }

    static func saveSnapshot(_ value: CompanionSnapshotCache) throws {
        try save(value, name: snapshotName)
    }

    static func saveLocalState(_ value: CompanionLocalState) throws {
        try save(value, name: localStateName)
    }

    static func removeSnapshot() {
        guard let directory = try? directoryURL(create: false) else { return }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(snapshotName))
    }

    static func removeLocalState() {
        guard let directory = try? directoryURL(create: false) else { return }
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(localStateName))
    }

    private static func load<Value: Decodable>(_ type: Value.Type, name: String) -> Value? {
        guard let directory = try? directoryURL(create: false),
              let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
        return try? bridgeDecoder().decode(type, from: data)
    }

    private static func save<Value: Encodable>(_ value: Value, name: String) throws {
        let directory = try directoryURL(create: true)
        let url = directory.appendingPathComponent(name)
        let data = try bridgeEncoder().encode(value)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    }

    private static func directoryURL(create: Bool) throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: create
        )
        let directory = base.appendingPathComponent(directoryName, isDirectory: true)
        if create {
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.complete]
            )
        }
        return directory
    }
}

@MainActor
final class WorkspaceStore: ObservableObject {
    @Published private(set) var credentials: BridgeCredentials?
    @Published private(set) var capabilities: BridgeCapabilities?

    @Published private(set) var workspace: WorkspaceState = .empty
    @Published private(set) var climbing: ClimbingState = .empty
    @Published private(set) var chess: ChessView = .empty
    @Published private(set) var finance: FinanceView = .empty
    @Published private(set) var writing: WritingView = .empty
    @Published private(set) var integrations: IntegrationView = .empty
    @Published private(set) var healthView: PhoneHealthView?
    @Published private(set) var healthSnapshot: HealthSnapshot?
    @Published private(set) var mailLoadedFromMac = false

    @Published private(set) var connectionState: CompanionConnectionState = .unpaired
    @Published private(set) var lastSuccessfulContact: Date?
    @Published private(set) var captureDraft = ""
    @Published private(set) var pendingCaptureCount = 0

    @Published private(set) var workspaceConflict: RevisionConflict<WorkspaceState>?
    @Published private(set) var climbingConflict: RevisionConflict<ClimbingState>?
    @Published private(set) var loadedAreas: Set<WorkspaceArea> = []
    @Published private(set) var busyAreas: Set<WorkspaceArea> = []
    @Published private(set) var areaErrors: [WorkspaceArea: String] = [:]
    @Published private(set) var chessProgressNeedsRebase = false
    @Published private(set) var chessReviewCanChangeAnswer = false
    @Published private(set) var chessReviewNoLongerDue = false
    @Published private(set) var chessSessionNeedsRebase = false

    @Published private(set) var commands: [WeightCommand] = []
    @Published private(set) var dayCount = 0
    @Published private(set) var sleepStatus = "Sleep history has not been imported in this session."
    @Published private(set) var importingHistory = false
    @Published var status = "Pair with your Mac to begin."

    let health: HealthStore
    private var cancelHistoryRequested = false
    private var clearAfterUnpair = false
    private var pairingEpoch = 0
    private var unpairing = false
    private var postUnpairStatus: String?
    private var lastConnectionAttempt: Date?
    private var workspaceConflictChange: WorkspaceItemChange?
    private var snapshotCache = CompanionSnapshotCache()
    private var captureOutbox: [CaptureOutboxEntry] = []
    private var capturePairingIdentity: String?
    private var localStateSaveTask: Task<Void, Never>?
    private var workspaceRecordAttempts: [String: WorkspaceRecordCommand] = [:]
    private var climbingRecordAttempts: [String: ClimbingRecordCommand] = [:]

    var isPaired: Bool { credentials != nil }
    var isOnline: Bool { connectionState == .online }
    var hasCachedContent: Bool { !loadedAreas.isEmpty }
    var managesAppleHealth: Bool { health.supportsLocalHealthSync }
    var connectionNeedsAttention: Bool {
        if case .error = connectionState { return true }
        return false
    }
    var needsForegroundRefresh: Bool {
        guard isPaired else { return false }
        let now = Date()
        if connectionState == .online, let lastSuccessfulContact {
            return now.timeIntervalSince(lastSuccessfulContact) >= 5 * 60
        }
        if let lastConnectionAttempt {
            return now.timeIntervalSince(lastConnectionAttempt) >= 15 * 60
        }
        return true
    }
    var hasWorkspaceAccess: Bool {
        capabilities?.workspace ?? (credentials?.scope == .workspace)
    }
    var integrationProviderError: String? {
        [integrations.todoist.error, integrations.google.error]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
    }
    private var connectedProvidersAreFresh: Bool {
        let providers = [integrations.todoist, integrations.google].filter { $0.connected }
        guard !providers.isEmpty else { return true }
        return providers.allSatisfy { provider in
            guard let value = provider.lastSynced, let date = timestampDate(value) else { return false }
            return Date().timeIntervalSince(date) < 5 * 60
        }
    }
    var busy: Bool { !busyAreas.isEmpty }
    var error: String? {
        let priority: [WorkspaceArea] = [.pairing, .workspace, .integrations, .health, .climbing, .chess, .finance, .writing]
        return priority.compactMap { areaErrors[$0] }.first
    }

    init(credentials suppliedCredentials: BridgeCredentials? = nil, health: HealthStore = HealthStore()) {
        self.health = health
        let restoredLocalState = CompanionPersistence.loadLocalState()
        if let cached = CompanionPersistence.loadSnapshot() {
            snapshotCache = cached
            workspace = cached.workspace ?? .empty
            climbing = cached.climbing ?? .empty
            chess = cached.chess ?? .empty
            integrations = cached.integrations.map(companionPlanningSnapshot) ?? .empty
            snapshotCache.integrations = cached.integrations.map(companionPlanningSnapshot)
            lastSuccessfulContact = cached.lastSuccessfulContact
            if cached.workspace != nil { loadedAreas.insert(.workspace) }
            if cached.climbing != nil { loadedAreas.insert(.climbing) }
            if cached.chess != nil { loadedAreas.insert(.chess) }
            if cached.integrations != nil { loadedAreas.insert(.integrations) }
            if cached.integrations != snapshotCache.integrations {
                try? CompanionPersistence.saveSnapshot(snapshotCache)
            }
        }
        if let suppliedCredentials {
            credentials = suppliedCredentials
            connectionState = loadedAreas.isEmpty ? .connecting : .offlineWithCache
            status = pairingReadyStatus(for: suppliedCredentials)
        } else {
            do {
                credentials = try BridgeKeychain.load()
                if let credentials {
                    connectionState = loadedAreas.isEmpty ? .connecting : .offlineWithCache
                    status = pairingReadyStatus(for: credentials)
                }
            } catch {
                credentials = nil
                connectionState = .error(error.localizedDescription)
                areaErrors[.pairing] = error.localizedDescription
            }
        }
        if let local = restoredLocalState {
            let currentIdentity = credentials?.fingerprint
            if local.pairingIdentity == currentIdentity {
                capturePairingIdentity = local.pairingIdentity
                captureDraft = local.captureDraft
                captureOutbox = local.captureOutbox
                pendingCaptureCount = local.captureOutbox.count
            } else {
                CompanionPersistence.removeLocalState()
            }
        }
    }

    func isLoading(_ area: WorkspaceArea) -> Bool { busyAreas.contains(area) }

    func clearError(_ area: WorkspaceArea? = nil) {
        if let area { areaErrors.removeValue(forKey: area) }
        else { areaErrors.removeAll() }
    }

    func report(_ cause: Error, area: WorkspaceArea) {
        record(cause, area: area)
    }

    func cachedAt(_ area: WorkspaceArea) -> Date? {
        snapshotCache.areaSavedAt[area.rawValue]
    }

    func updateCaptureDraft(_ value: String) {
        guard hasWorkspaceAccess else { return }
        prepareCaptureIdentity()
        captureDraft = value
        localStateSaveTask?.cancel()
        localStateSaveTask = Task { [weak self] in
            do {
                try await Task.sleep(for: .milliseconds(300))
            } catch {
                return
            }
            guard let self else { return }
            self.localStateSaveTask = nil
            _ = self.persistLocalState()
        }
    }

    func persistCaptureState() {
        localStateSaveTask?.cancel()
        localStateSaveTask = nil
        _ = persistLocalState()
    }

    @discardableResult
    func submitCapture(_ text: String) async -> CaptureDisposition? {
        guard hasWorkspaceAccess else {
            record(BridgeError.message("Pair this device with Workspace before saving a Capture."), area: .workspace)
            return nil
        }
        prepareCaptureIdentity()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard trimmed.count <= 2_000 else {
            record(
                BridgeError.message("Keep a Capture under 2,000 characters so it can be saved to Workspace Captures."),
                area: .workspace
            )
            return nil
        }

        var item = WorkspaceItem.new(kind: .note)
        item.title = trimmed
        let entry = CaptureOutboxEntry(requestId: item.id, item: item, createdAt: Date())
        if !captureOutbox.contains(where: { $0.requestId == entry.requestId }) {
            captureOutbox.append(entry)
        }
        localStateSaveTask?.cancel()
        localStateSaveTask = nil
        let retainedDraft = captureDraft
        captureDraft = ""
        pendingCaptureCount = captureOutbox.count
        guard persistLocalState() else {
            captureOutbox.removeAll { $0.requestId == entry.requestId }
            captureDraft = retainedDraft
            pendingCaptureCount = captureOutbox.count
            return nil
        }

        await flushCaptureOutbox()
        return captureOutbox.contains(where: { $0.requestId == entry.requestId }) ? .queued : .delivered
    }

    func flushCaptureOutbox(forceAttempt: Bool = false) async {
        guard hasWorkspaceAccess,
              capturePairingIdentity == credentials?.fingerprint,
              (forceAttempt || connectionState == .online),
              !captureOutbox.isEmpty else { return }
        if !loadedAreas.contains(.workspace) {
            await load(.workspace, force: true)
        }
        guard loadedAreas.contains(.workspace), !busyAreas.contains(.workspace) else { return }

        for entry in Array(captureOutbox) {
            if workspace.items.contains(where: { $0.id == entry.item.id }) {
                removeCaptureOutboxEntry(entry.requestId)
                continue
            }

            if await deliverCapture(entry) {
                removeCaptureOutboxEntry(entry.requestId)
                continue
            }
            break
        }
    }

    private func deliverCapture(_ entry: CaptureOutboxEntry) async -> Bool {
        guard begin(.workspace) else { return false }
        defer { finish(.workspace) }
        guard let client = workspaceClient(area: .workspace) else { return false }

        do {
            let command = WorkspaceRecordCommand(
                requestId: entry.requestId,
                expectedItemRevision: nil,
                change: .upsert(entry.item)
            )
            workspace = try await client.send("v1/workspace/command", input: command)
            workspaceConflict = nil
            workspaceConflictChange = nil
            loadedAreas.insert(.workspace)
            clearRecordedError(.workspace)
            markConnectionSucceeded()
            cacheCurrent(.workspace)
            status = "Saved to Workspace Captures."
            return true
        } catch let bridge as BridgeError where bridge.statusCode == 409 {
            if let latest: WorkspaceState = try? await client.get("v1/workspace") {
                workspace = latest
                loadedAreas.insert(.workspace)
                cacheCurrent(.workspace)
                if latest.items.contains(where: { $0.id == entry.item.id }) {
                    clearRecordedError(.workspace)
                    markConnectionSucceeded()
                    return true
                }
            }
            record(bridge, area: .workspace)
            return false
        } catch {
            recordAutomaticSyncFailure(error, area: .workspace)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    func pair(_ url: URL) async {
        guard !unpairing, busyAreas.isEmpty else {
            record(BridgeError.message("Wait for the current sync or save to finish before changing the Mac pairing."), area: .pairing)
            return
        }
        guard begin(.pairing) else { return }
        defer { finish(.pairing) }
        connectionState = .connecting
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
            guard managesAppleHealth || pairing.scope == .workspace else {
                throw BridgeError.message("Use a Workspace pairing file on this iPad. Health-only pairing is reserved for the iPhone that reads and writes Apple Health.")
            }
            let paired = try await BridgeClient.pair(pairing)
            guard expectedEpoch == pairingEpoch else {
                try? await BridgeClient(paired).revokePairing()
                BridgeKeychain.remove()
                return
            }
            let hasPendingCapture = !captureDraft.isEmpty || !captureOutbox.isEmpty
            let canAdoptUnboundCapture = credentials == nil && capturePairingIdentity == nil
            let canCarrySameMacPairing = credentials?.fingerprint == paired.fingerprint
                && capturePairingIdentity == paired.fingerprint
            let retainedCapture: (draft: String, outbox: [CaptureOutboxEntry])? =
                hasPendingCapture && (canAdoptUnboundCapture || canCarrySameMacPairing)
                    ? (captureDraft, captureOutbox)
                    : nil
            resetWorkspaceState()
            credentials = paired
            if let retainedCapture {
                capturePairingIdentity = paired.fingerprint
                captureDraft = retainedCapture.draft
                captureOutbox = retainedCapture.outbox
                pendingCaptureCount = retainedCapture.outbox.count
                _ = persistLocalState()
            }
            status = paired.scope == .workspace
                ? "Paired. Your Workspace is available while this Mac is awake on the same Wi-Fi."
                : "Paired for Health. Keep both devices on the same Wi-Fi."
            do {
                try await negotiateCapabilities(using: BridgeClient(paired))
                if hasWorkspaceAccess {
                    await loadWorkspaceAreas(force: true)
                    await flushCaptureOutbox(forceAttempt: true)
                }
            } catch {
                record(error, area: .pairing)
                markConnectionFailure(error)
            }
        } catch {
            record(error, area: .pairing)
            markConnectionFailure(error)
        }
    }

    func useCredentials(_ newCredentials: BridgeCredentials?) {
        guard newCredentials != credentials else { return }
        pairingEpoch += 1
        resetWorkspaceState()
        credentials = newCredentials
        connectionState = newCredentials == nil ? .unpaired : .connecting
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
        CompanionPersistence.removeSnapshot()
        connectionState = .unpaired
        let revokingStatus = "This device is unpaired locally. Asking the Mac to revoke its saved token…"
        postUnpairStatus = revokingStatus
        status = revokingStatus
        defer {
            BridgeKeychain.remove()
            credentials = nil
            resetWorkspaceState()
            CompanionPersistence.removeSnapshot()
            connectionState = .unpaired
            postUnpairStatus = completionStatus
            status = completionStatus
            unpairing = false
            if busyAreas.isEmpty { clearAfterUnpair = false }
        }
        guard let savedClient else {
            if hadCredentials {
                completionStatus = "This device is unpaired locally. The Mac did not confirm revocation, so disable companion sync on the Mac to invalidate its saved token."
            }
            return
        }
        do {
            try await savedClient.revokePairing()
        } catch {
            completionStatus = "This device is unpaired locally. The Mac did not confirm revocation, so disable companion sync on the Mac to invalidate its saved token."
        }
    }

    func loadInitial() async {
        guard credentials != nil else {
            connectionState = .unpaired
            return
        }
        guard begin(.pairing) else { return }
        defer { finish(.pairing) }
        lastConnectionAttempt = Date()
        if !hasCachedContent { connectionState = .connecting }
        guard let client = makeClient() else { return }
        do {
            try await negotiateCapabilities(using: client)
        } catch {
            recordAutomaticSyncFailure(error, area: .pairing)
            markConnectionFailure(error)
            return
        }
        guard hasWorkspaceAccess else { return }
        await loadWorkspaceAreas(force: true)
        await refreshIntegrationsIfNeeded()
        await flushCaptureOutbox(forceAttempt: true)
    }

    @discardableResult
    func refreshAll() async -> Bool {
        guard credentials != nil else {
            connectionState = .unpaired
            return false
        }
        guard begin(.pairing) else { return false }
        defer { finish(.pairing) }
        lastConnectionAttempt = Date()
        if !hasCachedContent { connectionState = .connecting }
        guard let client = makeClient() else { return false }
        do {
            try await negotiateCapabilities(using: client)
        } catch {
            recordAutomaticSyncFailure(error, area: .pairing)
            markConnectionFailure(error)
            return false
        }
        guard hasWorkspaceAccess else { return false }
        let areasLoaded = await loadWorkspaceAreas(force: true)
        let providersRefreshed = await refreshIntegrationsIfNeeded()
        var financeRefreshed = true
        var gmailRefreshed = true
        if !managesAppleHealth {
            financeRefreshed = await syncFinance()
            gmailRefreshed = await refreshGmail()
        }
        await flushCaptureOutbox(forceAttempt: true)
        return areasLoaded
            && providersRefreshed
            && financeRefreshed
            && gmailRefreshed
            && integrationProviderError == nil
            && (managesAppleHealth || integrations.gmail.error == nil)
            && captureOutbox.isEmpty
    }

    @discardableResult
    func load(_ area: WorkspaceArea, force: Bool = false) async -> Bool {
        guard area != .pairing else { return true }
        // Health-only pairings use the dedicated Health sync endpoints. The
        // companion-area routes below require a full Workspace token, so
        // treating their absence as one error per tab only adds noise.
        guard hasWorkspaceAccess else { return false }
        if !force, loadedAreas.contains(area) { return true }
        guard begin(area) else { return false }
        defer { finish(area) }
        guard let client = makeClient() else { return false }
        do {
            if area != .health || credentials?.scope == .workspace {
                try await requireWorkspace(using: client)
            }
            switch area {
            case .workspace:
                workspace = try await client.get("v1/workspace")
            case .climbing:
                climbing = try await client.get("v1/climbing")
            case .chess:
                chess = try await client.get("v1/chess")
            case .finance:
                finance = try await client.get("v1/finance")
            case .writing:
                writing = try await client.get("v1/writing")
            case .integrations:
                integrations = try await client.get("v1/integrations")
                if !managesAppleHealth { mailLoadedFromMac = true }
            case .health:
                try await requireWorkspace(using: client)
                let view: PhoneHealthView = try await client.get("v1/health-view")
                try acceptHealthView(view)
            case .pairing:
                return true
            }
            loadedAreas.insert(area)
            clearRecordedError(area)
            markConnectionSucceeded()
            cacheCurrent(area)
            return true
        } catch {
            recordAutomaticSyncFailure(error, area: area)
            markConnectionFailureIfNeeded(error)
            return false
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
            if !managesAppleHealth { mailLoadedFromMac = true }
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            markConnectionSucceeded()
            cacheCurrent(.integrations)
            status = integrationProviderError == nil
                ? "Calendar and Todoist refreshed."
                : "Refresh finished with a provider issue."
            return true
        } catch {
            recordAutomaticSyncFailure(error, area: .integrations)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    @discardableResult
    func refreshIntegrationsIfNeeded(on date: String = WorkspaceFormat.dayKey()) async -> Bool {
        let rangeCoversDate = integrations.range.map { $0.from <= date && date <= $0.to } == true
        guard connectionState == .online else { return rangeCoversDate }
        guard !rangeCoversDate || !connectedProvidersAreFresh else { return true }
        return await refreshIntegrations(on: date)
    }

    @discardableResult
    private func refreshGmail() async -> Bool {
        guard begin(.integrations) else { return false }
        defer { finish(.integrations) }
        guard let client = workspaceClient(area: .integrations) else { return false }
        do {
            integrations = try await client.send("v1/integrations/gmail/sync", input: EmptyBridgeBody())
            mailLoadedFromMac = true
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            markConnectionSucceeded()
            cacheCurrent(.integrations)
            status = integrations.gmail.error == nil ? "Mail refreshed." : "Mail refresh finished with a provider issue."
            return integrations.gmail.error == nil
        } catch {
            recordAutomaticSyncFailure(error, area: .integrations)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    @discardableResult
    private func persistWorkspaceChange(
        _ change: WorkspaceItemChange,
        openingState: WorkspaceState
    ) async -> Bool {
        let existing = openingState.items.first(where: { $0.id == change.itemId })
        let expectedItemRevision: Int?
        let commandChange: WorkspaceItemChange
        switch change {
        case .upsert(let item):
            if existing != nil, existing?.revision == nil {
                reportStaleRow("Workspace item", area: .workspace)
                return false
            }
            expectedItemRevision = existing?.revision
            if existing == nil,
               item.revision != nil,
               let tombstone = openingState.tombstones?.first(where: { $0.id == item.id }) {
                commandChange = .restore(item: item, expectedTombstoneRevision: tombstone.revision)
            } else {
                commandChange = change
            }
        case .restore:
            expectedItemRevision = nil
            commandChange = change
        case .remove, .toggle:
            guard let revision = existing?.revision else {
                reportStaleRow("Workspace item", area: .workspace)
                return false
            }
            expectedItemRevision = revision
            commandChange = change
        }

        guard begin(.workspace) else { return false }
        defer { finish(.workspace) }
        guard let client = workspaceClient(area: .workspace) else { return false }

        let attemptKey = commandChange.attemptKey
        let command: WorkspaceRecordCommand
        if let pending = workspaceRecordAttempts[attemptKey],
           pending.expectedItemRevision == expectedItemRevision,
           pending.change == commandChange {
            command = pending
        } else {
            command = WorkspaceRecordCommand(
                requestId: UUID().uuidString.lowercased(),
                expectedItemRevision: expectedItemRevision,
                change: commandChange
            )
            workspaceRecordAttempts[attemptKey] = command
        }

        do {
            workspace = try await client.send("v1/workspace/command", input: command)
            workspaceRecordAttempts.removeValue(forKey: attemptKey)
            workspaceConflict = nil
            workspaceConflictChange = nil
            loadedAreas.insert(.workspace)
            clearRecordedError(.workspace)
            markConnectionSucceeded()
            cacheCurrent(.workspace)
            status = "Workspace saved."
            return true
        } catch let bridge as BridgeError where bridge.statusCode == 409 {
            let latest: WorkspaceState? = try? await client.get("v1/workspace")
            if let latest {
                workspace = latest
                loadedAreas.insert(.workspace)
                cacheCurrent(.workspace)
                markConnectionSucceeded()
            }

            if let latest, change.isSatisfied(by: latest) {
                workspaceRecordAttempts.removeValue(forKey: attemptKey)
                workspaceConflict = nil
                workspaceConflictChange = nil
                clearRecordedError(.workspace)
                status = "Workspace saved."
                return true
            }

            let isRevisionConflict = bridge.responseCode != "store_busy"
            if isRevisionConflict {
                let savedLatest = latest ?? workspace
                let retainedDraft = change.applying(to: savedLatest)
                workspace = savedLatest
                cacheCurrent(.workspace)
                workspaceConflict = RevisionConflict(draft: retainedDraft, latest: savedLatest, message: bridge.localizedDescription)
                workspaceConflictChange = change
                workspaceRecordAttempts.removeValue(forKey: attemptKey)
            }
            record(bridge, area: .workspace)
            return false
        } catch {
            record(error, area: .workspace)
            markConnectionFailureIfNeeded(error)
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
        return await persistWorkspaceChange(change, openingState: base)
    }

    @discardableResult
    func removeWorkspaceItem(id: String, openingState: WorkspaceState? = nil) async -> Bool {
        guard allowWorkspaceMutation() else { return false }
        if !loadedAreas.contains(.workspace) { await load(.workspace) }
        guard loadedAreas.contains(.workspace) else { return false }
        let change = WorkspaceItemChange.remove(id)
        let base = openingState ?? workspace
        return await persistWorkspaceChange(change, openingState: base)
    }

    @discardableResult
    func toggleWorkspaceItem(id: String) async -> Bool {
        guard allowWorkspaceMutation() else { return false }
        if !loadedAreas.contains(.workspace) { await load(.workspace) }
        guard loadedAreas.contains(.workspace),
              let item = workspace.items.first(where: { $0.id == id }) else { return false }
        let base = workspace
        let change = WorkspaceItemChange.toggle(id: id, done: !item.done)
        return await persistWorkspaceChange(change, openingState: base)
    }

    @discardableResult
    func retryWorkspaceConflict() async -> Bool {
        guard let conflict = workspaceConflict,
              let change = workspaceConflictChange else { return false }
        return await persistWorkspaceChange(change, openingState: conflict.latest)
    }

    func discardWorkspaceConflict() {
        if let change = workspaceConflictChange {
            workspaceRecordAttempts = workspaceRecordAttempts.filter { _, command in
                command.change.itemId != change.itemId
            }
        }
        workspaceConflict = nil
        workspaceConflictChange = nil
    }

    @discardableResult
    private func persistClimbingChanges(
        _ changes: [ClimbingRecordChange]
    ) async -> Bool {
        guard !changes.isEmpty else { return true }
        guard begin(.climbing) else { return false }
        defer { finish(.climbing) }
        guard let client = workspaceClient(area: .climbing) else { return false }

        let attemptKey = changes.map(\.recordKey).sorted().joined(separator: "|")
        let command: ClimbingRecordCommand
        if let pending = climbingRecordAttempts[attemptKey],
           pending.changes.count == changes.count,
           zip(pending.changes, changes).allSatisfy({ pair in
               pair.0.isRetryEquivalent(to: pair.1)
           }) {
            command = pending
        } else {
            command = ClimbingRecordCommand(
                requestId: UUID().uuidString.lowercased(),
                changes: changes
            )
            climbingRecordAttempts[attemptKey] = command
        }

        do {
            climbing = try await client.send("v1/climbing/command", input: command)
            climbingRecordAttempts.removeValue(forKey: attemptKey)
            climbingConflict = nil
            loadedAreas.insert(.climbing)
            clearRecordedError(.climbing)
            markConnectionSucceeded()
            cacheCurrent(.climbing)
            status = "Climbing saved."
            return true
        } catch let bridge as BridgeError where bridge.statusCode == 409 {
            let latest: ClimbingState? = try? await client.get("v1/climbing")
            if let latest {
                climbing = latest
                loadedAreas.insert(.climbing)
                cacheCurrent(.climbing)
                markConnectionSucceeded()
            }

            if let latest, command.changes.allSatisfy({ $0.isSatisfied(by: latest) }) {
                climbingRecordAttempts.removeValue(forKey: attemptKey)
                climbingConflict = nil
                clearRecordedError(.climbing)
                status = "Climbing saved."
                return true
            }

            let isRevisionConflict = bridge.responseCode != "store_busy"
            if isRevisionConflict {
                let savedLatest = latest ?? climbing
                let retainedDraft = command.changes.reduce(savedLatest) { result, change in
                    change.applying(to: result)
                }
                climbing = savedLatest
                cacheCurrent(.climbing)
                climbingConflict = RevisionConflict(draft: retainedDraft, latest: savedLatest, message: bridge.localizedDescription)
                climbingRecordAttempts.removeValue(forKey: attemptKey)
            }
            record(bridge, area: .climbing)
            return false
        } catch {
            record(error, area: .climbing)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    @discardableResult
    func upsertClimbingSession(
        _ session: ClimbingSession,
        openingState: ClimbingState,
        markLinkedPlanLogged: Bool
    ) async -> Bool {
        let expectedSessionUpdate = openingState.sessions.first(where: { $0.id == session.id })?.updatedAt
        var changes: [ClimbingRecordChange] = [
            .session(expectedUpdatedAt: expectedSessionUpdate, value: session)
        ]
        if markLinkedPlanLogged,
           let planId = session.planId,
           var linkedPlan = openingState.plans.first(where: { $0.id == planId }) {
            let expectedPlanUpdate = linkedPlan.updatedAt
            linkedPlan.status = .logged
            linkedPlan.sessionId = session.id
            linkedPlan.updatedAt = session.updatedAt
            changes.append(.plan(expectedUpdatedAt: expectedPlanUpdate, value: linkedPlan))
        }
        return await persistClimbingChanges(changes)
    }

    @discardableResult
    func upsertClimbingPlan(_ plan: ClimbingPlan, openingState: ClimbingState) async -> Bool {
        let expectedUpdate = openingState.plans.first(where: { $0.id == plan.id })?.updatedAt
        return await persistClimbingChanges([.plan(expectedUpdatedAt: expectedUpdate, value: plan)])
    }

    @discardableResult
    func upsertClimbingGoal(_ goal: ClimbingGoal, openingState: ClimbingState) async -> Bool {
        let expectedUpdate = openingState.goals.first(where: { $0.id == goal.id })?.updatedAt
        return await persistClimbingChanges([.goal(expectedUpdatedAt: expectedUpdate, value: goal)])
    }

    @discardableResult
    func addClimbingGoalLink(_ reference: ClimbingGoalReference) async -> Bool {
        guard reference.kind == .link,
              validMediaIdentifier(reference.id),
              validMediaIdentifier(reference.goalId),
              validMediaText(reference.label, maxUTF16Units: 160),
              validMediaText(reference.url, maxUTF16Units: 2_048) else {
            record(BridgeError.message("Enter a valid goal reference."), area: .climbing)
            return false
        }
        guard climbing.goalReferences.filter({ $0.goalId == reference.goalId }).count < 12 else {
            record(BridgeError.message("This goal already has 12 references. Remove one before adding another."), area: .climbing)
            return false
        }
        guard climbingConflict == nil else {
            record(BridgeError.message("Resolve the saved Climbing conflict before adding a reference."), area: .climbing)
            return false
        }
        guard begin(.climbing) else { return false }
        defer { finish(.climbing) }
        guard let client = workspaceClient(area: .climbing) else { return false }

        let command = ClimbingMediaLinkCommand(
            requestId: UUID().uuidString.lowercased(),
            reference: reference
        )
        do {
            let latest: ClimbingState = try await client.send("v1/climbing/media/link", input: command)
            applyClimbingMediaResult(latest, status: "Reference added.")
            return true
        } catch {
            if await reconcileClimbingMedia(using: client, referenceId: reference.id, shouldExist: true) {
                status = "Reference added."
                return true
            }
            record(error, area: .climbing)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    @discardableResult
    func uploadClimbingGoalMedia(
        goalId: String,
        referenceId: String,
        requestId: String,
        label: String,
        fileName: String,
        contentType: String,
        file: URL
    ) async -> Bool {
        guard validMediaIdentifier(goalId),
              validMediaIdentifier(referenceId),
              validMediaIdentifier(requestId),
              validMediaText(label, maxUTF16Units: 160),
              validMediaText(fileName, maxUTF16Units: 240),
              contentType == "application/octet-stream"
                || contentType.hasPrefix("image/")
                || contentType.hasPrefix("video/") else {
            record(BridgeError.message("The selected goal attachment is invalid."), area: .climbing)
            return false
        }
        guard climbing.goalReferences.filter({ $0.goalId == goalId }).count < 12 else {
            record(BridgeError.message("This goal already has 12 references. Remove one before adding another."), area: .climbing)
            return false
        }
        guard climbingConflict == nil else {
            record(BridgeError.message("Resolve the saved Climbing conflict before adding an attachment."), area: .climbing)
            return false
        }
        do {
            let values = try file.resourceValues(forKeys: [.fileSizeKey])
            guard let byteCount = values.fileSize,
                  byteCount > 0,
                  byteCount <= BridgeClient.maximumMediaBytes else {
                throw BridgeError.message("Choose a photo or video smaller than 200 MB.")
            }
        } catch {
            record(error, area: .climbing)
            return false
        }
        guard begin(.climbing) else { return false }
        defer { finish(.climbing) }
        guard let client = workspaceClient(area: .climbing) else { return false }

        let headers = [
            "X-Workspace-Request-Id": requestId,
            "X-Workspace-Reference-Id": referenceId,
            "X-Workspace-Goal-Id": goalId,
            "X-Workspace-File-Name": encodeURIComponent(fileName),
            "X-Workspace-Label": encodeURIComponent(label),
        ]
        do {
            let latest: ClimbingState = try await client.upload(
                "v1/climbing/media/upload",
                file: file,
                contentType: contentType,
                headers: headers
            )
            applyClimbingMediaResult(latest, status: "Attachment added.")
            return true
        } catch {
            if Task.isCancelled || bridgeOperationWasCancelled(error) { return false }
            if await reconcileClimbingMedia(using: client, referenceId: referenceId, shouldExist: true) {
                status = "Attachment added."
                return true
            }
            record(error, area: .climbing)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    @discardableResult
    func deleteClimbingGoalReference(_ reference: ClimbingGoalReference) async -> Bool {
        guard validMediaIdentifier(reference.id), validMediaIdentifier(reference.goalId) else {
            record(BridgeError.message("This goal reference is invalid."), area: .climbing)
            return false
        }
        guard climbingConflict == nil else {
            record(BridgeError.message("Resolve the saved Climbing conflict before removing a reference."), area: .climbing)
            return false
        }
        guard begin(.climbing) else { return false }
        defer { finish(.climbing) }
        guard let client = workspaceClient(area: .climbing) else { return false }

        let command = ClimbingMediaDeleteCommand(
            requestId: UUID().uuidString.lowercased(),
            goalId: reference.goalId,
            referenceId: reference.id
        )
        do {
            let latest: ClimbingState = try await client.send("v1/climbing/media/delete", input: command)
            applyClimbingMediaResult(latest, status: "Reference removed.")
            return true
        } catch {
            if await reconcileClimbingMedia(using: client, referenceId: reference.id, shouldExist: false) {
                status = "Reference removed."
                return true
            }
            record(error, area: .climbing)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    func downloadClimbingGoalReference(_ reference: ClimbingGoalReference) async -> URL? {
        guard reference.kind != .link,
              validMediaIdentifier(reference.id),
              validMediaIdentifier(reference.goalId) else {
            record(BridgeError.message("This goal attachment is invalid."), area: .climbing)
            return nil
        }
        guard !unpairing else { return nil }
        let expectedEpoch = pairingEpoch
        guard let client = workspaceClient(area: .climbing) else { return nil }

        let displayFileExtension = reference.fileName.flatMap { name in
            let value = URL(fileURLWithPath: name).pathExtension
            return validMediaText(value) ? value : nil
        }
        let fileExtension = reference.mimeType.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension }
            ?? displayFileExtension
        do {
            let file = try await client.download(
                "v1/climbing/media/\(reference.id)",
                fileExtension: fileExtension
            )
            guard expectedEpoch == pairingEpoch, credentials != nil, !Task.isCancelled else {
                try? FileManager.default.removeItem(at: file)
                return nil
            }
            clearRecordedError(.climbing)
            markConnectionSucceeded()
            return file
        } catch {
            if Task.isCancelled || bridgeOperationWasCancelled(error) { return nil }
            record(error, area: .climbing)
            markConnectionFailureIfNeeded(error)
            return nil
        }
    }

    @discardableResult
    func upsertClimbingRoutine(_ routine: ClimbingRoutine, openingState: ClimbingState) async -> Bool {
        let expectedUpdate = openingState.routines.first(where: { $0.id == routine.id })?.updatedAt
        return await persistClimbingChanges([.routine(expectedUpdatedAt: expectedUpdate, value: routine)])
    }

    func discardClimbingConflict() { climbingConflict = nil }

    private func validMediaIdentifier(_ value: String) -> Bool {
        UUID(uuidString: value) != nil
    }

    private func validMediaText(_ value: String?, maxUTF16Units: Int? = nil) -> Bool {
        guard let value,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return maxUTF16Units.map { value.utf16.count <= $0 } ?? true
    }

    private func bridgeOperationWasCancelled(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }

    private func encodeURIComponent(_ value: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    private func applyClimbingMediaResult(_ latest: ClimbingState, status message: String) {
        climbing = latest
        loadedAreas.insert(.climbing)
        clearRecordedError(.climbing)
        markConnectionSucceeded()
        cacheCurrent(.climbing)
        status = message
    }

    private func reconcileClimbingMedia(
        using client: BridgeClient,
        referenceId: String,
        shouldExist: Bool
    ) async -> Bool {
        guard let latest: ClimbingState = try? await client.get("v1/climbing") else { return false }
        let exists = latest.goalReferences.contains { $0.id == referenceId }
        guard exists == shouldExist else { return false }
        applyClimbingMediaResult(latest, status: shouldExist ? "Reference added." : "Reference removed.")
        return true
    }

    @discardableResult
    func saveChessProgress(_ request: ChessProgressRequest) async -> Bool {
        guard begin(.chess) else { return false }
        defer { finish(.chess) }
        guard let client = workspaceClient(area: .chess) else { return false }
        chessProgressNeedsRebase = false
        do {
            let response: ChessProgressResponse = try await client.send("v1/chess/progress", input: request)
            chess = response.view
            loadedAreas.insert(.chess)
            clearRecordedError(.chess)
            markConnectionSucceeded()
            cacheCurrent(.chess)
            status = "Chess progress saved."
            return true
        } catch let bridge as BridgeError {
            if bridge.statusCode == 409,
               ["revision_conflict", "request_id_conflict"].contains(bridge.responseCode ?? ""),
               let latest = try? await client.get("v1/chess") as ChessView {
                chess = latest
                loadedAreas.insert(.chess)
                cacheCurrent(.chess)
                chessProgressNeedsRebase = true
            }
            record(bridge, area: .chess)
            markConnectionFailureIfNeeded(bridge)
            return false
        } catch {
            record(error, area: .chess)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    func submitChessReview(_ request: ChessReviewRequest) async -> ChessReviewResult? {
        guard begin(.chess) else { return nil }
        defer { finish(.chess) }
        guard let client = workspaceClient(area: .chess) else { return nil }
        chessReviewCanChangeAnswer = false
        chessReviewNoLongerDue = false
        do {
            let response: ChessReviewResponse = try await client.send("v1/chess/review", input: request)
            chess = response.view
            loadedAreas.insert(.chess)
            clearRecordedError(.chess)
            markConnectionSucceeded()
            cacheCurrent(.chess)
            status = response.result.grade == .good ? "Chess review complete." : "Chess review saved for another look."
            return response.result
        } catch let bridge as BridgeError {
            if bridge.responseCode == "review_not_due" {
                if let latest = try? await client.get("v1/chess") as ChessView {
                    chess = latest
                    loadedAreas.insert(.chess)
                    cacheCurrent(.chess)
                }
                chessReviewNoLongerDue = true
            } else if let status = bridge.statusCode,
               (400..<500).contains(status),
               ![408, 423, 429].contains(status) {
                // These responses prove the review was not saved. A transport
                // failure remains locked to the original request for safe replay.
                chessReviewCanChangeAnswer = true
                if bridge.responseCode == "revision_conflict",
                   let latest = try? await client.get("v1/chess") as ChessView {
                    chess = latest
                    loadedAreas.insert(.chess)
                    cacheCurrent(.chess)
                }
            }
            record(bridge, area: .chess)
            markConnectionFailureIfNeeded(bridge)
            return nil
        } catch {
            record(error, area: .chess)
            markConnectionFailureIfNeeded(error)
            return nil
        }
    }

    func saveChessSession(_ request: ChessSessionRequest) async -> ChessStudySession? {
        guard begin(.chess) else { return nil }
        defer { finish(.chess) }
        guard let client = workspaceClient(area: .chess) else { return nil }
        chessSessionNeedsRebase = false
        do {
            let response: ChessSessionResponse = try await client.send("v1/chess/session", input: request)
            chess = response.view
            loadedAreas.insert(.chess)
            clearRecordedError(.chess)
            markConnectionSucceeded()
            cacheCurrent(.chess)
            status = "Chess study session saved."
            return response.session
        } catch let bridge as BridgeError {
            if bridge.statusCode == 409,
               ["revision_conflict", "request_id_conflict"].contains(bridge.responseCode ?? ""),
               let latest = try? await client.get("v1/chess") as ChessView {
                chess = latest
                loadedAreas.insert(.chess)
                cacheCurrent(.chess)
                chessSessionNeedsRebase = true
            }
            record(bridge, area: .chess)
            markConnectionFailureIfNeeded(bridge)
            return nil
        } catch {
            record(error, area: .chess)
            markConnectionFailureIfNeeded(error)
            return nil
        }
    }

    func changeChessReviewAnswer() {
        chessReviewCanChangeAnswer = false
        clearRecordedError(.chess)
    }

    func dismissStaleChessReview() {
        chessReviewNoLongerDue = false
        chessReviewCanChangeAnswer = false
        clearRecordedError(.chess)
    }

    func prepareRebasedChessProgress() {
        chessProgressNeedsRebase = false
        clearRecordedError(.chess)
    }

    func prepareRebasedChessSession() {
        chessSessionNeedsRebase = false
        clearRecordedError(.chess)
    }

    func reportStaleRow(_ noun: String, area: WorkspaceArea) {
        record(
            BridgeError.message("This \(noun) changed or was removed on your Mac. Refresh from Settings, then try again."),
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
            markConnectionSucceeded()
            status = "Writing draft saved."
            return true
        } catch {
            record(error, area: .writing)
            markConnectionFailureIfNeeded(error)
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
            markConnectionSucceeded()
            status = "Finances refreshed."
            return true
        } catch {
            record(error, area: .finance)
            markConnectionFailureIfNeeded(error)
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
            markConnectionSucceeded()
            status = "Transaction notes saved."
            return true
        } catch {
            record(error, area: .finance)
            markConnectionFailureIfNeeded(error)
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
            if !managesAppleHealth { mailLoadedFromMac = true }
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            markConnectionSucceeded()
            cacheCurrent(.integrations)
            status = mutation.provider == .google ? "Calendar updated." : "Todoist updated."
            return true
        } catch {
            record(error, area: .integrations)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    @discardableResult
    func mutateGmail(_ mutation: GmailMutationRequest) async -> Bool {
        guard begin(.integrations) else { return false }
        defer { finish(.integrations) }
        guard let client = workspaceClient(area: .integrations) else { return false }
        do {
            integrations = try await client.send("v1/integrations/gmail/mutate", input: mutation)
            mailLoadedFromMac = true
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            markConnectionSucceeded()
            cacheCurrent(.integrations)
            switch mutation.action {
            case .read: status = "Message marked read."
            case .unread: status = "Message marked unread."
            case .star: status = "Message starred."
            case .unstar: status = "Star removed."
            case .archive: status = "Message archived."
            case .trash: status = "Message moved to Trash."
            }
            return true
        } catch {
            record(error, area: .integrations)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    @discardableResult
    func sendGmail(_ message: GmailSendRequest) async -> Bool {
        guard begin(.integrations) else { return false }
        defer { finish(.integrations) }
        guard let client = workspaceClient(area: .integrations) else { return false }
        do {
            integrations = try await client.send("v1/integrations/gmail/send", input: message)
            mailLoadedFromMac = true
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            markConnectionSucceeded()
            cacheCurrent(.integrations)
            status = message.replyToId == nil ? "Email sent." : "Reply sent."
            return true
        } catch {
            record(error, area: .integrations)
            markConnectionFailureIfNeeded(error)
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
            if !managesAppleHealth { mailLoadedFromMac = true }
            loadedAreas.insert(.integrations)
            clearRecordedError(.integrations)
            markConnectionSucceeded()
            cacheCurrent(.integrations)
            status = "The local connection link was forgotten."
            return true
        } catch {
            record(error, area: .integrations)
            markConnectionFailureIfNeeded(error)
            return false
        }
    }

    func authorizeHealth() async {
        guard requireAppleHealthOwner() else { return }
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

    @discardableResult
    func syncHealth() async -> Bool {
        guard requireAppleHealthOwner() else { return false }
        guard begin(.health) else { return false }
        defer { finish(.health) }
        do {
            health.refreshCalendar()
            let snapshot = try await health.snapshot()
            healthSnapshot = snapshot
            dayCount = snapshot.days.count
            status = "Health summary updated on this iPhone."

            guard let credentials else {
                clearRecordedError(.health)
                status = "Health summary updated on this iPhone. Pair with your Mac to sync it."
                return true
            }
            guard connectionState == .online else {
                clearRecordedError(.health)
                status = "Health summary updated on this iPhone. It will sync when your Mac is available."
                return false
            }
            guard let client = makeClient() else { return false }

            do {
                let _: SavedBridgeResponse = try await client.call("snapshot", body: bridgeEncoder().encode(snapshot))

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
                if hasWorkspaceAccess, let view: PhoneHealthView = try? await client.get("v1/health-view") {
                    try acceptHealthView(view)
                    loadedAreas.insert(.health)
                }
                clearRecordedError(.health)
                markConnectionSucceeded()
                status = "Synced at \(Date().formatted(date: .omitted, time: .shortened))."
                return true
            } catch {
                recordAutomaticSyncFailure(error, area: .health)
                markConnectionFailureIfNeeded(error)
                status = "Health summary updated on this iPhone. Mac sync will retry when reachable."
                return false
            }
        } catch {
            record(error, area: .health)
            return false
        }
    }

    func importHealthHistory(from requested: Date) async {
        guard requireAppleHealthOwner() else { return }
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
        guard requireAppleHealthOwner() else { return }
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
    func sync() async { _ = await syncHealth() }
    func importHistory(from date: Date) async { await importHealthHistory(from: date) }
    func save(_ command: WeightCommand) async { await confirmWeight(command) }

    private func begin(_ area: WorkspaceArea) -> Bool {
        guard !unpairing, !busyAreas.contains(area) else { return false }
        busyAreas.insert(area)
        areaErrors.removeValue(forKey: area)
        return true
    }

    private func requireAppleHealthOwner() -> Bool {
        guard managesAppleHealth else {
            commands = []
            status = HealthStore.unavailableMessage
            return false
        }
        return true
    }

    private func pairingReadyStatus(for credentials: BridgeCredentials) -> String {
        if credentials.scope == .workspace {
            return "Ready to load your workspace from the Mac."
        }
        return managesAppleHealth
            ? "Ready to sync Health with your Mac."
            : "This iPad needs a Workspace pairing file. Apple Health sync stays on your iPhone."
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

    private func removeCaptureOutboxEntry(_ requestId: String) {
        captureOutbox.removeAll { $0.requestId == requestId }
        pendingCaptureCount = captureOutbox.count
        _ = persistLocalState()
    }

    private func prepareCaptureIdentity() {
        let currentIdentity = credentials?.fingerprint
        guard capturePairingIdentity != currentIdentity else { return }
        clearCaptureState()
        capturePairingIdentity = currentIdentity
    }

    private func clearCaptureState() {
        localStateSaveTask?.cancel()
        localStateSaveTask = nil
        capturePairingIdentity = nil
        captureDraft = ""
        captureOutbox = []
        pendingCaptureCount = 0
        CompanionPersistence.removeLocalState()
    }

    @discardableResult
    private func persistLocalState() -> Bool {
        prepareCaptureIdentity()
        let value = CompanionLocalState(
            pairingIdentity: capturePairingIdentity,
            captureDraft: captureDraft,
            captureOutbox: captureOutbox
        )
        do {
            try CompanionPersistence.saveLocalState(value)
            if areaErrors[.workspace] == capturePersistenceError {
                areaErrors.removeValue(forKey: .workspace)
            }
            return true
        } catch {
            record(
                BridgeError.message(capturePersistenceError),
                area: .workspace
            )
            return false
        }
    }

    private func cacheCurrent(_ area: WorkspaceArea) {
        switch area {
        case .workspace:
            snapshotCache.workspace = workspace
        case .climbing:
            snapshotCache.climbing = climbing
        case .chess:
            snapshotCache.chess = chess
        case .integrations:
            snapshotCache.integrations = companionPlanningSnapshot(integrations)
        case .health, .finance, .writing, .pairing:
            return
        }
        let now = Date()
        snapshotCache.savedAt = now
        snapshotCache.areaSavedAt[area.rawValue] = now
        try? CompanionPersistence.saveSnapshot(snapshotCache)
    }

    private func markConnectionSucceeded() {
        let now = Date()
        connectionState = .online
        lastSuccessfulContact = now
        snapshotCache.lastSuccessfulContact = now
        snapshotCache.savedAt = now
        try? CompanionPersistence.saveSnapshot(snapshotCache)
    }

    private func markConnectionFailure(_ cause: Error) {
        if let bridge = cause as? BridgeError,
           let status = bridge.statusCode,
           status == 401 || status == 403 {
            connectionState = .error(cause.localizedDescription)
        } else if isExpectedMacAbsence(cause), hasCachedContent || healthSnapshot != nil {
            connectionState = .offlineWithCache
        } else {
            connectionState = .error(cause.localizedDescription)
        }
    }

    private func markConnectionFailureIfNeeded(_ cause: Error) {
        if cause is URLError {
            markConnectionFailure(cause)
            return
        }
        if let bridge = cause as? BridgeError,
           let status = bridge.statusCode,
           status == 401 || status == 403 || status >= 500 {
            markConnectionFailure(cause)
        }
    }

    private func timestampDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }

    private func makeClient() -> BridgeClient? {
        guard let credentials else {
            record(BridgeError.message("Pair this device with your Mac first."), area: .pairing)
            return nil
        }
        do {
            return try BridgeClient(credentials)
        } catch {
            record(error, area: .pairing)
            connectionState = .error(error.localizedDescription)
            return nil
        }
    }

    private func workspaceClient(area: WorkspaceArea) -> BridgeClient? {
        guard let client = makeClient() else { return nil }
        guard hasWorkspaceAccess else {
            record(BridgeError.message("Pair again with a Workspace pairing file to use this area."), area: area)
            return nil
        }
        guard connectionState == .online else {
            record(
                BridgeError.message("Sync with your Mac from Settings before making this change."),
                area: area
            )
            return nil
        }
        return client
    }

    private func negotiateCapabilities(using client: BridgeClient) async throws {
        let value = try await client.negotiateCapabilities()
        if managesAppleHealth {
            guard value.health else {
                throw BridgeError.message("Pair this iPhone again so it can manage Apple Health sync.")
            }
        } else {
            guard value.workspace else {
                throw BridgeError.message("Pair this iPad again with a Workspace pairing file.")
            }
        }
        if let deviceClass = value.deviceClass {
            let expected: BridgeDeviceClass = managesAppleHealth ? .phone : .tablet
            guard deviceClass == expected else {
                throw BridgeError.message("Pair this device again so the Mac can grant the correct companion access.")
            }
        }
        capabilities = value
        if var credentials, credentials.scope != value.scope {
            credentials.scope = value.scope
            try BridgeKeychain.save(credentials)
            self.credentials = credentials
        }
        clearRecordedError(.pairing)
        markConnectionSucceeded()
    }

    private func requireWorkspace(using client: BridgeClient) async throws {
        if capabilities == nil { try await negotiateCapabilities(using: client) }
        guard capabilities?.workspace == true else {
            throw BridgeError.message("This device is paired for Health only. Pair again with a Workspace pairing file.")
        }
    }

    private func clearRecordedError(_ area: WorkspaceArea) {
        areaErrors.removeValue(forKey: area)
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
    }

    private func recordAutomaticSyncFailure(_ cause: Error, area: WorkspaceArea) {
        guard !isExpectedMacAbsence(cause) || (!hasCachedContent && healthSnapshot == nil) else {
            return
        }
        record(cause, area: area)
    }

    private func isExpectedMacAbsence(_ cause: Error) -> Bool {
        let error = cause as NSError
        guard error.domain == NSURLErrorDomain else { return false }
        switch URLError.Code(rawValue: error.code) {
        case .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .networkConnectionLost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .internationalRoamingOff,
             .callIsActive,
             .dataNotAllowed:
            return true
        default:
            return false
        }
    }

    @discardableResult
    private func loadWorkspaceAreas(force: Bool = false) async -> Bool {
        var loadedEveryArea = true
        var areas = [WorkspaceArea.workspace, .climbing, .chess, .integrations, .health]
        if !managesAppleHealth { areas.append(.writing) }
        for area in areas {
            if !(await load(area, force: force)) {
                loadedEveryArea = false
            }
        }
        return loadedEveryArea
    }

    private func acceptHealthView(_ view: PhoneHealthView) throws {
        guard managesAppleHealth else {
            healthView = view
            commands = []
            return
        }
        var review: [WeightCommand] = []
        for command in view.commands {
            if let receipt = credentials?.receipts[command.id] {
                guard receipt == command.payloadHash else {
                    throw BridgeError.message("A health request changed after it was saved. Check the Mac’s health queue.")
                }
            } else {
                review.append(command)
            }
        }
        healthView = view
        commands = review
    }

    private func resetWorkspaceState() {
        clearCaptureState()
        capabilities = nil
        workspace = .empty
        climbing = .empty
        chess = .empty
        finance = .empty
        writing = .empty
        integrations = .empty
        healthView = nil
        healthSnapshot = nil
        mailLoadedFromMac = false
        snapshotCache = CompanionSnapshotCache()
        lastSuccessfulContact = nil
        CompanionPersistence.removeSnapshot()
        commands = []
        dayCount = 0
        sleepStatus = "Sleep history has not been imported in this session."
        cancelHistoryRequested = true
        workspaceConflict = nil
        workspaceConflictChange = nil
        climbingConflict = nil
        workspaceRecordAttempts = [:]
        climbingRecordAttempts = [:]
        chessProgressNeedsRebase = false
        chessReviewCanChangeAnswer = false
        chessReviewNoLongerDue = false
        chessSessionNeedsRebase = false
        loadedAreas = []
        areaErrors = [:]
    }
}
