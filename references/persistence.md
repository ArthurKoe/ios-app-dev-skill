# Data Persistence Reference

## Table of Contents
1. [SwiftData](#swiftdata)
2. [Core Data](#core-data)
3. [Keychain](#keychain)
4. [UserDefaults](#userdefaults)
5. [File Storage](#file-storage)

---

## SwiftData

SwiftData (iOS 17+) is the modern persistence framework. It's built on Core Data but uses Swift-native syntax.

### Model Definition

```swift
import SwiftData

@Model
final class Task {
    @Attribute(.unique) var id: UUID
    var title: String
    var notes: String?
    var isCompleted: Bool
    var priority: Priority
    var dueDate: Date?
    var createdAt: Date

    @Relationship(deleteRule: .cascade, inverse: \Subtask.parentTask)
    var subtasks: [Subtask] = []

    @Relationship(inverse: \Tag.tasks)
    var tags: [Tag] = []

    @Relationship
    var category: Category?

    init(title: String, priority: Priority = .medium, dueDate: Date? = nil) {
        self.id = UUID()
        self.title = title
        self.notes = nil
        self.isCompleted = false
        self.priority = priority
        self.dueDate = dueDate
        self.createdAt = Date()
    }
}

enum Priority: Int, Codable, CaseIterable {
    case low = 0
    case medium = 1
    case high = 2
    case urgent = 3

    var displayName: String {
        switch self {
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        case .urgent: return "Urgent"
        }
    }
}

@Model
final class Subtask {
    var title: String
    var isCompleted: Bool
    var parentTask: Task?

    init(title: String) {
        self.title = title
        self.isCompleted = false
    }
}

@Model
final class Tag {
    @Attribute(.unique) var name: String
    var color: String
    var tasks: [Task] = []

    init(name: String, color: String = "blue") {
        self.name = name
        self.color = color
    }
}

@Model
final class Category {
    @Attribute(.unique) var name: String
    var icon: String

    init(name: String, icon: String) {
        self.name = name
        self.icon = icon
    }
}
```

### Container Setup

```swift
@main
struct TaskApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: [Task.self, Tag.self, Category.self])
    }
}

// Custom configuration
let schema = Schema([Task.self, Tag.self, Category.self])
let config = ModelConfiguration("TaskDB", schema: schema, isStoredInMemoryOnly: false)
let container = try ModelContainer(for: schema, configurations: [config])
```

### Querying

```swift
struct TaskListView: View {
    // Basic query
    @Query var allTasks: [Task]

    // Sorted query
    @Query(sort: \Task.createdAt, order: .reverse)
    var recentTasks: [Task]

    // Filtered and sorted
    @Query(
        filter: #Predicate<Task> { !$0.isCompleted },
        sort: [
            SortDescriptor(\Task.priority, order: .reverse),
            SortDescriptor(\Task.dueDate)
        ]
    )
    var pendingTasks: [Task]

    // Dynamic filtering (build predicate at runtime)
    @Query var tasks: [Task]

    init(showCompleted: Bool) {
        let predicate: Predicate<Task>
        if showCompleted {
            predicate = #Predicate { _ in true }
        } else {
            predicate = #Predicate { !$0.isCompleted }
        }
        _tasks = Query(filter: predicate, sort: \.createdAt)
    }

    var body: some View { ... }
}
```

### CRUD Operations

```swift
struct TaskManager {
    let modelContext: ModelContext

    func createTask(title: String, priority: Priority) {
        let task = Task(title: title, priority: priority)
        modelContext.insert(task)
        try? modelContext.save()
    }

    func deleteTask(_ task: Task) {
        modelContext.delete(task)
        try? modelContext.save()
    }

    func toggleCompletion(_ task: Task) {
        task.isCompleted.toggle()
        try? modelContext.save()
    }

    func fetchTasks(matching predicate: Predicate<Task>) throws -> [Task] {
        let descriptor = FetchDescriptor<Task>(
            predicate: predicate,
            sortBy: [SortDescriptor(\.createdAt, order: .reverse)]
        )
        return try modelContext.fetch(descriptor)
    }

    func countIncompleteTasks() throws -> Int {
        let predicate = #Predicate<Task> { !$0.isCompleted }
        let descriptor = FetchDescriptor<Task>(predicate: predicate)
        return try modelContext.fetchCount(descriptor)
    }
}
```

### Schema Migration

```swift
// Version 1
enum SchemaV1: VersionedSchema {
    static var versionIdentifier = Schema.Version(1, 0, 0)
    static var models: [any PersistentModel.Type] {
        [Task.self]
    }

    @Model
    final class Task {
        var title: String
        var isCompleted: Bool
        init(title: String) {
            self.title = title
            self.isCompleted = false
        }
    }
}

// Version 2 — added priority field
enum SchemaV2: VersionedSchema {
    static var versionIdentifier = Schema.Version(2, 0, 0)
    static var models: [any PersistentModel.Type] {
        [Task.self]
    }

    @Model
    final class Task {
        var title: String
        var isCompleted: Bool
        var priority: Int  // NEW

        init(title: String) {
            self.title = title
            self.isCompleted = false
            self.priority = 1
        }
    }
}

// Migration plan
enum TaskMigrationPlan: SchemaMigrationPlan {
    static var schemas: [any VersionedSchema.Type] {
        [SchemaV1.self, SchemaV2.self]
    }

    static var stages: [MigrationStage] {
        [migrateV1toV2]
    }

    static let migrateV1toV2 = MigrationStage.lightweight(
        fromVersion: SchemaV1.self,
        toVersion: SchemaV2.self
    )
}

// Use in container
let container = try ModelContainer(
    for: SchemaV2.Task.self,
    migrationPlan: TaskMigrationPlan.self
)
```

---

## Core Data

Use Core Data when you need iOS 16 or earlier support, or when SwiftData's performance isn't sufficient.

### Stack Setup

```swift
import CoreData

final class CoreDataStack {
    static let shared = CoreDataStack()

    let container: NSPersistentContainer

    var viewContext: NSManagedObjectContext {
        container.viewContext
    }

    private init() {
        container = NSPersistentContainer(name: "MyApp")
        container.loadPersistentStores { _, error in
            if let error = error {
                fatalError("Core Data stack failed: \(error)")
            }
        }
        container.viewContext.automaticallyMergesChangesFromParent = true
        container.viewContext.mergePolicy = NSMergeByPropertyObjectTrumpMergePolicy
    }

    func newBackgroundContext() -> NSManagedObjectContext {
        let context = container.newBackgroundContext()
        context.mergePolicy = NSMergeByPropertyObjectTrumpMergePolicy
        return context
    }

    func save() {
        let context = viewContext
        guard context.hasChanges else { return }
        do {
            try context.save()
        } catch {
            print("Core Data save error: \(error)")
        }
    }
}
```

---

## Keychain

Secure storage for tokens, passwords, and sensitive data.

```swift
import Security

final class KeychainManager {
    static let shared = KeychainManager()

    enum KeychainError: Error {
        case saveFailed(OSStatus)
        case readFailed(OSStatus)
        case deleteFailed(OSStatus)
        case encodingFailed
        case decodingFailed
    }

    // Store any Codable value
    func store<T: Codable>(_ value: T, for key: String) throws {
        let data = try JSONEncoder().encode(value)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "app",
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        // Delete existing item first
        SecItemDelete(query as CFDictionary)

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    // Retrieve Codable value
    func retrieve<T: Codable>(_ type: T.Type, for key: String) throws -> T {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "app",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError.readFailed(status)
        }

        return try JSONDecoder().decode(type, from: data)
    }

    // Delete
    func delete(for key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: Bundle.main.bundleIdentifier ?? "app"
        ]

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.deleteFailed(status)
        }
    }
}
```

---

## UserDefaults

For non-sensitive preferences and settings. Never store passwords, tokens, or personal data here.

```swift
// Type-safe UserDefaults with @AppStorage
struct SettingsView: View {
    @AppStorage("hasCompletedOnboarding") private var hasOnboarded = false
    @AppStorage("selectedTheme") private var theme = "system"
    @AppStorage("notificationsEnabled") private var notifications = true
    @AppStorage("fontSize") private var fontSize = 16.0

    var body: some View {
        Form {
            Toggle("Notifications", isOn: $notifications)
            Picker("Theme", selection: $theme) {
                Text("System").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            Slider(value: $fontSize, in: 12...24, step: 1)
        }
    }
}

// Programmatic UserDefaults with type-safe keys
extension UserDefaults {
    enum Keys {
        static let lastSyncDate = "lastSyncDate"
        static let cachedUserCount = "cachedUserCount"
    }

    var lastSyncDate: Date? {
        get { object(forKey: Keys.lastSyncDate) as? Date }
        set { set(newValue, forKey: Keys.lastSyncDate) }
    }

    var cachedUserCount: Int {
        get { integer(forKey: Keys.cachedUserCount) }
        set { set(newValue, forKey: Keys.cachedUserCount) }
    }
}
```

---

## File Storage

For documents, images, and cached data.

```swift
final class FileStorageManager {
    static let shared = FileStorageManager()

    private let fileManager = FileManager.default

    // App directories
    var documentsDirectory: URL {
        fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
    }

    var cachesDirectory: URL {
        fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first!
    }

    // Save Codable object
    func save<T: Codable>(_ object: T, to filename: String, in directory: URL? = nil) throws {
        let dir = directory ?? documentsDirectory
        let url = dir.appendingPathComponent(filename)
        let data = try JSONEncoder().encode(object)
        try data.write(to: url, options: .atomic)
    }

    // Load Codable object
    func load<T: Codable>(_ type: T.Type, from filename: String, in directory: URL? = nil) throws -> T {
        let dir = directory ?? documentsDirectory
        let url = dir.appendingPathComponent(filename)
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(type, from: data)
    }

    // Save image
    func saveImage(_ image: UIImage, name: String, quality: CGFloat = 0.8) throws -> URL {
        guard let data = image.jpegData(compressionQuality: quality) else {
            throw FileError.compressionFailed
        }
        let url = cachesDirectory.appendingPathComponent("\(name).jpg")
        try data.write(to: url)
        return url
    }

    // Clear cache
    func clearCache() throws {
        let contents = try fileManager.contentsOfDirectory(at: cachesDirectory, includingPropertiesForKeys: nil)
        for url in contents {
            try fileManager.removeItem(at: url)
        }
    }

    // File size
    func fileSize(at url: URL) -> Int64 {
        let attributes = try? fileManager.attributesOfItem(atPath: url.path)
        return (attributes?[.size] as? Int64) ?? 0
    }
}
```
