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
    let credentials: BridgeCredentials

    init(_ credentials: BridgeCredentials) throws {
        let url = credentials.url
        let octets = (url.host ?? "").split(separator: ".").compactMap { Int($0) }
        let privateIP = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
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

    func call<T: Decodable>(
        _ path: String,
        method: BridgeHTTPMethod? = nil,
        body: Data? = nil
    ) async throws -> T {
        let normalized = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !normalized.isEmpty,
              !normalized.contains(".."),
              !normalized.contains("?"),
              !normalized.contains("#") else {
            throw BridgeError.message("The app tried to use an invalid Workspace route.")
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = true
        configuration.allowsCellularAccess = false
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 45
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }

        var request = URLRequest(url: credentials.url.appendingPathComponent(normalized))
        request.httpMethod = (method ?? (body == nil ? .get : .post)).rawValue
        request.httpBody = body
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }

        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw BridgeError.message("The Mac returned an unreadable response.")
        }
        guard (200..<300).contains(response.statusCode) else {
            let details = try? bridgeDecoder().decode(BridgeErrorResponse.self, from: data)
            let message = details?.error ?? "The Mac did not accept this request. Check its Workspace connection."
            throw BridgeError.response(status: response.statusCode, code: details?.code, message: message)
        }
        do {
            return try bridgeDecoder().decode(T.self, from: data)
        } catch {
            throw BridgeError.message("The Mac returned Workspace data this app could not read. Your saved data has been kept.")
        }
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

    func negotiateCapabilities() async throws -> BridgeCapabilities {
        try await get("capabilities")
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
