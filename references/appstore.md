# App Store Submission Reference

## Table of Contents
1. [Pre-Submission Checklist](#checklist)
2. [Privacy Requirements](#privacy)
3. [Common Rejection Reasons](#rejections)
4. [App Store Connect Setup](#app-store-connect)
5. [Screenshots and Metadata](#metadata)
6. [In-App Purchases](#iap)
7. [Review Guidelines Summary](#guidelines)

---

## Pre-Submission Checklist

Run through this before every submission:

### Required
- [ ] App icon: 1024x1024px PNG in Assets.xcassets (no alpha channel)
- [ ] Launch screen configured (LaunchScreen.storyboard or SwiftUI)
- [ ] Privacy policy URL — accessible and accurate
- [ ] `PrivacyInfo.xcprivacy` manifest present and complete
- [ ] All third-party SDKs have their own privacy manifests
- [ ] Build number incremented from last submission
- [ ] Correct provisioning profile (App Store distribution)
- [ ] Deployment target matches App Store Connect declaration
- [ ] No placeholder content ("Lorem ipsum", test data)
- [ ] No references to competing platforms ("Android version available")
- [ ] Account deletion supported (if app has account creation)

### Recommended
- [ ] Tested on multiple device sizes (iPhone SE, iPhone 15, iPad)
- [ ] Tested with VoiceOver
- [ ] Tested with Dynamic Type (large and small)
- [ ] Dark mode tested (if supported)
- [ ] No crashes in Xcode Organizer crash reports
- [ ] Memory usage reasonable (check with Instruments)
- [ ] App works with poor/no network connection (graceful errors)
- [ ] All strings localized (if supporting multiple languages)

---

## Privacy Requirements

### Privacy Manifest (PrivacyInfo.xcprivacy)

Every app submitted after Spring 2024 must include a privacy manifest. It declares what data your app collects, what APIs it uses that Apple considers "required reason APIs," and whether tracking is involved.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Does your app track users? -->
    <key>NSPrivacyTracking</key>
    <false/>

    <!-- If tracking, which domains? -->
    <key>NSPrivacyTrackingDomains</key>
    <array/>

    <!-- Required reason APIs you use -->
    <key>NSPrivacyAccessedAPITypes</key>
    <array>
        <!-- Example: UserDefaults -->
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryUserDefaults</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>CA92.1</string>
            </array>
        </dict>
        <!-- Example: File timestamp APIs -->
        <dict>
            <key>NSPrivacyAccessedAPIType</key>
            <string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
            <key>NSPrivacyAccessedAPITypeReasons</key>
            <array>
                <string>C617.1</string>
            </array>
        </dict>
    </array>

    <!-- Data your app collects -->
    <key>NSPrivacyCollectedDataTypes</key>
    <array>
        <dict>
            <key>NSPrivacyCollectedDataType</key>
            <string>NSPrivacyCollectedDataTypeEmailAddress</string>
            <key>NSPrivacyCollectedDataTypeLinked</key>
            <true/>
            <key>NSPrivacyCollectedDataTypeTracking</key>
            <false/>
            <key>NSPrivacyCollectedDataTypePurposes</key>
            <array>
                <string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
```

### Required Reason API Categories
These APIs require declared reasons in the privacy manifest:
- `NSPrivacyAccessedAPICategoryFileTimestamp` — File modification dates
- `NSPrivacyAccessedAPICategorySystemBootTime` — System boot time
- `NSPrivacyAccessedAPICategoryDiskSpace` — Disk space APIs
- `NSPrivacyAccessedAPICategoryActiveKeyboards` — Active keyboards
- `NSPrivacyAccessedAPICategoryUserDefaults` — UserDefaults

### Info.plist Privacy Keys
Add usage descriptions for any permissions your app requests:

```xml
<!-- Camera -->
<key>NSCameraUsageDescription</key>
<string>We need camera access to take photos for your profile.</string>

<!-- Photo Library -->
<key>NSPhotoLibraryUsageDescription</key>
<string>We need access to your photos to let you set a profile picture.</string>

<!-- Location -->
<key>NSLocationWhenInUseUsageDescription</key>
<string>We use your location to show nearby restaurants.</string>

<!-- Notifications -->
<!-- No Info.plist key needed — use UNUserNotificationCenter.requestAuthorization() -->

<!-- Microphone -->
<key>NSMicrophoneUsageDescription</key>
<string>We need microphone access for voice messages.</string>

<!-- Contacts -->
<key>NSContactsUsageDescription</key>
<string>We use your contacts to help you find friends on the app.</string>

<!-- Bluetooth -->
<key>NSBluetoothAlwaysUsageDescription</key>
<string>We use Bluetooth to connect to your fitness tracker.</string>

<!-- Health -->
<key>NSHealthShareUsageDescription</key>
<string>We read your step count to track daily activity.</string>
<key>NSHealthUpdateUsageDescription</key>
<string>We save your workout data to Apple Health.</string>

<!-- Face ID -->
<key>NSFaceIDUsageDescription</key>
<string>We use Face ID to securely unlock the app.</string>
```

### Account Deletion
If your app supports account creation (including Sign in with Apple, social login, email registration), you must provide in-app account deletion that:
- Is easy to find (not buried in settings)
- Actually deletes the account and associated data
- Doesn't require contacting support as the only option
- Works without excessive friction (no "are you really sure?" loops)

```swift
struct AccountDeletionView: View {
    @State private var showConfirmation = false
    @Environment(AuthManager.self) private var auth

    var body: some View {
        Button("Delete Account", role: .destructive) {
            showConfirmation = true
        }
        .alert("Delete Account?", isPresented: $showConfirmation) {
            Button("Delete", role: .destructive) {
                Task { await auth.deleteAccount() }
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This will permanently delete your account and all associated data. This action cannot be undone.")
        }
    }
}
```

---

## Common Rejection Reasons

### 1. Guideline 5.1.1 — Privacy (most common)
- Missing or inaccurate privacy manifest
- Collecting data not disclosed in App Privacy labels
- Missing usage descriptions for permissions
- Third-party SDK without privacy manifest

**Fix:** Audit every SDK, ensure PrivacyInfo.xcprivacy is complete, add all Info.plist usage descriptions.

### 2. Guideline 2.1 — Performance: App Completeness
- Placeholder content
- Broken features
- App crashes during review

**Fix:** Test thoroughly. Remove any "coming soon" features. Provide a demo account if login is required.

### 3. Guideline 4.0 — Design
- App is too simple (looks like a website wrapper)
- Doesn't use iOS design conventions
- Looks unfinished

**Fix:** Follow Human Interface Guidelines. Use native iOS controls.

### 4. Guideline 2.3 — Accurate Metadata
- Screenshots don't match actual app
- Description makes claims the app doesn't deliver
- Wrong category

**Fix:** Take real screenshots. Write an honest description.

### 5. Guideline 3.1.1 — In-App Purchase
- Directing users to external payment
- Not using StoreKit for digital goods
- Physical goods using IAP (should use external payment)

**Fix:** Digital goods/subscriptions must use StoreKit. Physical goods use your own payment processor.

### 6. Sign in with Apple Required
If your app offers third-party login (Google, Facebook, etc.), you must also offer Sign in with Apple.

---

## App Store Connect Setup

### App Information
- Primary language
- Category and subcategory
- Content rights (do you have rights to all content?)
- Age rating (fill out questionnaire honestly)

### Version Information
- Screenshots for each required device size
- App preview videos (optional, up to 30 seconds)
- Promotional text (can be updated without new submission)
- Description
- Keywords (100 character limit, comma-separated)
- Support URL
- Marketing URL (optional)
- What's New in This Version

### Review Information
- Contact info for reviewer
- Demo account (if app requires login)
- Notes for reviewer (explain anything non-obvious)

---

## Screenshots and Metadata

### Required Screenshot Sizes (2025)
- iPhone 6.9" (iPhone 15 Pro Max): 1320 x 2868 or 2868 x 1320
- iPhone 6.7" (iPhone 14 Pro Max): 1290 x 2796 or 2796 x 1290
- iPad Pro 13" (6th gen): 2064 x 2752 or 2752 x 2064

Up to 10 screenshots per device size. First 3 are most important (shown in search results).

### Tips
- Show the app in action, not just static screens
- Highlight key features in the first 3 screenshots
- Add brief text overlays explaining features
- Use real data, not placeholder content
- Consider localizing screenshots for key markets

---

## In-App Purchases

### StoreKit 2

```swift
import StoreKit

@Observable
final class StoreManager {
    var products: [Product] = []
    var purchasedProductIDs: Set<String> = []

    func loadProducts() async {
        do {
            products = try await Product.products(for: [
                "com.app.premium.monthly",
                "com.app.premium.yearly",
                "com.app.feature.unlock"
            ])
        } catch {
            print("Failed to load products: \(error)")
        }
    }

    func purchase(_ product: Product) async throws -> Transaction? {
        let result = try await product.purchase()

        switch result {
        case .success(let verification):
            let transaction = try checkVerified(verification)
            await transaction.finish()
            purchasedProductIDs.insert(product.id)
            return transaction

        case .userCancelled:
            return nil

        case .pending:
            return nil

        @unknown default:
            return nil
        }
    }

    func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .verified(let safe):
            return safe
        case .unverified:
            throw StoreError.failedVerification
        }
    }

    func listenForTransactions() async {
        for await result in Transaction.updates {
            if let transaction = try? checkVerified(result) {
                purchasedProductIDs.insert(transaction.productID)
                await transaction.finish()
            }
        }
    }

    func restorePurchases() async {
        for await result in Transaction.currentEntitlements {
            if let transaction = try? checkVerified(result) {
                purchasedProductIDs.insert(transaction.productID)
            }
        }
    }
}
```

---

## Review Guidelines Summary

Key principles Apple applies when reviewing:
- **Safety**: App must be safe for users. No harmful content.
- **Performance**: App must work reliably. No crashes, no broken features.
- **Business**: Follow the business rules (IAP for digital goods, no hidden costs).
- **Design**: Follow HIG basics. Don't just wrap a website.
- **Legal**: Respect privacy laws, intellectual property, and local regulations.

When in doubt: be transparent, be functional, and be respectful of the platform conventions.
