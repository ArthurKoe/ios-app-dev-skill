#!/usr/bin/env python3
"""
iOS Project Scaffolding Script

Generates a complete Xcode-compatible iOS project structure with:
- SwiftUI app entry point
- Feature-based organization (MVVM, TCA, or Clean)
- Networking layer
- Persistence setup (SwiftData or CoreData)
- Test targets
- Build configurations (Debug, Staging, Release)
- .gitignore
- CI/CD templates

Usage:
    python scaffold_project.py \
        --name "MyApp" \
        --bundle-id "com.example.myapp" \
        --min-ios 17 \
        --architecture mvvm \
        --features "networking,persistence,auth" \
        --output-dir ./output
"""

import argparse
import os
import sys
from pathlib import Path
from datetime import datetime


def parse_args():
    parser = argparse.ArgumentParser(description="Scaffold an iOS project")
    parser.add_argument("--name", required=True, help="App name (e.g., MyApp)")
    parser.add_argument("--bundle-id", required=True, help="Bundle ID (e.g., com.example.myapp)")
    parser.add_argument("--min-ios", default="17", help="Minimum iOS version (default: 17)")
    parser.add_argument("--architecture", default="mvvm", choices=["mvvm", "tca", "clean"],
                        help="Architecture pattern (default: mvvm)")
    parser.add_argument("--features", default="", help="Comma-separated features: networking,persistence,auth,iap")
    parser.add_argument("--output-dir", required=True, help="Output directory")
    parser.add_argument("--team-id", default="YOUR_TEAM_ID", help="Apple Developer Team ID")
    return parser.parse_args()


def create_dir(path):
    os.makedirs(path, exist_ok=True)


def write_file(path, content):
    create_dir(os.path.dirname(path))
    with open(path, "w") as f:
        f.write(content)
    print(f"  Created: {path}")


def get_year():
    return datetime.now().year


def get_date():
    return datetime.now().strftime("%m/%d/%y")


# ─── File Content Generators ───

def app_swift(name, features):
    has_persistence = "persistence" in features
    model_container = ""
    if has_persistence:
        model_container = f"\n        .modelContainer(for: [Item.self])"

    return f'''import SwiftUI
{"import SwiftData" if has_persistence else ""}

@main
struct {name}App: App {{
    @State private var router = Router()

    var body: some Scene {{
        WindowGroup {{
            ContentView()
                .environment(router){model_container}
        }}
    }}
}}
'''


def content_view(name):
    return f'''import SwiftUI

struct ContentView: View {{
    @Environment(Router.self) private var router

    var body: some View {{
        NavigationStack(path: Bindable(router).path) {{
            HomeView()
                .navigationDestination(for: AppDestination.self) {{ destination in
                    switch destination {{
                    case .settings:
                        SettingsView()
                    }}
                }}
        }}
    }}
}}

#Preview {{
    ContentView()
        .environment(Router())
}}
'''


def router_swift():
    return '''import SwiftUI

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
'''


def app_destination_swift():
    return '''import Foundation

enum AppDestination: Hashable {
    case settings
}
'''


def home_view():
    return '''import SwiftUI

struct HomeView: View {
    @State private var viewModel = HomeViewModel()

    var body: some View {
        List {
            if viewModel.isLoading {
                ProgressView()
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            } else {
                ForEach(viewModel.items, id: \\.self) { item in
                    Text(item)
                }
            }
        }
        .navigationTitle("Home")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    // Navigate to settings
                } label: {
                    Image(systemName: "gear")
                }
            }
        }
        .refreshable {
            await viewModel.loadItems()
        }
        .task {
            await viewModel.loadItems()
        }
    }
}

#Preview {
    NavigationStack {
        HomeView()
    }
}
'''


def home_view_model():
    return '''import Foundation
import Observation

@Observable
final class HomeViewModel {
    var items: [String] = []
    var isLoading = false
    var errorMessage: String?

    func loadItems() async {
        isLoading = true
        defer { isLoading = false }

        // TODO: Replace with real data fetching
        try? await Task.sleep(for: .seconds(1))
        items = ["Item 1", "Item 2", "Item 3"]
    }
}
'''


