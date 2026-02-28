# Architecture Patterns Reference

## Table of Contents
1. [MVVM with @Observable](#mvvm)
2. [The Composable Architecture (TCA)](#tca)
3. [Clean Architecture](#clean-architecture)
4. [Coordinator Pattern](#coordinator-pattern)
5. [Repository Pattern](#repository-pattern)

---

## MVVM

The recommended default for most iOS apps. With `@Observable`, MVVM becomes very lightweight.

### Complete Example

```swift
// MARK: - Model
struct User: Codable, Identifiable {
    let id: String
    let name: String
    let email: String
    let avatarURL: URL?
}

// MARK: - ViewModel
@Observable
final class UserListViewModel {
    var users: [User] = []
    var isLoading = false
    var errorMessage: String?
    var searchText = ""

    var filteredUsers: [User] {
        if searchText.isEmpty { return users }
        return users.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
    }

    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient()) {
        self.apiClient = apiClient
    }

    func loadUsers() async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }

        do {
            users = try await apiClient.fetch(.users)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func deleteUser(_ user: User) async {
        do {
            try await apiClient.delete(.user(id: user.id))
            users.removeAll { $0.id == user.id }
        } catch {
            errorMessage = "Failed to delete user"
        }
    }
}

// MARK: - View
struct UserListView: View {
    @State private var viewModel = UserListViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.users.isEmpty {
                    ProgressView("Loading...")
                } else if let error = viewModel.errorMessage, viewModel.users.isEmpty {
                    ContentUnavailableView {
                        Label("Error", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button("Retry") { Task { await viewModel.loadUsers() } }
                    }
                } else {
                    userList
                }
            }
            .navigationTitle("Users")
            .searchable(text: $viewModel.searchText)
            .refreshable { await viewModel.loadUsers() }
            .task { await viewModel.loadUsers() }
        }
    }

    private var userList: some View {
        List(viewModel.filteredUsers) { user in
            NavigationLink(value: AppDestination.userDetail(userId: user.id)) {
                UserRow(user: user)
            }
            .swipeActions(edge: .trailing) {
                Button(role: .destructive) {
                    Task { await viewModel.deleteUser(user) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
    }
}
```

### Guidelines for MVVM
- ViewModel handles all state and logic. Views are passive.
- ViewModels don't import SwiftUI (they import Observation and Foundation).
- One ViewModel per screen (or per major component).
- Use protocols for dependencies so ViewModels are testable.
- Computed properties for derived state (like `filteredUsers`).

---

## TCA

The Composable Architecture uses unidirectional data flow. Every feature has State, Action, Reducer, and an optional Effect.

### Setup
Add TCA as SPM dependency:
```swift
.package(url: "https://github.com/pointfreeco/swift-composable-architecture", from: "1.0.0")
```

### Complete Feature Example

```swift
import ComposableArchitecture

@Reducer
struct CounterFeature {
    @ObservableState
    struct State: Equatable {
        var count = 0
        var isTimerRunning = false
    }

    enum Action {
        case increment
        case decrement
        case toggleTimer
        case timerTick
    }

    enum CancelID {
        case timer
    }

    var body: some ReducerOf<Self> {
        Reduce { state, action in
            switch action {
            case .increment:
                state.count += 1
                return .none

            case .decrement:
                state.count -= 1
                return .none

            case .toggleTimer:
                state.isTimerRunning.toggle()
                if state.isTimerRunning {
                    return .run { send in
                        while true {
                            try await Task.sleep(for: .seconds(1))
                            await send(.timerTick)
                        }
                    }
                    .cancellable(id: CancelID.timer)
                } else {
                    return .cancel(id: CancelID.timer)
                }

            case .timerTick:
                state.count += 1
                return .none
            }
        }
    }
}

struct CounterView: View {
    let store: StoreOf<CounterFeature>

    var body: some View {
        VStack(spacing: 20) {
            Text("\(store.count)")
                .font(.largeTitle)

            HStack(spacing: 20) {
                Button("-") { store.send(.decrement) }
                Button("+") { store.send(.increment) }
            }
            .font(.title)

            Button(store.isTimerRunning ? "Stop Timer" : "Start Timer") {
                store.send(.toggleTimer)
            }
        }
    }
}
```

### Composing Features

```swift
@Reducer
struct AppFeature {
    @ObservableState
    struct State: Equatable {
        var counter = CounterFeature.State()
        var userList = UserListFeature.State()
        var selectedTab = 0
    }

    enum Action {
        case counter(CounterFeature.Action)
        case userList(UserListFeature.Action)
        case tabSelected(Int)
    }

    var body: some ReducerOf<Self> {
        Scope(state: \.counter, action: \.counter) {
            CounterFeature()
        }
        Scope(state: \.userList, action: \.userList) {
            UserListFeature()
        }
        Reduce { state, action in
            switch action {
            case .tabSelected(let tab):
                state.selectedTab = tab
                return .none
            case .counter, .userList:
                return .none
            }
        }
    }
}
```

### When to Use TCA
- Apps with complex, interconnected state
- Teams that benefit from a strict, standardized pattern
- When exhaustive testability is a requirement
- Apps with complex side effects (timers, WebSockets, location tracking)

---

## Clean Architecture

Separates the app into layers with clear dependency rules: outer layers depend on inner layers, never the reverse.

```
Presentation → Domain ← Data
     ↓            ↑        ↑
   Views      Use Cases   Repos
              Entities   API/DB
```

### Layer Definitions

```swift
// MARK: - Domain Layer (innermost, no external dependencies)

// Entity
struct Product: Identifiable {
    let id: String
    let name: String
    let price: Decimal
    let category: Category
}

// Repository Protocol (defined in domain, implemented in data)
protocol ProductRepository {
    func fetchAll() async throws -> [Product]
    func fetch(id: String) async throws -> Product
    func save(_ product: Product) async throws
}

// Use Case
struct FetchProductsUseCase {
    private let repository: ProductRepository

    init(repository: ProductRepository) {
        self.repository = repository
    }

    func execute() async throws -> [Product] {
        try await repository.fetchAll()
    }
}

// MARK: - Data Layer (implements domain protocols)

struct ProductRepositoryImpl: ProductRepository {
    private let apiClient: APIClientProtocol
    private let cache: ProductCache

    func fetchAll() async throws -> [Product] {
        if let cached = cache.getAll(), !cached.isExpired {
            return cached.products
        }
        let products: [Product] = try await apiClient.fetch(.products)
        cache.store(products)
        return products
    }

    func fetch(id: String) async throws -> Product {
        try await apiClient.fetch(.product(id: id))
    }

    func save(_ product: Product) async throws {
        try await apiClient.post(.products, body: product)
    }
}

// MARK: - Presentation Layer

@Observable
final class ProductListViewModel {
    var products: [Product] = []
    var isLoading = false

    private let fetchProducts: FetchProductsUseCase

    init(fetchProducts: FetchProductsUseCase) {
        self.fetchProducts = fetchProducts
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            products = try await fetchProducts.execute()
        } catch {
            // handle error
        }
    }
}
```

### When to Use Clean Architecture
- Large apps with multiple developers
- Apps that may need to swap backends (REST → GraphQL, CoreData → SwiftData)
- Enterprise apps with strict separation requirements
- When domain logic is complex enough to warrant its own layer

---

## Coordinator Pattern

Centralizes navigation logic outside of views. Useful for apps with complex navigation flows.

```swift
@Observable
final class AppCoordinator {
    var path = NavigationPath()
    var sheet: Sheet?
    var fullScreenCover: FullScreenCover?

    enum Sheet: Identifiable {
        case createItem
        case editItem(Item)
        case settings

        var id: String {
            switch self {
            case .createItem: return "create"
            case .editItem(let item): return "edit-\(item.id)"
            case .settings: return "settings"
            }
        }
    }

    enum FullScreenCover: Identifiable {
        case onboarding
        case camera

        var id: String {
            switch self {
            case .onboarding: return "onboarding"
            case .camera: return "camera"
            }
        }
    }

    func showCreateItem() { sheet = .createItem }
    func showSettings() { sheet = .settings }
    func showOnboarding() { fullScreenCover = .onboarding }

    func navigate(to destination: AppDestination) {
        path.append(destination)
    }

    func dismissSheet() { sheet = nil }
    func dismissCover() { fullScreenCover = nil }
}

// Root view uses coordinator for all navigation
struct CoordinatedRootView: View {
    @State private var coordinator = AppCoordinator()

    var body: some View {
        NavigationStack(path: $coordinator.path) {
            HomeView()
                .navigationDestination(for: AppDestination.self) { dest in
                    destinationView(for: dest)
                }
        }
        .sheet(item: $coordinator.sheet) { sheet in
            sheetView(for: sheet)
        }
        .fullScreenCover(item: $coordinator.fullScreenCover) { cover in
            coverView(for: cover)
        }
        .environment(coordinator)
    }

    @ViewBuilder
    private func destinationView(for destination: AppDestination) -> some View {
        switch destination {
        case .userDetail(let id): UserDetailView(userId: id)
        case .settings: SettingsView()
        case .editProfile: EditProfileView()
        }
    }
}
```

---

## Repository Pattern

Abstracts data access behind a clean interface. The rest of the app doesn't know or care whether data comes from an API, database, or cache.

```swift
protocol UserRepository: Sendable {
    func getAll() async throws -> [User]
    func get(id: String) async throws -> User
    func create(_ user: User) async throws -> User
    func update(_ user: User) async throws -> User
    func delete(id: String) async throws
}

actor UserRepositoryImpl: UserRepository {
    private let apiClient: APIClientProtocol
    private let localStorage: UserLocalStorage
    private var cache: [String: User] = [:]

    init(apiClient: APIClientProtocol, localStorage: UserLocalStorage) {
        self.apiClient = apiClient
        self.localStorage = localStorage
    }

    func getAll() async throws -> [User] {
        // Try cache first
        if !cache.isEmpty {
            return Array(cache.values)
        }

        // Try local storage
        if let local = try? await localStorage.fetchAll(), !local.isEmpty {
            local.forEach { cache[$0.id] = $0 }
            // Refresh from API in background
            Task { try? await refreshFromAPI() }
            return local
        }

        // Fall back to API
        return try await refreshFromAPI()
    }

    @discardableResult
    private func refreshFromAPI() async throws -> [User] {
        let users: [User] = try await apiClient.fetch(.users)
        users.forEach { cache[$0.id] = $0 }
        try? await localStorage.saveAll(users)
        return users
    }

    func get(id: String) async throws -> User {
        if let cached = cache[id] { return cached }
        let user: User = try await apiClient.fetch(.user(id: id))
        cache[id] = user
        return user
    }

    func create(_ user: User) async throws -> User {
        let created: User = try await apiClient.post(.users, body: user)
        cache[created.id] = created
        return created
    }

    func update(_ user: User) async throws -> User {
        let updated: User = try await apiClient.put(.user(id: user.id), body: user)
        cache[updated.id] = updated
        return updated
    }

    func delete(id: String) async throws {
        try await apiClient.delete(.user(id: id))
        cache.removeValue(forKey: id)
    }
}
```
