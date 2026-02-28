# Swift Concurrency Reference

## Table of Contents
1. [Async/Await Basics](#async-await)
2. [Actors](#actors)
3. [Task and TaskGroup](#task-and-taskgroup)
4. [Sendable](#sendable)
5. [AsyncSequence and AsyncStream](#asyncsequence)
6. [MainActor](#mainactor)
7. [Common Patterns](#common-patterns)

---

## Async/Await

```swift
// Basic async function
func fetchUser(id: String) async throws -> User {
    let url = URL(string: "https://api.example.com/users/\(id)")!
    let (data, _) = try await URLSession.shared.data(from: url)
    return try JSONDecoder().decode(User.self, from: data)
}

// Calling from SwiftUI
struct UserView: View {
    @State private var user: User?

    var body: some View {
        Text(user?.name ?? "Loading...")
            .task {
                // .task automatically cancels when view disappears
                user = try? await fetchUser(id: "123")
            }
    }
}

// Sequential execution
func loadDashboard() async throws -> Dashboard {
    let user = try await fetchUser(id: "me")        // waits
    let stats = try await fetchStats(for: user.id)   // then this
    return Dashboard(user: user, stats: stats)
}

// Parallel execution with async let
func loadDashboardFast() async throws -> Dashboard {
    async let user = fetchUser(id: "me")
    async let stats = fetchGlobalStats()
    async let notifications = fetchNotifications()

    // All three run concurrently; we await them together
    return try await Dashboard(
        user: user,
        stats: stats,
        notifications: notifications
    )
}
```

---

## Actors

Actors protect mutable state from data races. Only one task can access an actor's properties at a time.

```swift
actor ImageCache {
    private var cache: [URL: UIImage] = [:]
    private var inProgress: [URL: Task<UIImage, Error>] = [:]

    func image(for url: URL) async throws -> UIImage {
        // Return cached image
        if let cached = cache[url] {
            return cached
        }

        // Coalesce duplicate requests
        if let existing = inProgress[url] {
            return try await existing.value
        }

        // Start new download
        let task = Task {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard let image = UIImage(data: data) else {
                throw ImageError.invalidData
            }
            return image
        }

        inProgress[url] = task

        do {
            let image = try await task.value
            cache[url] = image
            inProgress.removeValue(forKey: url)
            return image
        } catch {
            inProgress.removeValue(forKey: url)
            throw error
        }
    }

    func clearCache() {
        cache.removeAll()
    }
}

// Usage — every call to the actor is automatically serialized
let cache = ImageCache()
let image = try await cache.image(for: imageURL)
```

### nonisolated

```swift
actor UserStore {
    let id: String  // let properties are safe to access without isolation

    nonisolated var displayId: String {
        "user-\(id)"  // No await needed because id is immutable
    }

    var name: String  // var requires isolation

    func updateName(_ newName: String) {
        name = newName
    }
}

// id and displayId can be accessed without await
let store = UserStore(id: "123")
print(store.displayId)  // No await
let name = await store.name  // Requires await
```

---

## Task and TaskGroup

### Task
```swift
// Unstructured task — runs independently
func startBackgroundSync() {
    Task {
        await syncData()
    }
}

// Detached task — no inherited context (use sparingly)
Task.detached(priority: .background) {
    await heavyComputation()
}

// Task cancellation
func fetchWithCancellation() async throws -> [Item] {
    var items: [Item] = []

    for page in 1...10 {
        // Check for cancellation before expensive work
        try Task.checkCancellation()

        let pageItems = try await fetchPage(page)
        items.append(contentsOf: pageItems)
    }

    return items
}

// Cancellation from SwiftUI
struct ListView: View {
    @State private var task: Task<Void, Never>?

    var body: some View {
        List { ... }
            .onAppear {
                task = Task { await loadData() }
            }
            .onDisappear {
                task?.cancel()  // Cancel when view disappears
            }
    }
}
```

### TaskGroup
```swift
// Process items in parallel with controlled concurrency
func fetchAllUsers(ids: [String]) async throws -> [User] {
    try await withThrowingTaskGroup(of: User.self) { group in
        for id in ids {
            group.addTask {
                try await fetchUser(id: id)
            }
        }

        var users: [User] = []
        for try await user in group {
            users.append(user)
        }
        return users
    }
}

// With concurrency limit
func downloadImages(urls: [URL], maxConcurrent: Int = 4) async throws -> [UIImage] {
    try await withThrowingTaskGroup(of: UIImage.self) { group in
        var images: [UIImage] = []
        var urlIterator = urls.makeIterator()

        // Start initial batch
        for _ in 0..<min(maxConcurrent, urls.count) {
            if let url = urlIterator.next() {
                group.addTask { try await downloadImage(url) }
            }
        }

        // As each completes, start the next
        for try await image in group {
            images.append(image)
            if let url = urlIterator.next() {
                group.addTask { try await downloadImage(url) }
            }
        }

        return images
    }
}
```

---

## Sendable

Types that are safe to share across concurrency boundaries.

```swift
// Value types are implicitly Sendable
struct UserDTO: Sendable, Codable {
    let id: String
    let name: String
}

// Final classes with immutable stored properties
final class AppConfig: Sendable {
    let apiURL: URL
    let apiKey: String

    init(apiURL: URL, apiKey: String) {
        self.apiURL = apiURL
        self.apiKey = apiKey
    }
}

// @unchecked Sendable — when you manage thread safety yourself
final class ThreadSafeCache: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Any] = [:]

    func get(_ key: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }

    func set(_ key: String, value: Any) {
        lock.lock()
        defer { lock.unlock() }
        storage[key] = value
    }
}

// Sendable closures
func process(items: [Item], transform: @Sendable (Item) -> Item) async -> [Item] {
    await withTaskGroup(of: Item.self) { group in
        for item in items {
            group.addTask { transform(item) }
        }
        var results: [Item] = []
        for await result in group {
            results.append(result)
        }
        return results
    }
}
```

---

## AsyncSequence

```swift
// Built-in async sequences
func readLines(from url: URL) async throws {
    for try await line in url.lines {
        print(line)
    }
}

// URLSession bytes
func streamDownload(url: URL) async throws {
    let (bytes, _) = try await URLSession.shared.bytes(from: url)
    var data = Data()
    for try await byte in bytes {
        data.append(byte)
    }
}
```

### AsyncStream

Create custom async sequences for bridging callback-based APIs.

```swift
// Location updates as AsyncStream
import CoreLocation

class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()
    private var continuation: AsyncStream<CLLocation>.Continuation?

    var locations: AsyncStream<CLLocation> {
        AsyncStream { continuation in
            self.continuation = continuation
            manager.delegate = self
            manager.startUpdatingLocation()

            continuation.onTermination = { _ in
                self.manager.stopUpdatingLocation()
            }
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        for location in locations {
            continuation?.yield(location)
        }
    }
}

// Usage
let service = LocationService()
for await location in service.locations {
    print("Lat: \(location.coordinate.latitude), Lon: \(location.coordinate.longitude)")
}
```

---

## MainActor

Ensure code runs on the main thread (required for UI updates).

```swift
// Annotate entire class
@MainActor
@Observable
final class ProfileViewModel {
    var name = ""
    var isLoading = false

    func load() async {
        isLoading = true  // Safe — we're on MainActor
        let profile = try? await apiClient.fetchProfile()
        name = profile?.name ?? ""
        isLoading = false
    }
}

// Annotate specific functions
class DataProcessor {
    func process() async -> Result {
        let data = await heavyComputation()

        // Switch to main thread for UI update
        await MainActor.run {
            updateUI(with: data)
        }

        return data
    }
}
```

---

## Common Patterns

### Debounce Search

```swift
@Observable
final class SearchViewModel {
    var query = ""
    var results: [SearchResult] = []
    private var searchTask: Task<Void, Never>?

    func search() {
        searchTask?.cancel()

        searchTask = Task {
            // Wait 300ms for user to stop typing
            try? await Task.sleep(for: .milliseconds(300))

            guard !Task.isCancelled else { return }

            let results = try? await apiClient.search(query: query)
            if !Task.isCancelled {
                self.results = results ?? []
            }
        }
    }
}
```

### Timeout

```swift
func fetchWithTimeout<T>(_ operation: @Sendable () async throws -> T, timeout: Duration) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            try await operation()
        }

        group.addTask {
            try await Task.sleep(for: timeout)
            throw TimeoutError()
        }

        let result = try await group.next()!
        group.cancelAll()
        return result
    }
}

// Usage
let user = try await fetchWithTimeout({
    try await apiClient.fetchUser(id: "123")
}, timeout: .seconds(10))
```

### Publisher Bridge (Combine → async/await)

```swift
import Combine

extension Publisher where Failure == Never {
    var values: AsyncStream<Output> {
        AsyncStream { continuation in
            let cancellable = self.sink { value in
                continuation.yield(value)
            }
            continuation.onTermination = { _ in
                cancellable.cancel()
            }
        }
    }
}
```
