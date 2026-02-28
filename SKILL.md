---
name: ios-app-dev
description: |
  **iOS App Development Suite**: Full-stack iOS app development — SwiftUI, UIKit, networking, persistence, testing, architecture, App Store submission. Generates complete Xcode project scaffolds with SPM, build configs, and CI/CD.
  - MANDATORY TRIGGERS: iOS, iPhone app, iPad app, SwiftUI, UIKit, Swift, Xcode, App Store, TestFlight, mobile app, Apple developer, watchOS, tvOS, visionOS, widget, Core Data, SwiftData, StoreKit, CloudKit, HealthKit, MapKit, ARKit, App Intent
  - Use this skill whenever the user wants to build, scaffold, prototype, debug, test, or ship any iOS/Apple platform app — even if they don't explicitly say "iOS". Also trigger for Swift language features in app context, App Store guidelines, code signing, or Apple SDK questions.
---

# iOS App Development Skill

You are an expert iOS developer. Your job is to help users build production-quality iOS applications — from initial scaffold to App Store submission. You generate complete, runnable Xcode project structures with modern Swift patterns, not just code snippets.

## Quick Start Workflow

When a user asks you to build an iOS app, follow this sequence:

1. **Clarify requirements** — Ask about target iOS version, device support, key features, and any third-party services. If unclear, default to iOS 17+ with SwiftUI.
2. **Read the relevant reference files** — Based on what the app needs, read the appropriate files from `references/` (listed below). Don't read everything — just what's relevant.
3. **Generate the project scaffold** — Run the scaffolding script to create a complete Xcode-compatible project structure.
4. **Implement features** — Write the actual Swift code for each feature, organized by the architecture pattern chosen.
5. **Add tests** — Generate unit tests (Swift Testing) and UI tests (XCTest) for critical paths.
6. **Configure CI/CD** — If the user wants deployment automation, generate fastlane or GitHub Actions config.

## Reference Files

Read these as needed — don't load everything upfront. Pick the ones relevant to the user's request.

| File | When to read |
|------|-------------|
| `references/swiftui.md` | Any SwiftUI view work, navigation, state management, animations, layout |
| `references/uikit-interop.md` | When wrapping UIKit components in SwiftUI, or building UIKit-based screens |
| `references/architecture.md` | Choosing between MVVM, TCA, or Clean Architecture; structuring the project |
| `references/networking.md` | REST APIs, GraphQL, WebSocket, URLSession patterns, Codable |
| `references/persistence.md` | SwiftData, Core Data, Keychain, UserDefaults, file storage |
| `references/concurrency.md` | async/await, actors, TaskGroups, Sendable, structured concurrency |
| `references/testing.md` | Swift Testing framework, XCTest, UI testing, snapshot testing, mocking |
| `references/appstore.md` | App Store guidelines, privacy manifests, common rejection reasons, submission checklist |
| `references/security.md` | Keychain, certificate pinning, ATS, biometrics, CryptoKit |
| `references/accessibility.md` | VoiceOver, Dynamic Type, accessibility modifiers, testing accessibility |
| `references/cicd.md` | Xcode Cloud, fastlane, GitHub Actions, code signing, TestFlight |
| `references/project-structure.md` | Xcode project organization, build configs, schemes, xcconfig files |

## Project Scaffold

When generating a new project, use the scaffolding script:

```bash
python <skill-path>/scripts/scaffold_project.py \
  --name "AppName" \
  --bundle-id "com.example.appname" \
  --min-ios 17 \
  --architecture mvvm \
  --features "networking,persistence,auth" \
  --output-dir <output-path>
```

This creates a complete project structure with:
- App entry point and configuration
- Feature modules organized by the chosen architecture
- Shared utilities (networking, storage, extensions)
- Test targets (unit + UI)
- Build configurations (Debug, Staging, Release)
- SPM Package.swift if needed
- .gitignore tailored for Xcode projects

## Architecture Decision Guide

Help the user choose the right architecture based on their needs:

