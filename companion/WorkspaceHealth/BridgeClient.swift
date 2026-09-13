import Foundation
import Security
import CryptoKit

enum BridgeScope: String, Codable, Hashable, Sendable {
    case health
    case workspace
}

struct PairingFile: Decodable, Sendable {
    let version: Int
    let type: String
    let scope: BridgeScope?
    let url: URL
    let fingerprint: String
    let code: String
    let expiresAt: Date
}

struct BridgeCredentials: Codable, Hashable, Sendable {
    let url: URL
    let fingerprint: String
    let token: String
    var scope: BridgeScope?
    var receipts: [String: String]

    init(
        url: URL,
        fingerprint: String,
        token: String,
        scope: BridgeScope? = nil,
        receipts: [String: String] = [:]
    ) {
        self.url = url
        self.fingerprint = fingerprint
        self.token = token
        self.scope = scope
        self.receipts = receipts
    }

    enum CodingKeys: String, CodingKey { case url, fingerprint, token, scope, receipts }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        url = try values.decode(URL.self, forKey: .url)
        fingerprint = try values.decode(String.self, forKey: .fingerprint)
        token = try values.decode(String.self, forKey: .token)
        scope = try values.decodeIfPresent(BridgeScope.self, forKey: .scope)
        receipts = try values.decodeIfPresent([String: String].self, forKey: .receipts) ?? [:]
    }
}

struct BridgeCapabilities: Codable, Hashable, Sendable {
    let version: Int
    let scope: BridgeScope
    let workspace: Bool
    let health: Bool
}

private struct BridgeRevocationResponse: Decodable, Sendable {
    let revoked: Bool
}

enum BridgeHTTPMethod: String, Sendable {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case patch = "PATCH"
    case delete = "DELETE"
}

struct WeightCommand: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let kg: Double
    let measuredAt: Date
    let payloadHash: String
}

private struct BridgeErrorResponse: Decodable {
    let error: String
    let code: String?
}

enum BridgeError: LocalizedError, Sendable {
    case message(String)
    case response(status: Int, code: String?, message: String)

    var errorDescription: String? {
        switch self {
        case .message(let value), .response(_, _, let value): value
        }
    }

    var statusCode: Int? {
        if case .response(let status, _, _) = self { return status }
        return nil
    }

    var responseCode: String? {
        if case .response(_, let code, _) = self { return code }
        return nil
    }
}

func bridgeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let text = try decoder.singleValueContainer().decode(String.self)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: text) else {
            throw BridgeError.message("An entry has an invalid date.")
        }
        return date
    }
    return decoder
}

func bridgeEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    return encoder
}

enum BridgeKeychain {
    static let service = "com.jordburg.workspace.health"

    static func load() throws -> BridgeCredentials? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "bridge",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw BridgeError.message("Unlock your iPhone to access its pairing.")
        }
        return try bridgeDecoder().decode(BridgeCredentials.self, from: data)
    }

    static func save(_ credentials: BridgeCredentials) throws {
        let key: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "bridge",
        ]
        let data = try bridgeEncoder().encode(credentials)
        let update = SecItemUpdate(key as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var item = key
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            item[kSecAttrSynchronizable as String] = false
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                throw BridgeError.message("The pairing could not be saved securely.")
            }
        } else if update != errSecSuccess {
            throw BridgeError.message("The pairing could not be updated securely.")
        }
    }

    static func remove() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "bridge",
        ] as CFDictionary)
    }
}

