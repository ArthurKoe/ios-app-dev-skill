# Security Reference

## Table of Contents
1. [Keychain Best Practices](#keychain)
2. [Biometric Authentication](#biometrics)
3. [Network Security](#network-security)
4. [Data Protection](#data-protection)
5. [CryptoKit](#cryptokit)
6. [Secure Coding Practices](#secure-coding)

---

## Keychain

The Keychain is the only appropriate place to store sensitive data (tokens, passwords, API keys, certificates).

### What Goes Where

| Data Type | Storage | Why |
|-----------|---------|-----|
| Auth tokens | Keychain | Sensitive credentials |
| Passwords | Keychain | Sensitive credentials |
| API keys | Keychain or xcconfig (build-time) | Don't hardcode in source |
| User preferences | UserDefaults | Non-sensitive settings |
| Cached API data | File system / SwiftData | Structured data |
| Encryption keys | Keychain with `.whenUnlockedThisDeviceOnly` | Maximum protection |

### Production Keychain Manager

See `persistence.md` for a complete `KeychainManager` implementation. Key points:
- Always use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` for tokens
- Use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` for highly sensitive data
- Never use `kSecAttrAccessibleAlways` — it provides no protection

---

## Biometrics

```swift
import LocalAuthentication

actor BiometricAuthManager {
    enum BiometricType {
        case faceID, touchID, none
    }

    func availableBiometric() -> BiometricType {
        let context = LAContext()
        var error: NSError?

        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else {
            return .none
        }

        switch context.biometryType {
        case .faceID: return .faceID
        case .touchID: return .touchID
        default: return .none
        }
    }

    func authenticate(reason: String) async -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = "Use Password"
        context.localizedFallbackTitle = "Enter Password"

        do {
            return try await context.evaluatePolicy(
                .deviceOwnerAuthenticationWithBiometrics,
                localizedReason: reason
            )
        } catch {
            return false
        }
    }
}

// Usage in SwiftUI
struct SecureContentView: View {
    @State private var isAuthenticated = false
    private let bioAuth = BiometricAuthManager()

    var body: some View {
        Group {
            if isAuthenticated {
                ProtectedContentView()
            } else {
                Button("Unlock with Face ID") {
                    Task {
                        isAuthenticated = await bioAuth.authenticate(
                            reason: "Authenticate to view sensitive data"
                        )
                    }
                }
            }
        }
    }
}
```

**Info.plist required:**
```xml
<key>NSFaceIDUsageDescription</key>
<string>Authenticate to access your account</string>
```

---

## Network Security

### App Transport Security (ATS)

ATS is enabled by default and requires HTTPS for all connections. This is the secure default — don't disable it unless absolutely necessary.

```xml
<!-- Info.plist — Only add exceptions if required -->
<key>NSAppTransportSecurity</key>
<dict>
    <!-- Allow local networking for development -->
    <key>NSAllowsLocalNetworking</key>
    <true/>

    <!-- Exception for a specific legacy domain -->
    <key>NSExceptionDomains</key>
    <dict>
        <key>legacy-api.example.com</key>
        <dict>
            <key>NSExceptionAllowsInsecureHTTPLoads</key>
            <true/>
            <key>NSIncludesSubdomains</key>
            <false/>
        </dict>
    </dict>
</dict>
```

### Certificate Pinning

Only use certificate pinning for apps handling highly sensitive data (banking, medical). For most apps, the default TLS validation is sufficient.

```swift
class PinnedSessionDelegate: NSObject, URLSessionDelegate {
    private let pinnedCertificateHashes: Set<String>

    init(pinnedHashes: Set<String>) {
        self.pinnedCertificateHashes = pinnedHashes
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        // Get server certificate's public key hash
        guard let serverCert = SecTrustGetCertificateAtIndex(serverTrust, 0),
              let serverPublicKey = SecCertificateCopyKey(serverCert),
              let serverKeyData = SecKeyCopyExternalRepresentation(serverPublicKey, nil) as Data? else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }

        let serverHash = SHA256.hash(data: serverKeyData)
            .compactMap { String(format: "%02x", $0) }
            .joined()

        if pinnedCertificateHashes.contains(serverHash) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}
```

---

## Data Protection

### File Protection Levels

```swift
// Write file with protection
let data = sensitiveData.data(using: .utf8)!
let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
    .appendingPathComponent("sensitive.dat")

try data.write(to: url, options: [.atomic, .completeFileProtection])

// Set protection on existing file
try FileManager.default.setAttributes(
    [.protectionKey: FileProtectionType.complete],
    ofItemAtPath: url.path
)
```

### Protection Levels
- `.complete` — File accessible only when device is unlocked
- `.completeUnlessOpen` — File accessible when unlocked or if already open
- `.completeUntilFirstUserAuthentication` — File accessible after first unlock
- `.none` — No protection (avoid for sensitive data)

---

## CryptoKit

```swift
import CryptoKit

// Hashing
let data = "Hello, World!".data(using: .utf8)!
let hash = SHA256.hash(data: data)
let hashString = hash.compactMap { String(format: "%02x", $0) }.joined()

// Symmetric encryption
let key = SymmetricKey(size: .bits256)

func encrypt(_ data: Data, with key: SymmetricKey) throws -> Data {
    let sealedBox = try AES.GCM.seal(data, using: key)
    return sealedBox.combined!
}

func decrypt(_ data: Data, with key: SymmetricKey) throws -> Data {
    let sealedBox = try AES.GCM.SealedBox(combined: data)
    return try AES.GCM.open(sealedBox, using: key)
}

// HMAC for message authentication
let authCode = HMAC<SHA256>.authenticationCode(for: data, using: key)
let isValid = HMAC<SHA256>.isValidAuthenticationCode(authCode, authenticating: data, using: key)

// Key agreement (Diffie-Hellman)
let privateKey = P256.KeyAgreement.PrivateKey()
let publicKey = privateKey.publicKey

// Derive shared secret with another party's public key
let sharedSecret = try privateKey.sharedSecretFromKeyAgreement(with: otherPartyPublicKey)
let symmetricKey = sharedSecret.hkdfDerivedSymmetricKey(
    using: SHA256.self,
    salt: Data(),
    sharedInfo: Data(),
    outputByteCount: 32
)
```

---

## Secure Coding Practices

### Never Hardcode Secrets
```swift
// BAD
let apiKey = "sk-1234567890abcdef"

// GOOD — Load from xcconfig at build time
let apiKey = Bundle.main.infoDictionary?["API_KEY"] as? String ?? ""

// BETTER — Store in Keychain after first retrieval from secure config
let apiKey = try KeychainManager.shared.retrieve(String.self, for: "api_key")
```

### Validate All Input
```swift
func processUserInput(_ input: String) -> String {
    // Trim whitespace
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)

    // Limit length
    let limited = String(trimmed.prefix(500))

    // Remove potentially dangerous characters for display
    return limited
}
```

### Prevent Sensitive Data in Logs
```swift
// BAD
print("User token: \(token)")
Logger.debug("Password: \(password)")

// GOOD
print("User authenticated successfully")
Logger.debug("Token refreshed (expires: \(expiry))")
```

### Secure Coding Checklist
- Never log sensitive data (tokens, passwords, PII)
- Use Keychain for all credentials
- Validate and sanitize all user input
- Use HTTPS for all network requests
- Enable ATS (don't disable it)
- Use Data Protection for sensitive files
- Clear sensitive data from memory when done
- Don't store sensitive data in UserDefaults
- Use `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` for Keychain items
- Implement certificate pinning only if handling financial/medical data