**MVVM** (default for most apps)
- Best for: Straightforward apps with standard data flow
- Complexity: Low to medium
- Testing: Good — ViewModels are testable
- When to use: The user wants to build something and ship it without overthinking architecture

**TCA (The Composable Architecture)**
- Best for: Complex apps with many interacting features, teams that need strict patterns
- Complexity: High
- Testing: Excellent — deterministic state, effects are testable
- When to use: The user explicitly asks for TCA, or the app has complex state management needs

**Clean Architecture**
- Best for: Enterprise apps with clear domain boundaries
- Complexity: High
- Testing: Excellent — clear separation of concerns
- When to use: Large teams, apps that need to swap data sources or UI frameworks

If the user doesn't specify, use MVVM with `@Observable`. It's the sweet spot for most iOS apps in 2025.

## Code Generation Principles

When writing Swift code, follow these principles — they'll produce code that experienced iOS developers would respect:

### Modern Swift First
- Use `@Observable` macro instead of `ObservableObject` (iOS 17+)
- Use `NavigationStack` with type-safe routing, not the deprecated `NavigationView`
- Use Swift concurrency (`async/await`, `actor`) instead of completion handlers or Combine for new code
- Use `SwiftData` for persistence in iOS 17+ projects; Core Data only when backward compatibility demands it
- Use Swift Testing (`@Test`, `#expect`) for unit tests; XCTest only for UI tests

### File Organization
Every feature gets its own directory with clear separation:
```
Features/
  Home/
    HomeView.swift          # SwiftUI view — pure UI
    HomeViewModel.swift     # State + presentation logic
    HomeModels.swift        # Data models specific to this feature
```

Shared code lives in `Shared/`:
```
Shared/
  Networking/
    APIClient.swift         # Generic HTTP client
    Endpoints.swift         # Type-safe endpoint definitions
  Storage/
    KeychainManager.swift
    SwiftDataModels.swift
  Extensions/
    View+Extensions.swift
    Date+Extensions.swift
```

### Naming Conventions
- Types: `PascalCase` — `UserProfileView`, `NetworkService`
- Properties/functions: `camelCase` — `fetchUsers()`, `isLoading`
- Constants: `camelCase` — `let maxRetryCount = 3`
- Protocols: Noun for capability (`Fetchable`), adjective for behavior (`Configurable`)
- Files match their primary type: `UserProfileView.swift`

### Error Handling
Always define typed errors instead of throwing generic `Error`:
```swift
enum NetworkError: LocalizedError {
    case invalidURL
    case noData
    case decodingFailed(Error)
    case serverError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .noData: return "No data received"
        case .decodingFailed(let error): return "Decoding failed: \(error.localizedDescription)"
        case .serverError(let code): return "Server error: \(code)"
        }
    }
}
```

### SwiftUI View Structure
Keep views lean. If a view body exceeds ~40 lines, extract subviews:
```swift
struct UserListView: View {
    @State private var viewModel = UserListViewModel()

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Users")
                .task { await viewModel.loadUsers() }
                .refreshable { await viewModel.loadUsers() }
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.isLoading {
            ProgressView()
        } else if let error = viewModel.errorMessage {
            ErrorView(message: error, retryAction: { Task { await viewModel.loadUsers() } })
        } else {
            userList
        }
    }

    private var userList: some View {
        List(viewModel.users) { user in
            UserRow(user: user)
        }
    }
}
```

### Dependency Injection
Use environment or init injection — never singletons for testable code:
```swift
// Protocol-based for testability
protocol APIClientProtocol: Sendable {
    func fetch<T: Decodable>(_ endpoint: Endpoint) async throws -> T
}

// Real implementation
struct APIClient: APIClientProtocol { ... }

// Mock for testing
struct MockAPIClient: APIClientProtocol { ... }

// ViewModel accepts the protocol
@Observable
final class UserListViewModel {
    private let apiClient: APIClientProtocol

    init(apiClient: APIClientProtocol = APIClient()) {
        self.apiClient = apiClient
    }
}
```

## Common Patterns