final class BridgeClient: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    static let maximumMediaBytes = 200_000_000

    let credentials: BridgeCredentials

    init(_ credentials: BridgeCredentials) throws {
        let url = credentials.url
        let labels = (url.host ?? "").split(separator: ".", omittingEmptySubsequences: false)
        let parsed = labels.map { label -> Int? in
            guard !label.isEmpty,
                  label.allSatisfy({ $0.isASCII && $0.isNumber }),
                  (label == "0" || label.first != "0"),
                  let value = Int(label),
                  (0...255).contains(value) else { return nil }
            return value
        }
        let octets = parsed.compactMap { $0 }
        let privateIP = labels.count == 4 && octets.count == 4
            && (octets[0] == 10
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && (16...31).contains(octets[1])))
        guard url.scheme == "https",
              privateIP,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              credentials.fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw BridgeError.message("Choose a pairing file from your Mac’s local Workspace settings.")
        }
        self.credentials = credentials
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == credentials.url.host,
              challenge.protectionSpace.port == (credentials.url.port ?? 443),
              let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let leaf = certificates.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
            .map { String(format: "%02x", $0) }.joined()
        guard fingerprint == credentials.fingerprint else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, credentials.url.host! as CFString))
        guard SecTrustEvaluateWithError(trust, nil) else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }

    private func normalizedPath(_ path: String) throws -> String {
        let normalized = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !normalized.isEmpty,
              !normalized.contains(".."),
              !normalized.contains("?"),
              !normalized.contains("#") else {
            throw BridgeError.message("The app tried to use an invalid Workspace route.")
        }
        return normalized
    }

    private func makeSession(resourceTimeout: TimeInterval = 12) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.allowsCellularAccess = false
        configuration.timeoutIntervalForRequest = 8
        configuration.timeoutIntervalForResource = resourceTimeout
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }

    private func makeRequest(
        path: String,
        method: BridgeHTTPMethod,
        contentType: String? = nil,
        accept: String = "application/json"
    ) throws -> URLRequest {
        let normalized = try normalizedPath(path)
        var request = URLRequest(url: credentials.url.appendingPathComponent(normalized))
        request.httpMethod = method.rawValue
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        return request
    }

    private func checkedResponse(_ response: URLResponse, errorData: Data) throws -> HTTPURLResponse {
        guard let response = response as? HTTPURLResponse else {
            throw BridgeError.message("The Mac returned an unreadable response.")
        }
        guard (200..<300).contains(response.statusCode) else {
            let details = try? bridgeDecoder().decode(BridgeErrorResponse.self, from: errorData)
            let message = details?.error ?? "The Mac did not accept this request. Check its Workspace connection."
            throw BridgeError.response(status: response.statusCode, code: details?.code, message: message)
        }
        return response
    }

    private func decoded<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try bridgeDecoder().decode(type, from: data)
        } catch {
            throw BridgeError.message("The Mac returned Workspace data this app could not read. Your saved data has been kept.")
        }
    }

    func call<T: Decodable>(
        _ path: String,
        method: BridgeHTTPMethod? = nil,
        body: Data? = nil
    ) async throws -> T {
        let session = makeSession()
        defer { session.finishTasksAndInvalidate() }

        let requestMethod = method ?? (body == nil ? .get : .post)
        var request = try makeRequest(
            path: path,
            method: requestMethod,
            contentType: body == nil ? nil : "application/json"
        )
        request.httpBody = body

        let (data, response) = try await session.data(for: request)
        _ = try checkedResponse(response, errorData: data)
        return try decoded(T.self, from: data)
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await call(path, method: .get)
    }

    func send<Input: Encodable, Output: Decodable>(
        _ path: String,
        method: BridgeHTTPMethod = .post,
        input: Input
    ) async throws -> Output {
        try await call(path, method: method, body: bridgeEncoder().encode(input))
    }

    func upload<Output: Decodable>(
        _ path: String,
        file: URL,
        contentType: String,
        headers: [String: String]
    ) async throws -> Output {
        let values = try file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let byteCount = values.fileSize else {
            throw BridgeError.message("The selected photo or video is no longer available.")
        }
        guard byteCount > 0, byteCount <= Self.maximumMediaBytes else {
            throw BridgeError.message("Choose a photo or video smaller than 200 MB.")
        }
        guard !contentType.isEmpty, !contentType.contains("\r"), !contentType.contains("\n") else {
            throw BridgeError.message("The selected photo or video has an invalid file type.")
        }

        var request = try makeRequest(path: path, method: .post, contentType: contentType)
        for (name, value) in headers {
            guard !name.isEmpty,
                  name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }),
                  value.utf8.count <= 2_048,
                  !value.contains("\r"),
                  !value.contains("\n") else {
                throw BridgeError.message("The selected photo or video has invalid metadata.")
            }
            request.setValue(value, forHTTPHeaderField: name)
        }

        let session = makeSession(resourceTimeout: 5 * 60)
        defer { session.finishTasksAndInvalidate() }
        let (data, response) = try await session.upload(for: request, fromFile: file)
        _ = try checkedResponse(response, errorData: data)
        return try decoded(Output.self, from: data)
    }

    func download(_ path: String, fileExtension: String?) async throws -> URL {
        let request = try makeRequest(path: path, method: .get, accept: "image/*, video/*")
        let session = makeSession(resourceTimeout: 5 * 60)
        defer { session.finishTasksAndInvalidate() }
        let (temporary, response) = try await session.download(for: request)
        let errorData = ((response as? HTTPURLResponse)?.statusCode ?? 500) >= 400
            ? ((try? Data(contentsOf: temporary, options: .mappedIfSafe)) ?? Data())
            : Data()
        _ = try checkedResponse(response, errorData: errorData)
        try Task.checkCancellation()

        let values = try temporary.resourceValues(forKeys: [.fileSizeKey])
        guard let byteCount = values.fileSize,
              byteCount > 0,
              byteCount <= Self.maximumMediaBytes else {
            throw BridgeError.message("This attachment is larger than the 200 MB iPhone limit.")
        }
        let filteredExtension = fileExtension?.lowercased().filter {
            $0.isASCII && ($0.isLetter || $0.isNumber)
        }
        let safeExtension = filteredExtension.flatMap { $0.isEmpty ? nil : String($0.prefix(12)) }
        let suffix = safeExtension.map { ".\($0)" } ?? ""
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("WorkspaceGoalMedia", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.complete]
        )
        let destination = directory.appendingPathComponent(UUID().uuidString.lowercased() + suffix)
        do {
            try FileManager.default.moveItem(at: temporary, to: destination)
        } catch {
            // A URLSession temporary file can live on a different volume. Copy only
            // when an atomic move is unavailable; URLSession removes its original.
            do {
                try FileManager.default.copyItem(at: temporary, to: destination)
            } catch {
                try? FileManager.default.removeItem(at: destination)
                throw error
            }
        }
        do {
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.complete],
                ofItemAtPath: destination.path
            )
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
        return destination
    }

    func negotiateCapabilities() async throws -> BridgeCapabilities {
        try await get("capabilities")
    }

    func revokePairing() async throws {
        let response: BridgeRevocationResponse = try await call(
            "unpair",
            method: .post,
            body: Data("{}".utf8)
        )
        guard response.revoked else {
            throw BridgeError.message("The Mac did not confirm that this pairing was revoked.")
        }
    }

    static func pair(_ file: PairingFile) async throws -> BridgeCredentials {
        let legacyHealth = file.version == 1
            && file.type == "personal-workspace-health-pairing"
            && (file.scope == nil || file.scope == .health)
        let workspace = file.version == 2
            && file.type == "personal-workspace-pairing"
            && file.scope == .workspace
        guard (legacyHealth || workspace), file.expiresAt > Date(), file.code.count >= 40 else {
            throw BridgeError.message("This pairing file expired or is not a supported Workspace pairing. Download a new one from the Mac.")
        }

        let requestedScope: BridgeScope = workspace ? .workspace : .health
        let temporary = BridgeCredentials(
            url: file.url,
            fingerprint: file.fingerprint,
            token: file.code,
            scope: requestedScope
        )
        struct Response: Decodable { let token: String; let scope: BridgeScope? }
        let response: Response = try await BridgeClient(temporary).call(
            "pair",
            method: .post,
            body: Data("{}".utf8)
        )
        let grantedScope = response.scope ?? requestedScope
        guard requestedScope != .workspace || grantedScope == .workspace else {
            throw BridgeError.message("The Mac did not grant Workspace access. Create a new Workspace pairing file and try again.")
        }
        let credentials = BridgeCredentials(
            url: file.url,
            fingerprint: file.fingerprint,
            token: response.token,
            scope: grantedScope
        )
        try BridgeKeychain.save(credentials)
        return credentials
    }
}
