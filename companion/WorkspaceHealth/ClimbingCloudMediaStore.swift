@preconcurrency import CloudKit
import CryptoKit
import Foundation
import UniformTypeIdentifiers

enum ClimbingCloudLedgerOperation: String, Codable, Sendable {
    case upload
    case delete
}

enum ClimbingCloudLedgerStatus: String, Codable, Sendable {
    case pending
    case confirmed
    case error
}

struct ClimbingCloudLedgerError: Codable, Sendable {
    let code: String
    let message: String
    let at: String?

    init(code: String, message: String, at: String? = nil) {
        self.code = code
        self.message = message
        self.at = at
    }
}

struct ClimbingCloudLedgerItem: Codable, Identifiable, Sendable {
    let referenceId: String
    let goalId: String
    let operation: ClimbingCloudLedgerOperation
    let status: ClimbingCloudLedgerStatus
    let sha256: String
    let byteSize: Int
    let requestedAt: String
    let updatedAt: String
    let confirmedAt: String?
    let error: ClimbingCloudLedgerError?

    var id: String { referenceId }
}

struct ClimbingCloudLedger: Codable, Sendable {
    let version: Int
    let revision: Int
    let items: [ClimbingCloudLedgerItem]
}

struct ClimbingCloudReceipt: Encodable, Sendable {
    let requestId: String
    let referenceId: String
    let operation: ClimbingCloudLedgerOperation
    let status: ClimbingCloudLedgerStatus
    let sha256: String
    let byteSize: Int
    let error: ClimbingCloudLedgerError?

    private enum CodingKeys: String, CodingKey {
        case requestId, referenceId, operation, status, sha256, byteSize, error
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(requestId, forKey: .requestId)
        try values.encode(referenceId, forKey: .referenceId)
        try values.encode(operation, forKey: .operation)
        try values.encode(status, forKey: .status)
        try values.encode(sha256, forKey: .sha256)
        try values.encode(byteSize, forKey: .byteSize)
        if let error {
            try values.encode(error, forKey: .error)
        } else {
            try values.encodeNil(forKey: .error)
        }
    }
}

struct ClimbingCloudSyncProgress: Equatable, Sendable {
    let completed: Int
    let total: Int
    let message: String

    var fraction: Double {
        guard total > 0 else { return 0 }
        return Double(completed) / Double(total)
    }
}

struct ClimbingCloudSyncPreflight: Equatable, Sendable {
    let ledgerRevision: Int
    let cloudAccountIdentityDigest: String
    let fileCount: Int
    let byteCount: Int64
    let deletionCount: Int
    let alreadyAvailableCount: Int
}

enum ClimbingCloudAccountState: Equatable, Sendable {
    case notChecked
    case checking
    case available
    case noAccount
    case restricted
    case temporarilyUnavailable
    case unavailable(String)

    var canSync: Bool {
        self == .available
    }

    var label: String {
        switch self {
        case .notChecked: "Not checked"
        case .checking: "Checking…"
        case .available: "Ready"
        case .noAccount: "Sign in to iCloud"
        case .restricted: "Restricted on this device"
        case .temporarilyUnavailable: "Temporarily unavailable"
        case .unavailable: "Unavailable"
        }
    }

    var guidance: String? {
        switch self {
        case .notChecked, .checking, .available:
            nil
        case .noAccount:
            "Sign in to your Apple Account in Settings to use private climbing-media sync."
        case .restricted:
            "This device’s account or management settings do not allow private iCloud data."
        case .temporarilyUnavailable:
            "iCloud is signed in but is not ready. Check your Apple Account in Settings and try again."
        case .unavailable(let message):
            message
        }
    }
}

struct ClimbingCloudMediaMetadata: Sendable {
    let referenceID: String
    let goalID: String
    let kind: ClimbingGoalReferenceKind
    let label: String
    let fileName: String?
    let mimeType: String?
    let byteSize: Int
    let sha256: String
    let createdAt: String

    func matches(_ reference: ClimbingGoalReference) -> Bool {
        guard reference.id == referenceID,
              reference.goalId == goalID,
              reference.kind == kind,
              reference.kind == .image || reference.kind == .video,
              reference.label == label,
              reference.fileName == fileName,
              reference.mimeType?.lowercased() == mimeType?.lowercased(),
              reference.createdAt == createdAt else { return false }
        return reference.byteSize.map { $0 == byteSize } ?? true
    }
}

