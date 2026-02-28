# Networking Reference

## Table of Contents
1. [API Client](#api-client)
2. [Type-Safe Endpoints](#endpoints)
3. [Request/Response Models](#models)
4. [Authentication](#authentication)
5. [Error Handling](#error-handling)
6. [File Upload/Download](#file-operations)
7. [WebSocket](#websocket)
8. [Offline Support](#offline-support)

---

## API Client

A production-ready, generic API client using async/await.

```swift
import Foundation

actor APIClient: APIClientProtocol {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private var authToken: String?

    init(
        baseURL: URL,
        session: URLSession = .shared,
        authToken: String? = nil
    ) {
        self.baseURL = baseURL
        self.session = session
        self.authToken = authToken

        self.decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601

        self.encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.dateEncodingStrategy = .iso8601
    }

    func setAuthToken(_ token: String?) {
        authToken = token
    }

    func fetch<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
        let request = try buildRequest(for: endpoint)
        return try await execute(request)
    }

    func post<T: Decodable, Body: Encodable>(
        _ endpoint: Endpoint,
        body: Body
    ) async throws -> T {
        var request = try buildRequest(for: endpoint)
        request.httpMethod = "POST"
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await execute(request)
    }

    func put<T: Decodable, Body: Encodable>(
        _ endpoint: Endpoint,
        body: Body
    ) async throws -> T {
        var request = try buildRequest(for: endpoint)
        request.httpMethod = "PUT"
        request.httpBody = try encoder.encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try await execute(request)
    }

    func delete(_ endpoint: Endpoint) async throws {
        var request = try buildRequest(for: endpoint)
        request.httpMethod = "DELETE"
        let (_, response) = try await session.data(for: request)
        try validateResponse(response)
    }

    // MARK: - Private

    private func buildRequest(for endpoint: Endpoint) throws -> URLRequest {
        let url = try endpoint.url(baseURL: baseURL)
        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue

        if let token = authToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        for (key, value) in endpoint.headers {
            request.setValue(value, forHTTPHeaderField: key)
        }

        return request
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try validateResponse(response)

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw NetworkError.decodingFailed(error)
        }
    }

    private func validateResponse(_ response: URLResponse) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NetworkError.invalidResponse
        }

        switch httpResponse.statusCode {
        case 200...299:
            return
        case 401:
            throw NetworkError.unauthorized
        case 403:
            throw NetworkError.forbidden
        case 404:
            throw NetworkError.notFound
        case 429:
            throw NetworkError.rateLimited
        case 500...599:
            throw NetworkError.serverError(statusCode: httpResponse.statusCode)
        default:
            throw NetworkError.httpError(statusCode: httpResponse.statusCode)
        }
    }
}
```

---

## Endpoints

Type-safe endpoint definitions prevent URL string typos and centralize API configuration.

```swift
enum HTTPMethod: String {
    case GET, POST, PUT, PATCH, DELETE
}

struct Endpoint {
    let path: String
    let method: HTTPMethod
    let queryItems: [URLQueryItem]
    let headers: [String: String]

    init(
        path: String,
        method: HTTPMethod = .GET,
        queryItems: [URLQueryItem] = [],
        headers: [String: String] = [:]
    ) {
        self.path = path
        self.method = method
        self.queryItems = queryItems
        self.headers = headers
    }

    func url(baseURL: URL) throws -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: true)
        if !queryItems.isEmpty {
            components?.queryItems = queryItems
        }
        guard let url = components?.url else {
            throw NetworkError.invalidURL
        }
        return url
    }
}

// MARK: - Endpoint Definitions
extension Endpoint {
    // Users
    static var users: Endpoint {
        Endpoint(path: "/users")
    }

    static func user(id: String) -> Endpoint {
        Endpoint(path: "/users/\(id)")
    }

    static func userPosts(userId: String, page: Int = 1, limit: Int = 20) -> Endpoint {
        Endpoint(
            path: "/users/\(userId)/posts",
            queryItems: [
                URLQueryItem(name: "page", value: "\(page)"),
                URLQueryItem(name: "limit", value: "\(limit)")
            ]
        )
    }

    // Posts
    static var posts: Endpoint {
        Endpoint(path: "/posts")
    }

    static func post(id: String) -> Endpoint {
        Endpoint(path: "/posts/\(id)")
    }

    // Auth
    static var login: Endpoint {
        Endpoint(path: "/auth/login", method: .POST)
    }

    static var refreshToken: Endpoint {
        Endpoint(path: "/auth/refresh", method: .POST)
    }
}
```

---

## Models

```swift
// MARK: - API Response Wrappers

struct APIResponse<T: Decodable>: Decodable {
    let data: T
    let meta: Meta?

    struct Meta: Decodable {
        let currentPage: Int?
        let totalPages: Int?
        let totalCount: Int?
    }
}

struct PaginatedResponse<T: Decodable>: Decodable {
    let items: [T]
    let page: Int
    let totalPages: Int
    let totalItems: Int
    let hasMore: Bool
}

// MARK: - Error Response
struct APIErrorResponse: Decodable {
    let message: String
    let code: String?
    let details: [String: String]?
}
```

---

## Authentication

### Token-based Auth with Automatic Refresh

```swift
actor AuthManager {
    private let keychainManager: KeychainManager
    private let apiClient: APIClient
    private var isRefreshing = false
    private var refreshContinuations: [CheckedContinuation<String, Error>] = []

    struct AuthTokens: Codable {
        let accessToken: String
        let refreshToken: String
        let expiresAt: Date
    }

    var currentToken: String? {
        get async {
            guard let tokens = try? keychainManager.retrieve(AuthTokens.self, for: "auth_tokens") else {
                return nil
            }

            // If token is still valid, return it
            if tokens.expiresAt > Date().addingTimeInterval(60) {
                return tokens.accessToken
            }

            // Token expired or about to expire — refresh
            return try? await refreshAccessToken()
        }
    }

    func login(email: String, password: String) async throws -> AuthTokens {
        struct LoginRequest: Encodable {
            let email: String
            let password: String
        }

        let tokens: AuthTokens = try await apiClient.post(
            .login,
            body: LoginRequest(email: email, password: password)
        )

        try keychainManager.store(tokens, for: "auth_tokens")
        await apiClient.setAuthToken(tokens.accessToken)
        return tokens
    }

    func logout() async {
        try? keychainManager.delete(for: "auth_tokens")
        await apiClient.setAuthToken(nil)
    }

    private func refreshAccessToken() async throws -> String {
        // Coalesce concurrent refresh requests
        if isRefreshing {
            return try await withCheckedThrowingContinuation { continuation in
                refreshContinuations.append(continuation)
            }
        }

        isRefreshing = true
        defer {
            isRefreshing = false
            refreshContinuations.removeAll()
        }

        guard let tokens = try? keychainManager.retrieve(AuthTokens.self, for: "auth_tokens") else {
            throw AuthError.notAuthenticated
        }

        struct RefreshRequest: Encodable {
            let refreshToken: String
        }

        let newTokens: AuthTokens = try await apiClient.post(
            .refreshToken,
            body: RefreshRequest(refreshToken: tokens.refreshToken)
        )

        try keychainManager.store(newTokens, for: "auth_tokens")
        await apiClient.setAuthToken(newTokens.accessToken)

        // Resume all waiting continuations
        for continuation in refreshContinuations {
            continuation.resume(returning: newTokens.accessToken)
        }

        return newTokens.accessToken
    }
}
```

---

## Error Handling

```swift
enum NetworkError: LocalizedError {
    case invalidURL
    case invalidResponse
    case noData
    case decodingFailed(Error)
    case unauthorized
    case forbidden
    case notFound
    case rateLimited
    case serverError(statusCode: Int)
    case httpError(statusCode: Int)
    case noConnection
    case timeout

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .invalidResponse: return "Invalid server response"
        case .noData: return "No data received"
        case .decodingFailed(let error): return "Failed to parse response: \(error.localizedDescription)"
        case .unauthorized: return "Authentication required"
        case .forbidden: return "Access denied"
        case .notFound: return "Resource not found"
        case .rateLimited: return "Too many requests. Please try again later."
        case .serverError(let code): return "Server error (\(code))"
        case .httpError(let code): return "Request failed (\(code))"
        case .noConnection: return "No internet connection"
        case .timeout: return "Request timed out"
        }
    }

    var isRetryable: Bool {
        switch self {
        case .serverError, .rateLimited, .timeout, .noConnection:
            return true
        default:
            return false
        }
    }
}

// MARK: - Retry Logic
extension APIClient {
    func fetchWithRetry<T: Decodable>(
        _ endpoint: Endpoint,
        maxRetries: Int = 3,
        retryDelay: Duration = .seconds(1)
    ) async throws -> T {
        var lastError: Error?

        for attempt in 0..<maxRetries {
            do {
                return try await fetch(endpoint)
            } catch let error as NetworkError where error.isRetryable {
                lastError = error
                if attempt < maxRetries - 1 {
                    let delay = retryDelay * Double(attempt + 1)  // exponential backoff
                    try await Task.sleep(for: delay)
                }
            }
        }

        throw lastError ?? NetworkError.invalidResponse
    }
}
```

---

## File Operations

### Upload with Progress

```swift
extension APIClient {
    func upload(
        data: Data,
        to endpoint: Endpoint,
        filename: String,
        mimeType: String,
        onProgress: @Sendable @escaping (Double) -> Void
    ) async throws -> UploadResponse {
        let boundary = UUID().uuidString
        var request = try buildRequest(for: endpoint)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (responseData, response) = try await session.data(for: request)
        try validateResponse(response)
        return try decoder.decode(UploadResponse.self, from: responseData)
    }
}
```

### Download with Progress

```swift
extension APIClient {
    func download(
        from url: URL,
        to localURL: URL,
        onProgress: @Sendable @escaping (Double) -> Void
    ) async throws {
        let (asyncBytes, response) = try await session.bytes(from: url)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw NetworkError.invalidResponse
        }

        let totalBytes = httpResponse.expectedContentLength
        var downloadedBytes: Int64 = 0
        var data = Data()

        for try await byte in asyncBytes {
            data.append(byte)
            downloadedBytes += 1
            if totalBytes > 0 {
                onProgress(Double(downloadedBytes) / Double(totalBytes))
            }
        }

        try data.write(to: localURL)
    }
}
```

---

## WebSocket

```swift
actor WebSocketManager {
    private var webSocketTask: URLSessionWebSocketTask?
    private let session: URLSession
    private var messageStream: AsyncStream<WebSocketMessage>?
    private var messageContinuation: AsyncStream<WebSocketMessage>.Continuation?

    enum WebSocketMessage {
        case text(String)
        case data(Data)
    }

    init(session: URLSession = .shared) {
        self.session = session
    }

    func connect(to url: URL) -> AsyncStream<WebSocketMessage> {
        let (stream, continuation) = AsyncStream<WebSocketMessage>.makeStream()
        self.messageStream = stream
        self.messageContinuation = continuation

        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()

        Task { await receiveMessages() }

        return stream
    }

    func send(_ message: String) async throws {
        try await webSocketTask?.send(.string(message))
    }

    func disconnect() {
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        messageContinuation?.finish()
    }

    private func receiveMessages() async {
        guard let task = webSocketTask else { return }

        do {
            while task.state == .running {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    messageContinuation?.yield(.text(text))
                case .data(let data):
                    messageContinuation?.yield(.data(data))
                @unknown default:
                    break
                }
            }
        } catch {
            messageContinuation?.finish()
        }
    }
}
```

---

## Offline Support

### Network Monitor

```swift
import Network

@Observable
final class NetworkMonitor {
    var isConnected = true
    var connectionType: ConnectionType = .unknown

    enum ConnectionType {
        case wifi, cellular, wired, unknown
    }

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "NetworkMonitor")

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                self?.isConnected = path.status == .satisfied
                self?.connectionType = self?.getConnectionType(path) ?? .unknown
            }
        }
        monitor.start(queue: queue)
    }

    private func getConnectionType(_ path: NWPath) -> ConnectionType {
        if path.usesInterfaceType(.wifi) { return .wifi }
        if path.usesInterfaceType(.cellular) { return .cellular }
        if path.usesInterfaceType(.wiredEthernet) { return .wired }
        return .unknown
    }

    deinit {
        monitor.cancel()
    }
}
```
