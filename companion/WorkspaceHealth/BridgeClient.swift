import Foundation
import Security
import CryptoKit

struct PairingFile: Decodable {
    let version: Int
    let type: String
    let url: URL
    let fingerprint: String
    let code: String
    let expiresAt: Date
}
struct BridgeCredentials: Codable {
    let url: URL
    let fingerprint: String
    let token: String
    var receipts: [String: String] = [:]
}
struct WeightCommand: Decodable, Identifiable {
    let id: String
    let kg: Double
    let measuredAt: Date
    let payloadHash: String
}
enum BridgeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}
func bridgeDecoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
        let text = try decoder.singleValueContainer().decode(String.self)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: text) else { throw BridgeError.message("An entry has an invalid date.") }
        return date
    }
    return decoder
}
func bridgeEncoder() -> JSONEncoder { let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; return encoder }

enum BridgeKeychain {
    static let service = "com.jordburg.workspace.health"
    static func load() throws -> BridgeCredentials? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "bridge", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw BridgeError.message("Unlock your iPhone to access its pairing.") }
        return try bridgeDecoder().decode(BridgeCredentials.self, from: data)
    }
    static func save(_ credentials: BridgeCredentials) throws {
        let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "bridge"]
        let data = try bridgeEncoder().encode(credentials)
        let update = SecItemUpdate(key as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecItemNotFound {
            var item = key
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            item[kSecAttrSynchronizable as String] = false
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw BridgeError.message("The pairing could not be saved securely.") }
        } else if update != errSecSuccess { throw BridgeError.message("The pairing could not be updated securely.") }
    }
    static func remove() { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: "bridge"] as CFDictionary) }
}

final class BridgeClient: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let credentials: BridgeCredentials
    init(_ credentials: BridgeCredentials) throws {
        let url = credentials.url
        let octets = (url.host ?? "").split(separator: ".").compactMap { Int($0) }
        let privateIP = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) } && (octets[0] == 10 || (octets[0] == 192 && octets[1] == 168) || (octets[0] == 172 && (16...31).contains(octets[1])))
        guard url.scheme == "https", privateIP, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/", credentials.fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw BridgeError.message("Choose a pairing file from your Mac’s local Health settings.")
        }
        self.credentials = credentials
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == credentials.url.host,
              challenge.protectionSpace.port == (credentials.url.port ?? 443),
              let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = certificates.first else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        let fingerprint = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
        guard fingerprint == credentials.fingerprint else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        SecTrustSetAnchorCertificates(trust, [leaf] as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, credentials.url.host! as CFString))
        guard SecTrustEvaluateWithError(trust, nil) else { completionHandler(.cancelAuthenticationChallenge, nil); return }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func call<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
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
        var request = URLRequest(url: credentials.url.appendingPathComponent(path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("Bearer \(credentials.token)", forHTTPHeaderField: "Authorization")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            struct ErrorResponse: Decodable { let error: String }
            throw BridgeError.message((try? bridgeDecoder().decode(ErrorResponse.self, from: data).error) ?? "The Mac did not accept this request. Check its Health connection.")
        }
        return try bridgeDecoder().decode(T.self, from: data)
    }
    static func pair(_ file: PairingFile) async throws -> BridgeCredentials {
        guard file.type == "personal-workspace-health-pairing", file.version == 1, file.expiresAt > Date(), file.code.count >= 40 else { throw BridgeError.message("This pairing file expired. Download a new one from the Mac.") }
        let temporary = BridgeCredentials(url: file.url, fingerprint: file.fingerprint, token: file.code)
        struct Response: Decodable { let token: String }
        let response: Response = try await BridgeClient(temporary).call("pair", body: Data("{}".utf8))
        let credentials = BridgeCredentials(url: file.url, fingerprint: file.fingerprint, token: response.token)
        try BridgeKeychain.save(credentials)
        return credentials
    }
}