enum ClimbingCloudRecordState: Sendable {
    case active(ClimbingCloudMediaMetadata)
    case tombstone
    case invalid

    var isActive: Bool {
        if case .active = self { return true }
        return false
    }
}

enum ClimbingCloudFetchResult: Sendable {
    case missing
    case stale
    case downloaded(ClimbingCloudDownloadedAsset)
}

struct ClimbingCloudDownloadedAsset: Sendable {
    let fileURL: URL
    let sha256: String
    let byteSize: Int
}

actor ClimbingCloudMediaStore {
    static let containerIdentifier = "iCloud.com.jordburg.workspace"
    static let zoneName = "ClimbingMedia"
    static let recordType = "ClimbingMediaReference"

    private enum Field {
        static let schemaVersion = "schemaVersion"
        static let goalID = "goalId"
        static let kind = "kind"
        static let label = "label"
        static let fileName = "fileName"
        static let mimeType = "mimeType"
        static let byteSize = "byteSize"
        static let sha256 = "sha256"
        static let createdAt = "createdAt"
        static let state = "state"
        static let deletedAt = "deletedAt"
        static let mirroredAt = "mirroredAt"
        static let asset = "asset"

        static let metadataKeys = [
            schemaVersion, goalID, kind, label, fileName, mimeType, byteSize,
            sha256, createdAt, state, deletedAt, mirroredAt,
        ]
        static let downloadKeys = metadataKeys + [asset]
    }

    private enum RecordState {
        static let active = "active"
        static let tombstone = "tombstone"
    }

    private let container: CKContainer?
    private let database: CKDatabase?
    private let zoneID: CKRecordZone.ID
    private let isEnabled: Bool

    init(
        containerIdentifier: String = ClimbingCloudMediaStore.containerIdentifier,
        isEnabled: Bool? = nil
    ) {
        let enabled = isEnabled
            ?? (Bundle.main.object(forInfoDictionaryKey: "WorkspaceCloudMediaEnabled") as? Bool)
            ?? false
        self.isEnabled = enabled
        if enabled {
            let container = CKContainer(identifier: containerIdentifier)
            self.container = container
            self.database = container.privateCloudDatabase
        } else {
            self.container = nil
            self.database = nil
        }
        self.zoneID = CKRecordZone.ID(
            zoneName: ClimbingCloudMediaStore.zoneName,
            ownerName: CKCurrentUserDefaultName
        )
    }

    func accountState() async -> ClimbingCloudAccountState {
        guard isEnabled, let container else {
            return .unavailable("Private iCloud media sync is waiting for Workspace’s CloudKit capability to be activated.")
        }
        return await withCheckedContinuation { continuation in
            container.accountStatus { status, error in
                if let error {
                    continuation.resume(returning: .unavailable(error.localizedDescription))
                    return
                }
                switch status {
                case .available:
                    continuation.resume(returning: .available)
                case .noAccount:
                    continuation.resume(returning: .noAccount)
                case .restricted:
                    continuation.resume(returning: .restricted)
                case .temporarilyUnavailable:
                    continuation.resume(returning: .temporarilyUnavailable)
                case .couldNotDetermine:
                    continuation.resume(returning: .unavailable("Workspace could not determine this device’s iCloud status."))
                @unknown default:
                    continuation.resume(returning: .unavailable("This version of iCloud is not yet supported."))
                }
            }
        }
    }

    func accountIdentityDigest() async throws -> String {
        guard isEnabled, let container else { throw CloudMediaError.capabilityNotEnabled }
        let state = await accountState()
        guard state == .available else { throw CloudMediaError.account(state) }
        let identifier = try await container.userRecordID().recordName
        guard !identifier.isEmpty else { throw CloudMediaError.accountIdentityUnavailable }
        return SHA256.hash(data: Data(identifier.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    @discardableResult
    func prepare(
        createZoneIfNeeded: Bool,
        expectedAccountIdentityDigest: String? = nil
    ) async throws -> Bool {
        let state = await accountState()
        guard state == .available else { throw CloudMediaError.account(state) }
        if createZoneIfNeeded {
            guard let expectedAccountIdentityDigest else {
                throw CloudMediaError.accountIdentityUnavailable
            }
            try await requireAccountIdentity(expectedAccountIdentityDigest)
        }
        return try await ensureZone(
            createIfMissing: createZoneIfNeeded,
            expectedAccountIdentityDigest: expectedAccountIdentityDigest
        )
    }

    func allRecordStates() async throws -> [String: ClimbingCloudRecordState] {
        guard try await prepare(createZoneIfNeeded: false) else { return [:] }
        guard let database else { throw CloudMediaError.capabilityNotEnabled }
        var results: [String: ClimbingCloudRecordState] = [:]
        var token: CKServerChangeToken?
        var moreComing = true
        while moreComing {
            try Task.checkCancellation()
            let batch = try await database.recordZoneChanges(
                inZoneWith: zoneID,
                since: token,
                desiredKeys: Field.metadataKeys,
                resultsLimit: 200
            )
            for (recordID, result) in batch.modificationResultsByID {
                guard isCanonicalIdentifier(recordID.recordName) else { continue }
                do {
                    let record = try result.get().record
                    results[recordID.recordName] = recordState(from: record)
                } catch {
                    if !isUnknownItem(error) { throw error }
                }
            }
            for deletion in batch.deletions where isCanonicalIdentifier(deletion.recordID.recordName) {
                results.removeValue(forKey: deletion.recordID.recordName)
            }
            token = batch.changeToken
            moreComing = batch.moreComing
        }
        return results
    }

    func fetch(_ reference: ClimbingGoalReference) async throws -> ClimbingCloudFetchResult {
        guard isValidReference(reference) else { throw CloudMediaError.invalidReference }
        guard try await prepare(createZoneIfNeeded: false) else { return .missing }
        guard database != nil else { throw CloudMediaError.capabilityNotEnabled }
        let id = recordID(reference.id)
        guard let record = try await fetchRecord(id, desiredKeys: Field.downloadKeys) else {
            return .missing
        }
        switch recordState(from: record) {
        case .tombstone:
            return .missing
        case .invalid:
            return .stale
        case .active(let metadata):
            guard metadata.matches(reference),
                  let asset = record[Field.asset] as? CKAsset,
                  let cloudFile = asset.fileURL else { return .stale }
            return .downloaded(try stageDownloadedAsset(from: cloudFile, metadata: metadata))
        }
    }

    func upload(
        _ reference: ClimbingGoalReference,
        asset: ClimbingMediaCache.CachedAsset,
        expectedAccountIdentityDigest: String
    ) async throws -> ClimbingCloudMediaMetadata {
        guard isValidReference(reference),
              asset.referenceID == reference.id,
              asset.byteSize > 0,
              asset.byteSize <= ClimbingMediaCache.maximumMediaBytes,
              reference.byteSize.map({ $0 == asset.byteSize }) ?? true,
              isValidDigest(asset.sha256) else { throw CloudMediaError.invalidAsset }
        _ = try await prepare(
            createZoneIfNeeded: true,
            expectedAccountIdentityDigest: expectedAccountIdentityDigest
        )
        guard database != nil else { throw CloudMediaError.capabilityNotEnabled }
        try validateFile(at: asset.fileURL, expectedSize: asset.byteSize)

        let id = recordID(reference.id)
        var record = try await fetchRecord(id, desiredKeys: nil)
            ?? CKRecord(recordType: Self.recordType, recordID: id)
        if case .tombstone = recordState(from: record) {
            throw CloudMediaError.terminalTombstone
        }
        configureActiveRecord(record, reference: reference, asset: asset)
        do {
            _ = try await save(
                record,
                expectedAccountIdentityDigest: expectedAccountIdentityDigest
            )
        } catch where isServerRecordChanged(error) {
            record = try await fetchRecord(id, desiredKeys: nil)
                ?? CKRecord(recordType: Self.recordType, recordID: id)
            if case .tombstone = recordState(from: record) {
                throw CloudMediaError.terminalTombstone
            }
            configureActiveRecord(record, reference: reference, asset: asset)
            _ = try await save(
                record,
                expectedAccountIdentityDigest: expectedAccountIdentityDigest
            )
        }
        return metadata(for: reference, sha256: asset.sha256, byteSize: asset.byteSize)
    }

    func tombstone(
        _ reference: ClimbingGoalReference,
        expectedAccountIdentityDigest: String
    ) async throws {
        guard isCanonicalIdentifier(reference.id) else { throw CloudMediaError.invalidReference }
        _ = try await prepare(
            createZoneIfNeeded: true,
            expectedAccountIdentityDigest: expectedAccountIdentityDigest
        )
        guard database != nil else { throw CloudMediaError.capabilityNotEnabled }
        let id = recordID(reference.id)
        var record = try await fetchRecord(id, desiredKeys: nil)
            ?? CKRecord(recordType: Self.recordType, recordID: id)
        configureTombstone(record)
        do {
            _ = try await save(
                record,
                expectedAccountIdentityDigest: expectedAccountIdentityDigest
            )
        } catch where isServerRecordChanged(error) {
            record = try await fetchRecord(id, desiredKeys: nil)
                ?? CKRecord(recordType: Self.recordType, recordID: id)
            configureTombstone(record)
            _ = try await save(
                record,
                expectedAccountIdentityDigest: expectedAccountIdentityDigest
            )
        }
    }

    func tombstone(
        referenceID: String,
        expectedAccountIdentityDigest: String
    ) async throws {
        guard isCanonicalIdentifier(referenceID) else { throw CloudMediaError.invalidReference }
        _ = try await prepare(
            createZoneIfNeeded: true,
            expectedAccountIdentityDigest: expectedAccountIdentityDigest
        )
        guard database != nil else { throw CloudMediaError.capabilityNotEnabled }
        let id = recordID(referenceID)
        var record = try await fetchRecord(id, desiredKeys: nil)
            ?? CKRecord(recordType: Self.recordType, recordID: id)
        configureTombstone(record)
        do {
            _ = try await save(
                record,
                expectedAccountIdentityDigest: expectedAccountIdentityDigest
            )
        } catch where isServerRecordChanged(error) {
            record = try await fetchRecord(id, desiredKeys: nil)
                ?? CKRecord(recordType: Self.recordType, recordID: id)
            configureTombstone(record)
            _ = try await save(
                record,
                expectedAccountIdentityDigest: expectedAccountIdentityDigest
            )
        }
    }

    private func ensureZone(
        createIfMissing: Bool,
        expectedAccountIdentityDigest: String?
    ) async throws -> Bool {
        guard let database else { throw CloudMediaError.capabilityNotEnabled }
        let fetched: [CKRecordZone.ID: Result<CKRecordZone, any Error>]
        do {
            fetched = try await database.recordZones(for: [zoneID])
        } catch where isMissingItem(error) {
            guard createIfMissing else { return false }
            guard let expectedAccountIdentityDigest else {
                throw CloudMediaError.accountIdentityUnavailable
            }
            return try await createZone(
                in: database,
                expectedAccountIdentityDigest: expectedAccountIdentityDigest
            )
        }
        if let result = fetched[zoneID] {
            switch result {
            case .success:
                return true
            case .failure(let error) where !isMissingItem(error):
                throw error
            case .failure:
                break
            }
        }

        guard createIfMissing else { return false }
        guard let expectedAccountIdentityDigest else {
            throw CloudMediaError.accountIdentityUnavailable
        }
        return try await createZone(
            in: database,
            expectedAccountIdentityDigest: expectedAccountIdentityDigest
        )
    }

    private func createZone(
        in database: CKDatabase,
        expectedAccountIdentityDigest: String
    ) async throws -> Bool {
        try await requireAccountIdentity(expectedAccountIdentityDigest)
        let zone = CKRecordZone(zoneID: zoneID)
        let result = try await database.modifyRecordZones(saving: [zone], deleting: [])
        guard let saved = result.saveResults[zoneID] else {
            throw CloudMediaError.zoneUnavailable
        }
        _ = try saved.get()
        try await requireAccountIdentity(expectedAccountIdentityDigest)
        return true
    }

    private func fetchRecord(
        _ id: CKRecord.ID,
        desiredKeys: [CKRecord.FieldKey]?
    ) async throws -> CKRecord? {
        guard let database else { throw CloudMediaError.capabilityNotEnabled }
        let fetched = try await database.records(for: [id], desiredKeys: desiredKeys)
        guard let result = fetched[id] else { return nil }
        do {
            return try result.get()
        } catch where isUnknownItem(error) {
            return nil
        }
    }

    private func save(
        _ record: CKRecord,
        expectedAccountIdentityDigest: String
    ) async throws -> CKRecord {
        guard let database else { throw CloudMediaError.capabilityNotEnabled }
        try await requireAccountIdentity(expectedAccountIdentityDigest)
        let result = try await database.modifyRecords(
            saving: [record],
            deleting: [],
            savePolicy: .changedKeys,
            atomically: true
        )
        guard let saved = result.saveResults[record.recordID] else {
            throw CloudMediaError.recordNotSaved
        }
        let record = try saved.get()
        try await requireAccountIdentity(expectedAccountIdentityDigest)
        return record
    }

    private func requireAccountIdentity(_ expectedDigest: String) async throws {
        guard isValidDigest(expectedDigest),
              try await accountIdentityDigest() == expectedDigest else {
            throw CloudMediaError.accountChanged
        }
    }

    private func configureActiveRecord(
        _ record: CKRecord,
        reference: ClimbingGoalReference,
        asset: ClimbingMediaCache.CachedAsset
    ) {
        record[Field.schemaVersion] = 1
        record[Field.goalID] = reference.goalId
        record[Field.kind] = reference.kind.rawValue
        record[Field.label] = reference.label
        record[Field.fileName] = reference.fileName
        record[Field.mimeType] = reference.mimeType?.lowercased()
        record[Field.byteSize] = asset.byteSize
        record[Field.sha256] = asset.sha256
        record[Field.createdAt] = reference.createdAt
        record[Field.state] = RecordState.active
        record[Field.deletedAt] = nil
        record[Field.mirroredAt] = Date()
        record[Field.asset] = CKAsset(fileURL: asset.fileURL)
    }

    private func configureTombstone(_ record: CKRecord) {
        record[Field.schemaVersion] = 1
        record[Field.state] = RecordState.tombstone
        record[Field.deletedAt] = Date()
        record[Field.mirroredAt] = Date()
        record[Field.goalID] = nil
        record[Field.kind] = nil
        record[Field.label] = nil
        record[Field.fileName] = nil
        record[Field.mimeType] = nil
        record[Field.byteSize] = nil
        record[Field.sha256] = nil
        record[Field.createdAt] = nil
        record[Field.asset] = nil
    }

    private func recordState(from record: CKRecord) -> ClimbingCloudRecordState {
        guard record.recordType == Self.recordType else { return .invalid }
        if (record[Field.state] as? String) == RecordState.tombstone { return .tombstone }
        guard (record[Field.state] as? String) == RecordState.active,
              (record[Field.schemaVersion] as? Int) == 1,
              isCanonicalIdentifier(record.recordID.recordName),
              let goalID = record[Field.goalID] as? String,
              isCanonicalIdentifier(goalID),
              let kindValue = record[Field.kind] as? String,
              let kind = ClimbingGoalReferenceKind(rawValue: kindValue),
              kind == .image || kind == .video,
              let label = record[Field.label] as? String,
              !label.isEmpty,
              let byteSize = record[Field.byteSize] as? Int,
              byteSize > 0,
              byteSize <= ClimbingMediaCache.maximumMediaBytes,
              let sha256 = record[Field.sha256] as? String,
              isValidDigest(sha256),
              let createdAt = record[Field.createdAt] as? String,
              !createdAt.isEmpty else { return .invalid }
        return .active(ClimbingCloudMediaMetadata(
            referenceID: record.recordID.recordName,
            goalID: goalID,
            kind: kind,
            label: label,
            fileName: record[Field.fileName] as? String,
            mimeType: record[Field.mimeType] as? String,
            byteSize: byteSize,
            sha256: sha256,
            createdAt: createdAt
        ))
    }

    private func metadata(
        for reference: ClimbingGoalReference,
        sha256: String,
        byteSize: Int
    ) -> ClimbingCloudMediaMetadata {
        ClimbingCloudMediaMetadata(
            referenceID: reference.id,
            goalID: reference.goalId,
            kind: reference.kind,
            label: reference.label,
            fileName: reference.fileName,
            mimeType: reference.mimeType?.lowercased(),
            byteSize: byteSize,
            sha256: sha256,
            createdAt: reference.createdAt
        )
    }

    private func stageDownloadedAsset(
        from source: URL,
        metadata: ClimbingCloudMediaMetadata
    ) throws -> ClimbingCloudDownloadedAsset {
        try validateFile(at: source, expectedSize: metadata.byteSize)
        let digest = try sha256(of: source)
        guard digest == metadata.sha256 else { throw CloudMediaError.integrityMismatch }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("WorkspaceCloudMedia", isDirectory: true)
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let fileExtension = safeExtension(
            kind: metadata.kind,
            mimeType: metadata.mimeType,
            fileName: metadata.fileName
        )
        let destination = root.appendingPathComponent(
            "\(UUID().uuidString.lowercased()).\(fileExtension)",
            isDirectory: false
        )
        do {
            try FileManager.default.copyItem(at: source, to: destination)
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: destination.path
            )
            try validateFile(at: destination, expectedSize: metadata.byteSize)
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
        return ClimbingCloudDownloadedAsset(
            fileURL: destination,
            sha256: digest,
            byteSize: metadata.byteSize
        )
    }

    private func validateFile(at url: URL, expectedSize: Int) throws {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true,
              values.fileSize == expectedSize,
              expectedSize > 0,
              expectedSize <= ClimbingMediaCache.maximumMediaBytes else {
            throw CloudMediaError.invalidAsset
        }
    }

    private func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            try Task.checkCancellation()
            let data = try handle.read(upToCount: 1_048_576) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func safeExtension(
        kind: ClimbingGoalReferenceKind,
        mimeType: String?,
        fileName: String?
    ) -> String {
        let mimeExtension = mimeType.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension }
        let displayExtension = fileName.map { URL(fileURLWithPath: $0).pathExtension }
        let fallback = kind == .image ? "jpg" : "mov"
        let candidate = mimeExtension ?? displayExtension ?? fallback
        let filtered = candidate.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        return filtered.isEmpty ? fallback : String(filtered.prefix(12))
    }

    private func recordID(_ referenceID: String) -> CKRecord.ID {
        CKRecord.ID(recordName: referenceID, zoneID: zoneID)
    }

    private func isValidReference(_ reference: ClimbingGoalReference) -> Bool {
        isCanonicalIdentifier(reference.id)
            && isCanonicalIdentifier(reference.goalId)
            && (reference.kind == .image || reference.kind == .video)
            && !reference.label.isEmpty
            && reference.label.utf16.count <= 160
            && reference.fileName.map { !$0.isEmpty && $0.utf16.count <= 240 } ?? true
            && reference.mimeType.map { !$0.isEmpty && $0.utf16.count <= 120 } ?? true
            && reference.byteSize.map { $0 > 0 && $0 <= ClimbingMediaCache.maximumMediaBytes } ?? true
            && !reference.createdAt.isEmpty
    }

    private func isCanonicalIdentifier(_ value: String) -> Bool {
        guard let uuid = UUID(uuidString: value) else { return false }
        return value == uuid.uuidString.lowercased()
    }

    private func isValidDigest(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private func isUnknownItem(_ error: Error) -> Bool {
        (error as? CKError)?.code == .unknownItem
    }

    private func isMissingItem(_ error: Error) -> Bool {
        guard let code = (error as? CKError)?.code else { return false }
        return code == .unknownItem || code == .zoneNotFound
    }

    private func isServerRecordChanged(_ error: Error) -> Bool {
        (error as? CKError)?.code == .serverRecordChanged
    }
}

private enum CloudMediaError: LocalizedError {
    case account(ClimbingCloudAccountState)
    case accountChanged
    case accountIdentityUnavailable
    case capabilityNotEnabled
    case invalidReference
    case invalidAsset
    case integrityMismatch
    case terminalTombstone
    case zoneUnavailable
    case recordNotSaved

    var errorDescription: String? {
        switch self {
        case .account(let state):
            state.guidance ?? "Private iCloud storage is not available right now."
        case .accountChanged:
            "Your iCloud account changed. Review the climbing-media copy again before Workspace writes to this private library."
        case .accountIdentityUnavailable:
            "Workspace could not verify the private iCloud account for this media copy."
        case .capabilityNotEnabled:
            "Private iCloud media sync is waiting for Workspace’s CloudKit capability to be activated."
        case .invalidReference:
            "This climbing attachment has invalid saved information."
        case .invalidAsset:
            "This climbing attachment could not be verified for private iCloud storage."
        case .integrityMismatch:
            "The iCloud copy did not match the original climbing attachment."
        case .terminalTombstone:
            "This attachment was already removed from iCloud and cannot be restored with the same reference ID."
        case .zoneUnavailable:
            "Workspace could not prepare its private climbing-media storage in iCloud."
        case .recordNotSaved:
            "iCloud did not confirm that the climbing attachment was saved."
        }
    }
}
