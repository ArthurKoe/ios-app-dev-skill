# SwiftUI Reference (iOS 17+)

## Table of Contents
1. [Observable Macro](#observable-macro)
2. [Navigation](#navigation)
3. [State Management](#state-management)
4. [Layout System](#layout-system)
5. [Animations](#animations)
6. [Lists and Collections](#lists-and-collections)
7. [Forms and Input](#forms-and-input)
8. [Sheets, Alerts, and Modals](#sheets-alerts-modals)
9. [Custom Components](#custom-components)
10. [Environment and Preferences](#environment-and-preferences)

---

## Observable Macro

The `@Observable` macro (iOS 17+) replaces `ObservableObject`. It provides fine-grained reactivity — only views that read a specific property re-render when that property changes.

```swift
import Observation

@Observable
final class ProfileViewModel {
    var name: String = ""
    var email: String = ""
    var isLoading: Bool = false
    var errorMessage: String?

    // Properties not read by any view won't trigger re-renders
    var lastFetchTimestamp: Date?

    func loadProfile() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let profile = try await apiClient.fetchProfile()
            name = profile.name
            email = profile.email
            lastFetchTimestamp = Date()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
```

**Using in views:**
```swift
struct ProfileView: View {
    // @State creates and owns the observable object
    @State private var viewModel = ProfileViewModel()

    var body: some View {
        Form {
            TextField("Name", text: $viewModel.name)
            TextField("Email", text: $viewModel.email)
        }
        .task { await viewModel.loadProfile() }
    }
}

// Passing to child views — just pass it directly, no wrapper needed
struct ProfileHeader: View {
    var viewModel: ProfileViewModel  // No @ObservedObject needed

    var body: some View {
        Text(viewModel.name)
    }
}
```

**When to use @State vs @Environment vs plain property:**
- `@State private var viewModel = ...` — The view owns and creates the object
- `@Environment(ViewModel.self)` — Shared across a view subtree
- `var viewModel: ViewModel` — Passed in from parent, view doesn't own it

---

## Navigation

### NavigationStack (iOS 16+)

```swift
struct AppRootView: View {
    @State private var router = Router()

    var body: some View {
        NavigationStack(path: $router.path) {
            HomeView()
                .navigationDestination(for: AppDestination.self) { destination in
                    switch destination {
                    case .userDetail(let id):
                        UserDetailView(userId: id)
                    case .settings:
                        SettingsView()
                    case .editProfile:
                        EditProfileView()
                    }
                }
        }
        .environment(router)
    }
}
```

### TabView

```swift
struct MainTabView: View {
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab("Home", systemImage: "house", value: 0) {
                HomeView()
            }
            Tab("Search", systemImage: "magnifyingglass", value: 1) {
                SearchView()
            }
            Tab("Profile", systemImage: "person", value: 2) {
                ProfileView()
            }
        }
    }
}
```

### Programmatic Navigation

```swift
@Observable
final class Router {
    var path = NavigationPath()

    func navigate(to destination: AppDestination) {
        path.append(destination)
    }

    func pop() {
        guard !path.isEmpty else { return }
        path.removeLast()
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

// Using from any view
struct SomeView: View {
    @Environment(Router.self) private var router

    var body: some View {
        Button("Go to Settings") {
            router.navigate(to: .settings)
        }
    }
}
```

---

## State Management

### Property Wrappers Cheat Sheet

| Wrapper | Use Case |
|---------|----------|
| `@State` | Local view state (value types or @Observable objects the view owns) |
| `@Binding` | Two-way connection to parent's @State |
| `@Environment(\.keyPath)` | System-provided values (colorScheme, locale, dismiss) |
| `@Environment(MyType.self)` | Custom @Observable objects shared via `.environment()` |
| `@AppStorage("key")` | UserDefaults-backed persistent state |
| `@SceneStorage("key")` | Scene-level state restoration |
| `@Query` | SwiftData fetch results |

### Sharing State Across Views

```swift
// Define shared state
@Observable
final class AppState {
    var currentUser: User?
    var isAuthenticated: Bool { currentUser != nil }
    var theme: AppTheme = .system
}

// Inject at root
@main
struct MyApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
        }
    }
}

// Access anywhere in the view tree
struct SomeChildView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        if appState.isAuthenticated {
            Text("Welcome, \(appState.currentUser?.name ?? "")")
        }
    }
}
```

---

## Layout System

### VStack, HStack, ZStack
```swift
// Spacing and alignment
VStack(alignment: .leading, spacing: 12) {
    Text("Title").font(.headline)
    Text("Subtitle").font(.subheadline)
}

HStack(spacing: 8) {
    Image(systemName: "star.fill")
    Text("Favorite")
    Spacer()  // Pushes remaining content to the right
}
```

### Grid (iOS 16+)
```swift
Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
    GridRow {
        Text("Name").fontWeight(.bold)
        Text("Role").fontWeight(.bold)
    }
    Divider().gridCellColumns(2)
    GridRow {
        Text("Alice")
        Text("Developer")
    }
    GridRow {
        Text("Bob")
        Text("Designer")
    }
}
```

### LazyVGrid / LazyHGrid
```swift
let columns = [
    GridItem(.flexible(), spacing: 16),
    GridItem(.flexible(), spacing: 16),
    GridItem(.flexible(), spacing: 16)
]

LazyVGrid(columns: columns, spacing: 16) {
    ForEach(items) { item in
        ItemCard(item: item)
    }
}
```

### GeometryReader (use sparingly)
```swift
GeometryReader { proxy in
    VStack {
        Text("Width: \(proxy.size.width)")
        Text("Height: \(proxy.size.height)")
    }
    .frame(width: proxy.size.width * 0.8)
}
```

### ViewThatFits (iOS 16+)
Automatically picks the first child that fits the available space:
```swift
ViewThatFits {
    // Try this first
    HStack {
        Image(systemName: "star")
        Text("Full Label Text Here")
    }
    // Fall back to this if space is tight
    Image(systemName: "star")
}
```

---

## Animations

```swift
// Implicit animation
Text("Hello")
    .scaleEffect(isExpanded ? 1.5 : 1.0)
    .animation(.spring(duration: 0.3), value: isExpanded)

// Explicit animation
Button("Toggle") {
    withAnimation(.easeInOut(duration: 0.3)) {
        isExpanded.toggle()
    }
}

// Phase animator (iOS 17+)
Text("Pulse")
    .phaseAnimator([false, true]) { content, phase in
        content
            .scaleEffect(phase ? 1.2 : 1.0)
            .opacity(phase ? 0.7 : 1.0)
    }

// Keyframe animation (iOS 17+)
Text("Bounce")
    .keyframeAnimator(initialValue: AnimationValues()) { content, value in
        content
            .scaleEffect(value.scale)
            .offset(y: value.offsetY)
    } keyframes: { _ in
        KeyframeTrack(\.scale) {
            SpringKeyframe(1.2, duration: 0.2)
            SpringKeyframe(1.0, duration: 0.2)
        }
        KeyframeTrack(\.offsetY) {
            SpringKeyframe(-20, duration: 0.2)
            SpringKeyframe(0, duration: 0.3)
        }
    }

// Matched geometry for hero transitions
@Namespace private var heroNamespace

// Source
Image("photo")
    .matchedGeometryEffect(id: "hero", in: heroNamespace)

// Destination (in a different view state)
Image("photo")
    .matchedGeometryEffect(id: "hero", in: heroNamespace)
```

---

## Lists and Collections

```swift
// Basic List with sections
List {
    Section("Active") {
        ForEach(activeItems) { item in
            ItemRow(item: item)
        }
        .onDelete { indexSet in
            viewModel.deleteItems(at: indexSet)
        }
        .onMove { from, to in
            viewModel.moveItems(from: from, to: to)
        }
    }

    Section("Completed") {
        ForEach(completedItems) { item in
            ItemRow(item: item)
        }
    }
}
.listStyle(.insetGrouped)
.searchable(text: $searchText)
.refreshable { await viewModel.refresh() }

// Swipe actions
ForEach(items) { item in
    ItemRow(item: item)
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                viewModel.delete(item)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .swipeActions(edge: .leading) {
            Button {
                viewModel.toggleFavorite(item)
            } label: {
                Label("Favorite", systemImage: "star")
            }
            .tint(.yellow)
        }
}
```

---

## Forms and Input

```swift
Form {
    Section("Personal Info") {
        TextField("Name", text: $name)
            .textContentType(.name)
            .autocorrectionDisabled()

        TextField("Email", text: $email)
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)

        DatePicker("Birthday", selection: $birthday, displayedComponents: .date)
    }

    Section("Preferences") {
        Toggle("Enable Notifications", isOn: $notificationsEnabled)

        Picker("Theme", selection: $selectedTheme) {
            ForEach(Theme.allCases) { theme in
                Text(theme.displayName).tag(theme)
            }
        }

        Stepper("Font Size: \(fontSize)", value: $fontSize, in: 12...24)
    }

    Section {
        Button("Save") {
            Task { await viewModel.save() }
        }
        .disabled(!viewModel.isValid)
    }
}
```

---

## Sheets, Alerts, and Modals

```swift
struct ParentView: View {
    @State private var showSheet = false
    @State private var showAlert = false
    @State private var showConfirmation = false
    @State private var selectedItem: Item?

    var body: some View {
        VStack {
            Button("Show Sheet") { showSheet = true }
            Button("Show Alert") { showAlert = true }
        }
        // Sheet
        .sheet(isPresented: $showSheet) {
            SheetContent()
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        // Item-based sheet
        .sheet(item: $selectedItem) { item in
            ItemDetail(item: item)
        }
        // Alert
        .alert("Delete Item?", isPresented: $showAlert) {
            Button("Delete", role: .destructive) { viewModel.delete() }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This cannot be undone.")
        }
        // Confirmation dialog
        .confirmationDialog("Choose Action", isPresented: $showConfirmation) {
            Button("Edit") { }
            Button("Share") { }
            Button("Delete", role: .destructive) { }
        }
    }
}
```

---

## Custom Components

### Reusable Button Styles
```swift
struct PrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(configuration.isPressed ? Color.blue.opacity(0.8) : Color.blue)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .scaleEffect(configuration.isPressed ? 0.97 : 1.0)
            .animation(.easeOut(duration: 0.15), value: configuration.isPressed)
    }
}

// Usage
Button("Continue") { }
    .buttonStyle(PrimaryButtonStyle())
```

### View Modifiers
```swift
struct CardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding()
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.1), radius: 4, y: 2)
    }
}

extension View {
    func cardStyle() -> some View {
        modifier(CardModifier())
    }
}

// Usage
Text("Hello").cardStyle()
```

---

## Environment and Preferences

### Custom Environment Values (iOS 17+ with @Entry)
```swift
extension EnvironmentValues {
    @Entry var appTheme: AppTheme = .system
    @Entry var apiClient: APIClientProtocol = APIClient.shared
}

// Inject
ContentView()
    .environment(\.appTheme, .dark)

// Read
struct SomeView: View {
    @Environment(\.appTheme) private var theme
}
```

### Preference Key (child-to-parent communication)
```swift
struct ScrollOffsetPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

// Child reports value
GeometryReader { proxy in
    Color.clear.preference(
        key: ScrollOffsetPreferenceKey.self,
        value: proxy.frame(in: .global).minY
    )
}

// Parent reads it
.onPreferenceChange(ScrollOffsetPreferenceKey.self) { offset in
    headerOpacity = min(1, max(0, offset / 100))
}
```