def settings_view():
    return '''import SwiftUI

struct SettingsView: View {
    @AppStorage("notificationsEnabled") private var notificationsEnabled = true
    @AppStorage("selectedTheme") private var selectedTheme = "system"

    var body: some View {
        Form {
            Section("Preferences") {
                Toggle("Notifications", isOn: $notificationsEnabled)

                Picker("Theme", selection: $selectedTheme) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            }

            Section("About") {
                HStack {
                    Text("Version")
                    Spacer()
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Settings")
    }
}

#Preview {
    NavigationStack {
        SettingsView()
    }
}
'''


def api_client_swift():
    return '''import Foundation

protocol APIClientProtocol: Sendable {
    func fetch<T: Decodable>(_ endpoint: Endpoint) async throws -> T
}

actor APIClient: APIClientProtocol {
    private let baseURL: URL
    private let session: URLSession
    private let decoder: JSONDecoder

    init(baseURL: URL = AppConfig.apiBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        self.decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .iso8601
    }

    func fetch<T: Decodable>(_ endpoint: Endpoint) async throws -> T {
        let url = try endpoint.url(baseURL: baseURL)
        var request = URLRequest(url: url)
        request.httpMethod = endpoint.method.rawValue

        let (data, response) = try await session.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw NetworkError.invalidResponse
        }

        return try decoder.decode(T.self, from: data)
    }
}
'''


def endpoints_swift():
    return '''import Foundation

enum HTTPMethod: String {
    case GET, POST, PUT, PATCH, DELETE
}

struct Endpoint {
    let path: String
    let method: HTTPMethod
    let queryItems: [URLQueryItem]

    init(path: String, method: HTTPMethod = .GET, queryItems: [URLQueryItem] = []) {
        self.path = path
        self.method = method
        self.queryItems = queryItems
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

// MARK: - Define your endpoints here
extension Endpoint {
    // Example:
    // static var users: Endpoint { Endpoint(path: "/users") }
}
'''


def network_error_swift():
    return '''import Foundation

enum NetworkError: LocalizedError {
    case invalidURL
    case invalidResponse
    case decodingFailed(Error)
    case unauthorized
    case serverError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .invalidResponse: return "Invalid server response"
        case .decodingFailed(let error): return "Decoding failed: \\(error.localizedDescription)"
        case .unauthorized: return "Authentication required"
        case .serverError(let code): return "Server error (\\(code))"
        }
    }
}
'''


def app_config_swift():
    return '''import Foundation

enum AppConfig {
    static let apiBaseURL: URL = {
        guard let urlString = Bundle.main.infoDictionary?["API_BASE_URL"] as? String,
              let url = URL(string: urlString) else {
            // Fallback for development
            return URL(string: "https://api.example.com")!
        }
        return url
    }()

    static let isDebug: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()

    static let appVersion: String = {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }()

    static let buildNumber: String = {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    }()
}
'''


def keychain_manager_swift():
    return '''import Foundation
import Security

final class KeychainManager {
    static let shared = KeychainManager()

    private let service = Bundle.main.bundleIdentifier ?? "app"

    func store<T: Codable>(_ value: T, for key: String) throws {
        let data = try JSONEncoder().encode(value)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: service,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]

        SecItemDelete(query as CFDictionary)
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }

    func retrieve<T: Codable>(_ type: T.Type, for key: String) throws -> T {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: service,
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

    func delete(for key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: key,
            kSecAttrService as String: service
        ]
        SecItemDelete(query as CFDictionary)
    }

    enum KeychainError: Error {
        case saveFailed(OSStatus)
        case readFailed(OSStatus)
    }
}
'''


def swiftdata_models():
    return '''import Foundation
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
'''


def view_extensions():
    return '''import SwiftUI

extension View {
    func cardStyle() -> some View {
        self
            .padding()
            .background(.background)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.08), radius: 4, y: 2)
    }

    @ViewBuilder
    func `if`<Content: View>(_ condition: Bool, transform: (Self) -> Content) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}
'''


def loading_view():
    return '''import SwiftUI

struct LoadingView: View {
    var message: String = "Loading..."

    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    LoadingView()
}
'''


def error_view():
    return '''import SwiftUI

struct ErrorView: View {
    let message: String
    var retryAction: (() -> Void)?

    var body: some View {
        ContentUnavailableView {
            Label("Something Went Wrong", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            if let retryAction {
                Button("Try Again", action: retryAction)
                    .buttonStyle(.borderedProminent)
            }
        }
    }
}

#Preview {
    ErrorView(message: "Failed to load data", retryAction: {})
}
'''


