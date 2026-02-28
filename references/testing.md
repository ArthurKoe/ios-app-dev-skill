# Testing Reference

## Table of Contents
1. [Swift Testing Framework](#swift-testing)
2. [XCTest for UI Testing](#xctest-ui)
3. [Mocking and Dependency Injection](#mocking)
4. [Testing ViewModels](#testing-viewmodels)
5. [Testing Async Code](#testing-async)
6. [Snapshot Testing](#snapshot-testing)

---

## Swift Testing

Swift Testing (available from Xcode 16) is the modern unit testing framework. It uses `@Test` macros and `#expect` assertions.

### Basic Tests

```swift
import Testing

@Test("User creation sets default values")
func userCreation() {
    let user = User(name: "Alice", email: "alice@example.com")

    #expect(user.name == "Alice")
    #expect(user.email == "alice@example.com")
    #expect(user.id != nil)
    #expect(user.createdAt != nil)
}

@Test("Empty name is invalid")
func emptyNameValidation() {
    let user = User(name: "", email: "alice@example.com")
    #expect(!user.isValid)
}

@Test("Division by zero throws")
func divisionByZero() {
    #expect(throws: MathError.divisionByZero) {
        try Calculator.divide(10, by: 0)
    }
}
```

### Parameterized Tests

```swift
@Test("Email validation", arguments: [
    ("alice@example.com", true),
    ("bob@test.org", true),
    ("invalid-email", false),
    ("@no-user.com", false),
    ("user@", false),
    ("", false)
])
func emailValidation(email: String, isValid: Bool) {
    #expect(EmailValidator.isValid(email) == isValid)
}

// With custom types
enum Currency: CaseIterable {
    case usd, eur, gbp, jpy
}

@Test("Currency formatting", arguments: Currency.allCases)
func currencyFormatting(currency: Currency) {
    let formatted = CurrencyFormatter.format(100.0, currency: currency)
    #expect(!formatted.isEmpty)
    #expect(formatted.contains("100"))
}
```

### Tags and Organization

```swift
extension Tag {
    @Tag static var networking: Self
    @Tag static var persistence: Self
    @Tag static var validation: Self
    @Tag static var slow: Self
}

@Test("API fetch succeeds", .tags(.networking))
func apiFetch() async throws {
    let users = try await mockAPI.fetchUsers()
    #expect(!users.isEmpty)
}

@Test("Database write and read", .tags(.persistence))
func databaseRoundTrip() throws {
    let item = Item(title: "Test")
    try database.save(item)
    let loaded = try database.fetch(id: item.id)
    #expect(loaded?.title == "Test")
}

// Conditional tests
@Test("Feature flag enabled", .enabled(if: FeatureFlags.newUI))
func newUITest() { ... }

// Time limit
@Test("Fast operation", .timeLimit(.seconds(5)))
func quickTest() async { ... }
```

### Setup and Teardown

```swift
struct DatabaseTests {
    let database: TestDatabase

    init() async throws {
        // Setup: runs before each test in this struct
        database = try await TestDatabase.create()
    }

    @Test func insertItem() async throws {
        try await database.insert(Item(title: "Test"))
        let count = try await database.count()
        #expect(count == 1)
    }

    @Test func deleteItem() async throws {
        let item = Item(title: "Test")
        try await database.insert(item)
        try await database.delete(item.id)
        let count = try await database.count()
        #expect(count == 0)
    }
}
```

---

## XCTest for UI Testing

Swift Testing doesn't support UI tests yet. Use XCTest for those.

```swift
import XCTest

final class LoginUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
        app.launchArguments = ["--uitesting"]
        app.launch()
    }

    func testSuccessfulLogin() throws {
        let emailField = app.textFields["emailTextField"]
        XCTAssertTrue(emailField.waitForExistence(timeout: 5))
        emailField.tap()
        emailField.typeText("test@example.com")

        let passwordField = app.secureTextFields["passwordTextField"]
        passwordField.tap()
        passwordField.typeText("password123")

        app.buttons["loginButton"].tap()

        // Wait for home screen
        let homeTitle = app.staticTexts["Welcome"]
        XCTAssertTrue(homeTitle.waitForExistence(timeout: 10))
    }

    func testLoginWithInvalidEmail() throws {
        let emailField = app.textFields["emailTextField"]
        emailField.tap()
        emailField.typeText("not-an-email")

        let passwordField = app.secureTextFields["passwordTextField"]
        passwordField.tap()
        passwordField.typeText("password123")

        app.buttons["loginButton"].tap()

        let errorLabel = app.staticTexts["errorLabel"]
        XCTAssertTrue(errorLabel.waitForExistence(timeout: 5))
    }

    func testNavigationToSignUp() throws {
        app.buttons["signUpLink"].tap()

        let signUpTitle = app.navigationBars["Sign Up"]
        XCTAssertTrue(signUpTitle.waitForExistence(timeout: 5))
    }
}
```

### Accessibility Identifiers for UI Tests

```swift
// In your SwiftUI views
TextField("Email", text: $email)
    .accessibilityIdentifier("emailTextField")

Button("Log In") { ... }
    .accessibilityIdentifier("loginButton")

// Then reference in tests
app.textFields["emailTextField"]
app.buttons["loginButton"]
```

---

## Mocking

### Protocol-Based Mocks

```swift
// Define protocol
protocol UserServiceProtocol: Sendable {
    func fetchUsers() async throws -> [User]
    func fetchUser(id: String) async throws -> User
    func createUser(_ user: User) async throws -> User
}

// Real implementation
struct UserService: UserServiceProtocol {
    let apiClient: APIClientProtocol

    func fetchUsers() async throws -> [User] {
        try await apiClient.fetch(.users)
    }
    // ...
}

// Mock implementation
final class MockUserService: UserServiceProtocol, @unchecked Sendable {
    var fetchUsersResult: Result<[User], Error> = .success([])
    var fetchUserResult: Result<User, Error> = .success(User.mock)
    var createUserResult: Result<User, Error> = .success(User.mock)

    var fetchUsersCalled = false
    var fetchUserCalledWith: String?
    var createUserCalledWith: User?

    func fetchUsers() async throws -> [User] {
        fetchUsersCalled = true
        return try fetchUsersResult.get()
    }

    func fetchUser(id: String) async throws -> User {
        fetchUserCalledWith = id
        return try fetchUserResult.get()
    }

    func createUser(_ user: User) async throws -> User {
        createUserCalledWith = user
        return try createUserResult.get()
    }
}
```

### Test Fixtures

```swift
extension User {
    static let mock = User(
        id: "test-123",
        name: "Test User",
        email: "test@example.com"
    )

    static let mockList: [User] = [
        User(id: "1", name: "Alice", email: "alice@example.com"),
        User(id: "2", name: "Bob", email: "bob@example.com"),
        User(id: "3", name: "Charlie", email: "charlie@example.com")
    ]

    static func mock(
        id: String = "test-123",
        name: String = "Test User",
        email: String = "test@example.com"
    ) -> User {
        User(id: id, name: name, email: email)
    }
}
```

---

## Testing ViewModels

```swift
import Testing

struct UserListViewModelTests {
    let mockService: MockUserService
    let viewModel: UserListViewModel

    init() {
        mockService = MockUserService()
        viewModel = UserListViewModel(userService: mockService)
    }

    @Test("Loading users updates state correctly")
    func loadUsers() async {
        mockService.fetchUsersResult = .success(User.mockList)

        await viewModel.loadUsers()

        #expect(viewModel.users.count == 3)
        #expect(!viewModel.isLoading)
        #expect(viewModel.errorMessage == nil)
        #expect(mockService.fetchUsersCalled)
    }

    @Test("Loading users handles error")
    func loadUsersError() async {
        mockService.fetchUsersResult = .failure(NetworkError.serverError(statusCode: 500))

        await viewModel.loadUsers()

        #expect(viewModel.users.isEmpty)
        #expect(!viewModel.isLoading)
        #expect(viewModel.errorMessage != nil)
    }

    @Test("Search filters users correctly")
    func searchFilter() async {
        mockService.fetchUsersResult = .success(User.mockList)
        await viewModel.loadUsers()

        viewModel.searchText = "Alice"

        #expect(viewModel.filteredUsers.count == 1)
        #expect(viewModel.filteredUsers.first?.name == "Alice")
    }

    @Test("Empty search shows all users")
    func emptySearch() async {
        mockService.fetchUsersResult = .success(User.mockList)
        await viewModel.loadUsers()

        viewModel.searchText = ""

        #expect(viewModel.filteredUsers.count == 3)
    }

    @Test("Delete user removes from list")
    func deleteUser() async {
        mockService.fetchUsersResult = .success(User.mockList)
        await viewModel.loadUsers()

        let userToDelete = viewModel.users[0]
        await viewModel.deleteUser(userToDelete)

        #expect(viewModel.users.count == 2)
        #expect(!viewModel.users.contains(where: { $0.id == userToDelete.id }))
    }
}
```

---

## Testing Async Code

```swift
@Test("Concurrent operations complete")
func concurrentOperations() async throws {
    let results = try await withThrowingTaskGroup(of: Int.self) { group in
        for i in 0..<5 {
            group.addTask { i * 2 }
        }

        var results: [Int] = []
        for try await result in group {
            results.append(result)
        }
        return results.sorted()
    }

    #expect(results == [0, 2, 4, 6, 8])
}

@Test("Debounced search fires once", .timeLimit(.seconds(5)))
func debouncedSearch() async throws {
    let viewModel = SearchViewModel(service: MockSearchService())

    viewModel.query = "h"
    viewModel.query = "he"
    viewModel.query = "hel"
    viewModel.query = "hello"

    // Wait for debounce
    try await Task.sleep(for: .milliseconds(500))

    // Should have only searched once (the final value)
    #expect(viewModel.results.count > 0)
}

@Test("Task cancellation stops work")
func cancellation() async {
    let task = Task {
        var count = 0
        while !Task.isCancelled {
            count += 1
            try? await Task.sleep(for: .milliseconds(10))
        }
        return count
    }

    try? await Task.sleep(for: .milliseconds(100))
    task.cancel()

    let count = await task.value
    #expect(count > 0)
    #expect(count < 100)  // Should have been cancelled early
}
```

---

## Snapshot Testing

Using the `swift-snapshot-testing` library for visual regression tests.

```swift
// Add to Package.swift
// .package(url: "https://github.com/pointfreeco/swift-snapshot-testing", from: "1.15.0")

import XCTest
import SnapshotTesting
import SwiftUI

final class SnapshotTests: XCTestCase {
    func testUserProfileView() {
        let view = UserProfileView(user: .mock)
            .frame(width: 375, height: 667)

        assertSnapshot(of: view, as: .image)
    }

    func testUserProfileDarkMode() {
        let view = UserProfileView(user: .mock)
            .frame(width: 375, height: 667)
            .environment(\.colorScheme, .dark)

        assertSnapshot(of: view, as: .image, named: "dark")
    }

    func testUserProfileAccessibility() {
        let view = UserProfileView(user: .mock)
            .frame(width: 375, height: 667)
            .environment(\.sizeCategory, .accessibilityExtraExtraLarge)

        assertSnapshot(of: view, as: .image, named: "accessibility")
    }
}
```
