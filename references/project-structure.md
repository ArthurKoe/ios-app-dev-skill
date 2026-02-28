# Project Structure Reference

## Table of Contents
1. [Standard Project Layout](#layout)
2. [Build Configurations](#build-configs)
3. [xcconfig Files](#xcconfig)
4. [Info.plist Configuration](#info-plist)
5. [Asset Catalogs](#assets)
6. [Gitignore](#gitignore)

---

## Standard Project Layout

### Feature-Based Organization (Recommended)

```
MyApp/
├── MyApp.xcodeproj/
├── Package.swift                    # SPM dependencies (if using SPM project)
├── MyApp/
│   ├── App/
│   │   ├── MyAppApp.swift           # @main entry point
│   │   ├── AppDelegate.swift        # If needed for push notifications, etc.
│   │   └── ContentView.swift        # Root view / tab controller
│   │
│   ├── Features/                    # One directory per feature
│   │   ├── Auth/
│   │   │   ├── LoginView.swift
│   │   │   ├── LoginViewModel.swift
│   │   │   ├── SignUpView.swift
│   │   │   ├── SignUpViewModel.swift
│   │   │   └── AuthModels.swift
│   │   ├── Home/
│   │   │   ├── HomeView.swift
│   │   │   ├── HomeViewModel.swift
│   │   │   └── Components/
│   │   │       ├── FeedCard.swift
│   │   │       └── StatsWidget.swift
│   │   ├── Profile/
│   │   │   ├── ProfileView.swift
│   │   │   ├── ProfileViewModel.swift
│   │   │   └── EditProfileView.swift
│   │   └── Settings/
│   │       ├── SettingsView.swift
│   │       └── SettingsViewModel.swift
│   │
│   ├── Shared/                      # Reusable code across features
│   │   ├── Components/              # Reusable SwiftUI views
│   │   │   ├── LoadingView.swift
│   │   │   ├── ErrorView.swift
│   │   │   ├── AsyncImage+Cached.swift
│   │   │   └── PrimaryButton.swift
│   │   ├── Networking/
│   │   │   ├── APIClient.swift
│   │   │   ├── Endpoints.swift
│   │   │   ├── NetworkError.swift
│   │   │   └── AuthManager.swift
│   │   ├── Storage/
│   │   │   ├── KeychainManager.swift
│   │   │   └── Models/              # SwiftData / Core Data models
│   │   │       └── DataModels.swift
│   │   ├── Navigation/
│   │   │   ├── Router.swift
│   │   │   └── AppDestination.swift
│   │   ├── Extensions/
│   │   │   ├── View+Extensions.swift
│   │   │   ├── Date+Extensions.swift
│   │   │   ├── String+Extensions.swift
│   │   │   └── Color+Extensions.swift
│   │   └── Utilities/
│   │       ├── Logger.swift
│   │       ├── Constants.swift
│   │       └── NetworkMonitor.swift
│   │
│   ├── Resources/
│   │   ├── Assets.xcassets/
│   │   │   ├── AccentColor.colorset/
│   │   │   ├── AppIcon.appiconset/
│   │   │   └── Colors/              # Custom color sets
│   │   ├── Localizable.xcstrings    # String catalog (Xcode 15+)
│   │   ├── PrivacyInfo.xcprivacy
│   │   └── Info.plist
│   │
│   └── Configuration/
│       ├── Base.xcconfig
│       ├── Debug.xcconfig
│       ├── Staging.xcconfig
│       └── Release.xcconfig
│
├── MyAppTests/
│   ├── Features/
│   │   ├── AuthTests/
│   │   │   └── LoginViewModelTests.swift
│   │   └── HomeTests/
│   │       └── HomeViewModelTests.swift
│   ├── Shared/
│   │   ├── NetworkingTests/
│   │   │   └── APIClientTests.swift
│   │   └── StorageTests/
│   │       └── KeychainManagerTests.swift
│   └── Mocks/
│       ├── MockAPIClient.swift
│       └── MockUserService.swift
│
├── MyAppUITests/
│   ├── LoginUITests.swift
│   ├── HomeUITests.swift
│   └── Helpers/
│       └── XCUIApplication+Extensions.swift
│
├── fastlane/
│   ├── Fastfile
│   ├── Matchfile
│   └── Appfile
│
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
│
├── .gitignore
└── README.md
```

---

## Build Configurations

### Creating Configurations in Xcode
1. Project → Info → Configurations
2. Duplicate "Debug" to create "Staging"
3. Assign xcconfig files to each configuration

### Default Configurations
- **Debug**: Development builds with debugging enabled
- **Staging**: Pre-production testing with staging backend
- **Release**: Production App Store builds

---

## xcconfig Files

```bash
// Configuration/Base.xcconfig
// Shared settings across all configurations

PRODUCT_NAME = MyApp
PRODUCT_BUNDLE_IDENTIFIER = com.example.myapp
MARKETING_VERSION = 1.0.0
CURRENT_PROJECT_VERSION = 1
SWIFT_VERSION = 5.9
IPHONEOS_DEPLOYMENT_TARGET = 17.0

// Info.plist preprocessor
INFOPLIST_KEY_CFBundleDisplayName = $(PRODUCT_NAME)
```

```bash
// Configuration/Debug.xcconfig
#include "Base.xcconfig"

// Override for debug
PRODUCT_BUNDLE_IDENTIFIER = com.example.myapp.debug
PRODUCT_NAME = MyApp Dev
SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG
API_BASE_URL = https:\/\/api-dev.example.com
ENABLE_LOGGING = YES

// Debug-specific settings
GCC_OPTIMIZATION_LEVEL = 0
SWIFT_OPTIMIZATION_LEVEL = -Onone
ENABLE_TESTABILITY = YES
```

```bash
// Configuration/Staging.xcconfig
#include "Base.xcconfig"

PRODUCT_BUNDLE_IDENTIFIER = com.example.myapp.staging
PRODUCT_NAME = MyApp Staging
SWIFT_ACTIVE_COMPILATION_CONDITIONS = STAGING
API_BASE_URL = https:\/\/api-staging.example.com
ENABLE_LOGGING = YES

GCC_OPTIMIZATION_LEVEL = s
SWIFT_OPTIMIZATION_LEVEL = -O
```

```bash
// Configuration/Release.xcconfig
#include "Base.xcconfig"

SWIFT_ACTIVE_COMPILATION_CONDITIONS = RELEASE
API_BASE_URL = https:\/\/api.example.com
ENABLE_LOGGING = NO

GCC_OPTIMIZATION_LEVEL = s
SWIFT_OPTIMIZATION_LEVEL = -O
VALIDATE_PRODUCT = YES
```

### Accessing Config Values in Code

```swift
enum AppConfig {
    static let apiBaseURL: URL = {
        guard let urlString = Bundle.main.infoDictionary?["API_BASE_URL"] as? String,
              let url = URL(string: urlString) else {
            fatalError("API_BASE_URL not configured")
        }
        return url
    }()

    static let isLoggingEnabled: Bool = {
        Bundle.main.infoDictionary?["ENABLE_LOGGING"] as? String == "YES"
    }()

    static let isDebug: Bool = {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }()

    static let bundleId: String = {
        Bundle.main.bundleIdentifier ?? ""
    }()

    static let appVersion: String = {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }()

    static let buildNumber: String = {
        Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0"
    }()
}
```

---

## Info.plist

Add xcconfig values to Info.plist by referencing build settings:

```xml
<key>API_BASE_URL</key>
<string>$(API_BASE_URL)</string>
<key>ENABLE_LOGGING</key>
<string>$(ENABLE_LOGGING)</string>
```

---

## Assets

### App Icon
Place a 1024x1024px PNG (no alpha, no rounded corners) in:
`Assets.xcassets/AppIcon.appiconset/`

Xcode automatically generates all required sizes from the single 1024px image.

### Color Sets
Define colors that adapt to light/dark mode:
```
Assets.xcassets/
  Colors/
    PrimaryColor.colorset/    # Appearances: Any, Dark
    BackgroundColor.colorset/
    TextColor.colorset/
```

Use in code:
```swift
Color("PrimaryColor")
// or
Color(.primaryColor)  // Type-safe with asset catalog
```

### Image Sets
Support @1x, @2x, @3x scales. For most purposes, provide a single PDF vector or SVG and check "Preserve Vector Data" and "Single Scale" in the asset inspector.

---

## Gitignore

```gitignore
# Xcode
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

# Swift Package Manager
.build/
Packages/
Package.pins
Package.resolved

# CocoaPods (if used)
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

# Secrets (never commit)
*.xcconfig.local
.env
*.p8
*.p12
*.mobileprovision
```