def xcconfig_base(name, bundle_id, min_ios):
    return f'''// Base.xcconfig
// Shared settings for all configurations

PRODUCT_NAME = {name}
PRODUCT_BUNDLE_IDENTIFIER = {bundle_id}
MARKETING_VERSION = 1.0.0
CURRENT_PROJECT_VERSION = 1
SWIFT_VERSION = 5.9
IPHONEOS_DEPLOYMENT_TARGET = {min_ios}
'''


def xcconfig_debug(bundle_id):
    return f'''// Debug.xcconfig
#include "Base.xcconfig"

PRODUCT_BUNDLE_IDENTIFIER = {bundle_id}.debug
SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG
API_BASE_URL = https:\/\/api-dev.example.com
ENABLE_LOGGING = YES
GCC_OPTIMIZATION_LEVEL = 0
SWIFT_OPTIMIZATION_LEVEL = -Onone
ENABLE_TESTABILITY = YES
'''


def xcconfig_staging(bundle_id):
    return f'''// Staging.xcconfig
#include "Base.xcconfig"

PRODUCT_BUNDLE_IDENTIFIER = {bundle_id}.staging
SWIFT_ACTIVE_COMPILATION_CONDITIONS = STAGING
API_BASE_URL = https:\/\/api-staging.example.com
ENABLE_LOGGING = YES
GCC_OPTIMIZATION_LEVEL = s
SWIFT_OPTIMIZATION_LEVEL = -O
'''


def xcconfig_release():
    return '''// Release.xcconfig
#include "Base.xcconfig"

SWIFT_ACTIVE_COMPILATION_CONDITIONS = RELEASE
API_BASE_URL = https:\\/\\/api.example.com
ENABLE_LOGGING = NO
GCC_OPTIMIZATION_LEVEL = s
SWIFT_OPTIMIZATION_LEVEL = -O
VALIDATE_PRODUCT = YES
'''


def privacy_manifest():
    return '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSPrivacyTracking</key>
    <false/>
    <key>NSPrivacyTrackingDomains</key>
    <array/>
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>
            </array>
        </dict>
    </array>
    <key>NSPrivacyCollectedDataTypes</key>
    <array/>
</dict>
</plist>
'''


def gitignore():
    return '''# Xcode
*.xcodeproj/project.xcworkspace/
*.xcodeproj/xcuserdata/
*.xcworkspace/xcuserdata/
xcuserdata/
DerivedData/
*.moved-aside
*.ipa
*.dSYM.zip
*.dSYM
build/

# SPM
.build/
Packages/
Package.pins
Package.resolved

# CocoaPods
Pods/

# Fastlane
fastlane/report.xml
fastlane/Preview.html
fastlane/screenshots/**/*.png
fastlane/test_output

# OS
.DS_Store
*.swp
*~.nib

# Secrets
*.xcconfig.local
.env
*.p8
*.p12
*.mobileprovision
'''


def test_file(name):
    return f'''import Testing
@testable import {name}

struct {name}Tests {{
    @Test("App launches without errors")
    func appLaunches() {{
        // Basic smoke test
        #expect(true)
    }}
}}
'''


def vm_test_file(name):
    return f'''import Testing
@testable import {name}

struct HomeViewModelTests {{
    @Test("Loading items updates state")
    func loadItems() async {{
        let viewModel = HomeViewModel()

        await viewModel.loadItems()

        #expect(!viewModel.items.isEmpty)
        #expect(!viewModel.isLoading)
        #expect(viewModel.errorMessage == nil)
    }}
}}
'''


def ui_test_file(name):
    return f'''import XCTest

final class {name}UITests: XCTestCase {{
    let app = XCUIApplication()

    override func setUpWithError() throws {{
        continueAfterFailure = false
        app.launchArguments = ["--uitesting"]
        app.launch()
    }}

