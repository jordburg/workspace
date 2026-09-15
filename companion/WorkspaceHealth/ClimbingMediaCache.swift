import CryptoKit
import Foundation
import UniformTypeIdentifiers

actor ClimbingMediaCache {
    static let maximumMediaBytes = 200_000_000

    struct CachedAsset: Sendable {
        let fileURL: URL
        let referenceID: String
        let sha256: String
        let byteSize: Int
    }

    struct ImportReceipt: Sendable {
        let fileURL: URL
        let referenceID: String
        let relativePath: String
        let sha256: String
        let cacheToken: String
    }

    private enum CatalogReadResult {
        case missing
        case loaded(Catalog)
        case malformed
        case unavailable
    }

    private enum CatalogLoadState {
        case ready
        case retry
        case discardMalformed
    }

    private enum StoredFileValidation {
        case valid(URL)
        case invalid
        case unavailable
    }

    private struct Catalog: Codable, Sendable {
        static let currentVersion = 1

        var version = currentVersion
        var entries: [String: Entry] = [:]
    }

    private struct Entry: Codable, Sendable {
        let referenceId: String
        let goalId: String
        let kind: ClimbingGoalReferenceKind
        let fileName: String?
        let mimeType: String?
        let byteSize: Int
        let sha256: String
        let relativePath: String
        let cachedAt: Date
        let cacheToken: String?

        func matches(_ reference: ClimbingGoalReference) -> Bool {
            guard reference.id == referenceId,
                  reference.goalId == goalId,
                  reference.kind == kind,
                  reference.kind != .link else { return false }
            if let expectedSize = reference.byteSize, expectedSize != byteSize { return false }
            if let expectedType = reference.mimeType?.lowercased(),
               expectedType != mimeType?.lowercased() { return false }
            return true
        }
    }

    private let fileManager: FileManager
    private let rootURL: URL
    private let catalogURL: URL
    private var catalog: Catalog
    private var catalogLoadState: CatalogLoadState
    private var digestVerifiedReferenceIDs: Set<String> = []

    init(rootURL: URL? = nil, fileManager: FileManager = .default) {
        self.fileManager = fileManager
        let base = rootURL ?? fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0]
            .appendingPathComponent("Companion", isDirectory: true)
            .appendingPathComponent("ClimbingMedia", isDirectory: true)
            .appendingPathComponent("v1", isDirectory: true)
        self.rootURL = base
        self.catalogURL = base.appendingPathComponent("catalog-v1.json", isDirectory: false)
        switch Self.readCatalog(at: self.catalogURL) {
        case .loaded(let loaded):
            self.catalog = loaded
            self.catalogLoadState = .ready
        case .missing:
            self.catalog = Catalog()
            self.catalogLoadState = fileManager.fileExists(atPath: base.path)
                ? .discardMalformed
                : .ready
        case .malformed:
            self.catalog = Catalog()
            self.catalogLoadState = .discardMalformed
        case .unavailable:
            // Complete file protection can make a valid catalog temporarily
            // unreadable. Retry later without deleting or overwriting it.
            self.catalog = Catalog()
            self.catalogLoadState = .retry
        }
    }

    func availableReferenceIDs() -> Set<String> {
        guard (try? prepareCatalogForAccess()) != nil else { return [] }
        var available: Set<String> = []
        for (key, entry) in catalog.entries {
            guard let referenceID = validatedCatalogIdentifier(forKey: key, entry: entry) else {
                forgetInvalidEntry(forKey: key, entry: entry)
                continue
            }
            switch validateStoredFile(for: entry) {
            case .valid:
                available.insert(referenceID)
            case .invalid:
                forgetInvalidEntry(forKey: key, entry: entry)
            case .unavailable:
                // Do not advertise a file that cannot currently be opened, and
                // do not discard it for a transient protected-data or I/O error.
                continue
            }
        }
        return available
    }

    func fileURL(for reference: ClimbingGoalReference) -> URL? {
        guard (try? prepareCatalogForAccess()) != nil,
              isCanonicalIdentifier(reference.id),
              let entry = catalog.entries[reference.id],
              validatedCatalogIdentifier(forKey: reference.id, entry: entry) != nil,
              entry.matches(reference) else {
            if let entry = catalog.entries[reference.id] {
                forgetInvalidEntry(forKey: reference.id, entry: entry)
            }
            return nil
        }
        let file: URL
        switch validateStoredFile(for: entry) {
        case .valid(let value):
            file = value
        case .invalid:
            forgetInvalidEntry(forKey: reference.id, entry: entry)
            return nil
        case .unavailable:
            return nil
        }
        if !digestVerifiedReferenceIDs.contains(reference.id) {
            let digest: String
            do {
                digest = try sha256(of: file)
            } catch {
                // A locked device can make a protected file temporarily
                // unreadable. Leave the cache intact and let a later open retry.
                return nil
            }
            guard digest == entry.sha256 else {
                forgetInvalidEntry(forKey: reference.id, entry: entry)
                return nil
            }
            digestVerifiedReferenceIDs.insert(reference.id)
        }
        return file
    }

    func cachedAsset(for reference: ClimbingGoalReference) -> CachedAsset? {
        guard let file = fileURL(for: reference),
              let entry = catalog.entries[reference.id],
              entry.matches(reference) else { return nil }
        return CachedAsset(
            fileURL: file,
            referenceID: reference.id,
            sha256: entry.sha256,
            byteSize: entry.byteSize
        )
    }

    @discardableResult
    func importFile(at source: URL, for reference: ClimbingGoalReference) throws -> ImportReceipt {
        try prepareCatalogForAccess()
        guard isCanonicalIdentifier(reference.id),
              isCanonicalIdentifier(reference.goalId),
              reference.kind == .image || reference.kind == .video else {
            throw CacheError.invalidReference
        }

        let sourceValues = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard sourceValues.isRegularFile == true,
              let byteSize = sourceValues.fileSize,
              byteSize > 0,
              byteSize <= Self.maximumMediaBytes else {
            throw CacheError.invalidFile
        }
        if let expectedSize = reference.byteSize, expectedSize != byteSize {
            throw CacheError.invalidFile
        }

        try prepareRoot()
        let referenceDirectory = rootURL.appendingPathComponent(reference.id, isDirectory: true)
        try fileManager.createDirectory(
            at: referenceDirectory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )

        let staging = referenceDirectory
            .appendingPathComponent(".\(UUID().uuidString.lowercased()).partial", isDirectory: false)
        defer { try? fileManager.removeItem(at: staging) }
        try fileManager.copyItem(at: source, to: staging)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: staging.path
        )

        let digest = try sha256(of: staging)
        let fileExtension = safeExtension(for: reference)
        let destinationName = "asset-\(digest).\(fileExtension)"
        let destination = referenceDirectory.appendingPathComponent(destinationName, isDirectory: false)
        let priorEntry = catalog.entries[reference.id]
        let destinationWasCatalogued = priorEntry.map {
            validatedCatalogIdentifier(forKey: reference.id, entry: $0) == reference.id
                && $0.relativePath == "\(reference.id)/\(destinationName)"
        } ?? false
        var destinationIsValid = false
        if fileManager.fileExists(atPath: destination.path),
           let values = try? destination.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
           values.isRegularFile == true,
           values.fileSize == byteSize,
           let existingDigest = try? sha256(of: destination),
           existingDigest == digest {
            destinationIsValid = true
        }
        if !destinationIsValid {
            if fileManager.fileExists(atPath: destination.path) {
                try fileManager.removeItem(at: destination)
            }
            try fileManager.moveItem(at: staging, to: destination)
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: destination.path
            )
        }

        let relativePath = "\(reference.id)/\(destinationName)"
        let cacheToken = UUID().uuidString.lowercased()
        let entry = Entry(
            referenceId: reference.id,
            goalId: reference.goalId,
            kind: reference.kind,
            fileName: reference.fileName,
            mimeType: reference.mimeType,
            byteSize: byteSize,
            sha256: digest,
            relativePath: relativePath,
            cachedAt: Date(),
            cacheToken: cacheToken
        )
        var next = catalog
        let previous = next.entries.updateValue(entry, forKey: reference.id)
        do {
            try persist(next)
        } catch {
            if !destinationWasCatalogued { try? fileManager.removeItem(at: destination) }
            throw error
        }
        catalog = next
        digestVerifiedReferenceIDs.insert(reference.id)

        if let previous,
           previous.relativePath != relativePath,
           let priorURL = storedURL(for: previous) {
            try? fileManager.removeItem(at: priorURL)
        }
        return ImportReceipt(
            fileURL: destination,
            referenceID: reference.id,
            relativePath: relativePath,
            sha256: digest,
            cacheToken: cacheToken
        )
    }

    @discardableResult
    func removeIfCurrent(_ receipt: ImportReceipt) throws -> Bool {
        try prepareCatalogForAccess()
        guard isCanonicalIdentifier(receipt.referenceID),
              isCanonicalIdentifier(receipt.cacheToken),
              receipt.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let entry = catalog.entries[receipt.referenceID],
              validatedCatalogIdentifier(forKey: receipt.referenceID, entry: entry) != nil,
              entry.cacheToken == receipt.cacheToken,
              entry.sha256 == receipt.sha256,
              entry.relativePath == receipt.relativePath else { return false }

        let directory = rootURL.appendingPathComponent(receipt.referenceID, isDirectory: true)
        try removeItemIfPresent(at: directory)
        var next = catalog
        next.entries.removeValue(forKey: receipt.referenceID)
        catalog = next
        digestVerifiedReferenceIDs.remove(receipt.referenceID)
        // The exact imported bytes are gone. A stale on-disk catalog entry will
        // self-prune if persisting the in-memory removal is temporarily blocked.
        try? persist(next)
        return true
    }

    func remove(referenceID: String) throws {
        try prepareCatalogForAccess()
        guard isCanonicalIdentifier(referenceID) else { return }
        let directory = rootURL.appendingPathComponent(referenceID, isDirectory: true)
        try removeItemIfPresent(at: directory)
        var next = catalog
        let removedEntry = next.entries.removeValue(forKey: referenceID)
        catalog = next
        digestVerifiedReferenceIDs.remove(referenceID)
        if removedEntry != nil {
            // The bytes are already gone. If the catalog write fails, keep the
            // in-memory removal; the stale disk entry will self-prune on launch.
            try? persist(next)
        }
    }

    func reconcile(with references: [ClimbingGoalReference]) throws {
        try prepareCatalogForAccess()
        var active: [String: ClimbingGoalReference] = [:]
        for reference in references where reference.kind != .link
            && isCanonicalIdentifier(reference.id)
            && isCanonicalIdentifier(reference.goalId) {
            active[reference.id] = reference
        }
        var next = catalog
        var changed = false
        var firstRemovalError: Error?
        for (key, entry) in catalog.entries {
            guard let referenceID = validatedCatalogIdentifier(forKey: key, entry: entry) else {
                // Remove malformed metadata from the catalog without ever using
                // an untrusted key or entry value to construct a file path.
                next.entries.removeValue(forKey: key)
                changed = true
                continue
            }
            if let reference = active[referenceID], entry.matches(reference) {
                switch validateStoredFile(for: entry) {
                case .valid:
                    continue
                case .unavailable:
                    if firstRemovalError == nil {
                        firstRemovalError = CacheError.catalogUnavailable
                    }
                    continue
                case .invalid:
                    break
                }
            }
            do {
                let directory = rootURL.appendingPathComponent(referenceID, isDirectory: true)
                try removeItemIfPresent(at: directory)
                next.entries.removeValue(forKey: key)
                digestVerifiedReferenceIDs.remove(referenceID)
                changed = true
            } catch {
                if firstRemovalError == nil { firstRemovalError = error }
            }
        }
        if changed {
            catalog = next
            digestVerifiedReferenceIDs.formIntersection(next.entries.keys)
            try persist(next)
        }
        if let firstRemovalError { throw firstRemovalError }
    }

    func clear() throws {
        try removeItemIfPresent(at: rootURL)
        catalog = Catalog()
        catalogLoadState = .ready
        digestVerifiedReferenceIDs = []
    }

    private static func readCatalog(at url: URL) -> CatalogReadResult {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return .missing
        } catch {
            return .unavailable
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let value = try? decoder.decode(Catalog.self, from: data),
              value.version == Catalog.currentVersion else { return .malformed }
        return .loaded(value)
    }

    private func prepareCatalogForAccess() throws {
        switch catalogLoadState {
        case .ready:
            return
        case .discardMalformed:
            try discardMalformedCatalog()
        case .retry:
            switch Self.readCatalog(at: catalogURL) {
            case .loaded(let loaded):
                catalog = loaded
                catalogLoadState = .ready
                digestVerifiedReferenceIDs = []
            case .missing:
                if fileManager.fileExists(atPath: rootURL.path) {
                    catalogLoadState = .discardMalformed
                    try discardMalformedCatalog()
                } else {
                    catalog = Catalog()
                    catalogLoadState = .ready
                    digestVerifiedReferenceIDs = []
                }
            case .malformed:
                catalogLoadState = .discardMalformed
                try discardMalformedCatalog()
            case .unavailable:
                throw CacheError.catalogUnavailable
            }
        }
    }

    private func discardMalformedCatalog() throws {
        try removeItemIfPresent(at: rootURL)
        catalog = Catalog()
        catalogLoadState = .ready
        digestVerifiedReferenceIDs = []
    }

    private func prepareRoot() throws {
        try fileManager.createDirectory(
            at: rootURL,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: rootURL.path
        )
        var protectedRoot = rootURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedRoot.setResourceValues(values)
    }

    private func persist(_ value: Catalog) throws {
        try prepareRoot()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(value)
        try data.write(to: catalogURL, options: [.atomic, .completeFileProtection])
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: catalogURL.path
        )
    }

    private func validateStoredFile(for entry: Entry) -> StoredFileValidation {
        guard isCanonicalIdentifier(entry.referenceId),
              isCanonicalIdentifier(entry.goalId),
              entry.kind == .image || entry.kind == .video,
              entry.byteSize > 0,
              entry.byteSize <= Self.maximumMediaBytes,
              entry.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let candidate = storedURL(for: entry) else { return .invalid }
        let values: URLResourceValues
        do {
            values = try candidate.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return .invalid
        } catch {
            return .unavailable
        }
        guard values.isRegularFile == true,
              values.fileSize == entry.byteSize else { return .invalid }
        return .valid(candidate)
    }

    private func storedURL(for entry: Entry) -> URL? {
        let components = entry.relativePath.split(separator: "/", omittingEmptySubsequences: false)
        let expectedPrefix = "asset-\(entry.sha256)."
        guard components.count == 2,
              String(components[0]) == entry.referenceId,
              String(components[1]).hasPrefix(expectedPrefix) else { return nil }
        let fileExtension = String(components[1]).dropFirst(expectedPrefix.count)
        guard !fileExtension.isEmpty,
              fileExtension.count <= 12,
              fileExtension.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
        let candidate = rootURL.appendingPathComponent(entry.relativePath, isDirectory: false).standardizedFileURL
        let rootPath = rootURL.standardizedFileURL.path + "/"
        guard candidate.path.hasPrefix(rootPath) else { return nil }
        return candidate
    }

    private func forgetInvalidEntry(forKey key: String, entry: Entry) {
        guard catalog.entries[key] != nil else { return }
        if let referenceID = validatedCatalogIdentifier(forKey: key, entry: entry) {
            let directory = rootURL.appendingPathComponent(referenceID, isDirectory: true)
            try? removeItemIfPresent(at: directory)
            digestVerifiedReferenceIDs.remove(referenceID)
        }
        var next = catalog
        next.entries.removeValue(forKey: key)
        catalog = next
        try? persist(next)
    }

    private func validatedCatalogIdentifier(forKey key: String, entry: Entry) -> String? {
        guard key == entry.referenceId, isCanonicalIdentifier(entry.referenceId) else { return nil }
        return entry.referenceId
    }

    private func isCanonicalIdentifier(_ value: String) -> Bool {
        guard let uuid = UUID(uuidString: value) else { return false }
        return value == uuid.uuidString.lowercased()
    }

    private func removeItemIfPresent(at url: URL) throws {
        do {
            try fileManager.removeItem(at: url)
        } catch let error as CocoaError
            where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile {
            return
        }
    }

    private func safeExtension(for reference: ClimbingGoalReference) -> String {
        let mimeExtension = reference.mimeType.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension }
        let displayExtension = reference.fileName.map { URL(fileURLWithPath: $0).pathExtension }
        let candidate = mimeExtension ?? displayExtension ?? (reference.kind == .image ? "jpg" : "mov")
        let filtered = candidate.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) }
        return filtered.isEmpty ? (reference.kind == .image ? "jpg" : "mov") : String(filtered.prefix(12))
    }

    private func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let data = try handle.read(upToCount: 1_048_576) ?? Data()
            if data.isEmpty { break }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

private enum CacheError: LocalizedError {
    case invalidReference
    case invalidFile
    case catalogUnavailable

    var errorDescription: String? {
        switch self {
        case .invalidReference:
            "This climbing attachment has invalid saved information."
        case .invalidFile:
            "This climbing attachment could not be saved for offline use."
        case .catalogUnavailable:
            "Unlock this device to access its downloaded climbing media."
        }
    }
}