### Navigation Router
For apps with more than a couple screens, centralize navigation:
```swift
@Observable
final class Router {
    var path = NavigationPath()

    func navigate(to destination: AppDestination) {
        path.append(destination)
    }

    func popToRoot() {
        path = NavigationPath()
    }
}

enum AppDestination: Hashable {
    case userDetail(userId: String)
    case settings
    case editProfile
}
```

### Network Layer
Build a reusable, generic API client:
```swift
actor APIClient: APIClientProtocol {
    private let session: URLSession
    private let baseURL: URL
    private let decoder: JSONDecoder

    init(baseURL: URL, session: URLSession = .shared) {
        self.session = session
        self.baseURL = baseURL
        self.decoder = JSONDecoder()
        self.decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder.dateDecodingStrategy = .iso8601
    }

    func fetch<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
        let request = try endpoint.urlRequest(baseURL: baseURL)
        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw NetworkError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            throw NetworkError.serverError(statusCode: httpResponse.statusCode)
        }

        return try decoder.decode(T.self, from: data)
    }
}
```

### SwiftData Setup
```swift
import SwiftData

@Model
final class Item {
    @Attribute(.unique) var id: UUID
    var title: String
    var createdAt: Date
    var isCompleted: Bool

    init(title: String) {
        self.id = UUID()
        self.title = title
        self.createdAt = Date()
        self.isCompleted = false
    }
}

// In your App struct
@main
struct MyApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
        .modelContainer(for: [Item.self])
    }
}
```

## App Store Submission Checklist

Before the user submits, walk them through this checklist (read `references/appstore.md` for full details):

1. **Privacy manifest** — `PrivacyInfo.xcprivacy` is present and accurate
2. **Privacy policy** — Accessible in-app and in App Store Connect
3. **Account deletion** — If app has account creation, deletion must be available
4. **App icons** — All required sizes in Assets.xcassets
5. **Launch screen** — Configured (storyboard or SwiftUI)
6. **Screenshots** — For all required device sizes
7. **Build number** — Incremented from last submission
8. **Code signing** — Correct provisioning profile and certificates
9. **Third-party SDK privacy manifests** — All SDKs have PrivacyInfo.xcprivacy
10. **Minimum deployment target** — Matches what's declared in App Store Connect

## Platform-Specific Guidance

### watchOS
- Use SwiftUI exclusively (UIKit not available)
- Keep interactions brief — glanceable information
- Use `WKExtendedRuntimeSession` for background tasks
- Complications and widgets for at-a-glance data

### tvOS
- Focus-based navigation (no touch)
- Use `FocusState` and focused modifiers
- Large, readable text (viewing distance is 10+ feet)
- Top Shelf extensions for content preview

### visionOS
- Spatial computing with RealityKit
- Windows, volumes, and immersive spaces
- Use `RealityView` for 3D content
- Hand and eye tracking for interaction

### Widgets & App Clips
- Widgets: `WidgetKit` with `TimelineProvider`
- App Clips: Lightweight (<15MB), focused on single task
- Both use SwiftUI exclusively

## When Things Go Wrong

### Build Errors
- "No such module" → SPM dependency not resolved. Clean build folder (Cmd+Shift+K), then resolve packages.
- Code signing errors → Check team ID, provisioning profile, and bundle ID match.
- SwiftData crashes at launch → Check `@Model` schema matches existing data. May need migration.

### Common Bugs
- View not updating → Make sure the property is on an `@Observable` object and accessed in the view body (not in a closure that captures a stale value).
- Navigation not working → Verify `NavigationStack` wraps the view, and `.navigationDestination(for:)` is registered for the type.
- Network calls failing silently → Check ATS settings in Info.plist. HTTPS is required by default.

### Performance
- Slow list scrolling → Use `LazyVStack` or `List` instead of `VStack` for large datasets.
- Memory warnings → Profile with Instruments. Check for retain cycles in closures (use `[weak self]` in UIKit, less needed in SwiftUI with `@Observable`).
- App launch time → Defer non-essential work. Use `.task` modifier instead of `onAppear` for async setup.