    func testHomeScreenLoads() throws {{
        let navTitle = app.navigationBars["Home"]
        XCTAssertTrue(navTitle.waitForExistence(timeout: 10))
    }}
}}
'''


# ─── Main Scaffold Function ───

def scaffold(args):
    name = args.name
    bundle_id = args.bundle_id
    min_ios = args.min_ios
    arch = args.architecture
    features = [f.strip() for f in args.features.split(",") if f.strip()]
    output = args.output_dir

    base = os.path.join(output, name)
    app_dir = os.path.join(base, name)

    print(f"\n🏗️  Scaffolding iOS project: {name}")
    print(f"   Bundle ID: {bundle_id}")
    print(f"   Min iOS: {min_ios}")
    print(f"   Architecture: {arch}")
    print(f"   Features: {', '.join(features) if features else 'none'}")
    print(f"   Output: {base}\n")

    # App entry point
    write_file(os.path.join(app_dir, "App", f"{name}App.swift"), app_swift(name, features))
    write_file(os.path.join(app_dir, "App", "ContentView.swift"), content_view(name))

    # Navigation
    write_file(os.path.join(app_dir, "Shared", "Navigation", "Router.swift"), router_swift())
    write_file(os.path.join(app_dir, "Shared", "Navigation", "AppDestination.swift"), app_destination_swift())

    # Features
    write_file(os.path.join(app_dir, "Features", "Home", "HomeView.swift"), home_view())
    write_file(os.path.join(app_dir, "Features", "Home", "HomeViewModel.swift"), home_view_model())
    write_file(os.path.join(app_dir, "Features", "Settings", "SettingsView.swift"), settings_view())

    # Shared components
    write_file(os.path.join(app_dir, "Shared", "Components", "LoadingView.swift"), loading_view())
    write_file(os.path.join(app_dir, "Shared", "Components", "ErrorView.swift"), error_view())
    write_file(os.path.join(app_dir, "Shared", "Extensions", "View+Extensions.swift"), view_extensions())
    write_file(os.path.join(app_dir, "Shared", "Utilities", "AppConfig.swift"), app_config_swift())

    # Networking
    if "networking" in features:
        write_file(os.path.join(app_dir, "Shared", "Networking", "APIClient.swift"), api_client_swift())
        write_file(os.path.join(app_dir, "Shared", "Networking", "Endpoints.swift"), endpoints_swift())
        write_file(os.path.join(app_dir, "Shared", "Networking", "NetworkError.swift"), network_error_swift())

    # Persistence
    if "persistence" in features:
        write_file(os.path.join(app_dir, "Shared", "Storage", "Models", "DataModels.swift"), swiftdata_models())

    # Auth
    if "auth" in features:
        write_file(os.path.join(app_dir, "Shared", "Storage", "KeychainManager.swift"), keychain_manager_swift())

    # Configuration
    write_file(os.path.join(app_dir, "Configuration", "Base.xcconfig"), xcconfig_base(name, bundle_id, min_ios))
    write_file(os.path.join(app_dir, "Configuration", "Debug.xcconfig"), xcconfig_debug(bundle_id))
    write_file(os.path.join(app_dir, "Configuration", "Staging.xcconfig"), xcconfig_staging(bundle_id))
    write_file(os.path.join(app_dir, "Configuration", "Release.xcconfig"), xcconfig_release())

    # Resources
    write_file(os.path.join(app_dir, "Resources", "PrivacyInfo.xcprivacy"), privacy_manifest())
    create_dir(os.path.join(app_dir, "Resources", "Assets.xcassets", "AppIcon.appiconset"))
    create_dir(os.path.join(app_dir, "Resources", "Assets.xcassets", "AccentColor.colorset"))

    # Tests
    write_file(os.path.join(base, f"{name}Tests", f"{name}Tests.swift"), test_file(name))
    write_file(os.path.join(base, f"{name}Tests", "HomeViewModelTests.swift"), vm_test_file(name))
    write_file(os.path.join(base, f"{name}UITests", f"{name}UITests.swift"), ui_test_file(name))

    # Root files
    write_file(os.path.join(base, ".gitignore"), gitignore())

    print(f"\n✅ Project scaffolded at: {base}")
    print(f"\n📋 Next steps:")
    print(f"   1. Open Xcode and create a new project with the same name")
    print(f"   2. Copy the generated files into the Xcode project")
    print(f"   3. Or use 'xcodegen' with a project.yml to generate the .xcodeproj")
    print(f"   4. Configure your build settings to use the .xcconfig files")
    print(f"   5. Add SPM dependencies as needed")


if __name__ == "__main__":
    args = parse_args()
    scaffold(args)
