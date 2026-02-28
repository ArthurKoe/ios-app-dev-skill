# CI/CD Reference

## Table of Contents
1. [Fastlane Setup](#fastlane)
2. [GitHub Actions](#github-actions)
3. [Code Signing](#code-signing)
4. [Xcode Cloud](#xcode-cloud)
5. [TestFlight Distribution](#testflight)

---

## Fastlane

### Initial Setup

```bash
# Install
gem install fastlane

# Initialize in project root
cd MyApp
fastlane init
```

### Fastfile

```ruby
# fastlane/Fastfile
default_platform(:ios)

platform :ios do
  # ─── Test Lane ───
  desc "Run all tests"
  lane :test do
    run_tests(
      scheme: "MyApp",
      devices: ["iPhone 15"],
      result_bundle: true,
      code_coverage: true
    )
  end

  # ─── Build & Deploy to TestFlight ───
  desc "Push a new build to TestFlight"
  lane :beta do
    ensure_git_status_clean

    # Increment build number
    increment_build_number(
      build_number: latest_testflight_build_number + 1
    )

    # Code signing
    match(type: "appstore", readonly: true)

    # Build
    build_app(
      scheme: "MyApp",
      export_method: "app-store",
      output_directory: "./build",
      output_name: "MyApp.ipa"
    )

    # Upload
    upload_to_testflight(
      skip_waiting_for_build_processing: true,
      changelog: "Bug fixes and improvements"
    )

    # Clean up
    clean_build_artifacts
  end

  # ─── App Store Release ───
  desc "Submit to App Store"
  lane :release do
    ensure_git_status_clean

    increment_build_number(
      build_number: latest_testflight_build_number + 1
    )

    match(type: "appstore", readonly: true)

    build_app(
      scheme: "MyApp",
      export_method: "app-store"
    )

    upload_to_app_store(
      submit_for_review: true,
      automatic_release: true,
      force: true,
      precheck_include_in_app_purchases: false
    )

    # Tag the release
    add_git_tag(tag: "v#{get_version_number}")
    push_git_tags
  end

  # ─── Screenshots ───
  desc "Capture screenshots"
  lane :screenshots do
    capture_screenshots(
      scheme: "MyAppUITests",
      devices: [
        "iPhone 15 Pro Max",
        "iPhone SE (3rd generation)",
        "iPad Pro (12.9-inch) (6th generation)"
      ],
      languages: ["en-US"],
      output_directory: "./screenshots"
    )
  end
end
```

### Matchfile (Code Signing)

```ruby
# fastlane/Matchfile
git_url("https://github.com/yourorg/certificates.git")
storage_mode("git")
type("appstore")
app_identifier("com.example.myapp")
team_id("TEAM_ID_HERE")
```

---

## GitHub Actions

### Build and Test

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - name: Select Xcode
        run: sudo xcode-select -switch /Applications/Xcode_16.0.app

      - name: Cache SPM
        uses: actions/cache@v4
        with:
          path: |
            .build
            ~/Library/Developer/Xcode/DerivedData
          key: ${{ runner.os }}-spm-${{ hashFiles('**/Package.resolved') }}
          restore-keys: |
            ${{ runner.os }}-spm-

      - name: Resolve packages
        run: xcodebuild -resolvePackageDependencies -scheme MyApp

      - name: Build and Test
        run: |
          xcodebuild test \
            -scheme MyApp \
            -destination 'platform=iOS Simulator,name=iPhone 15' \
            -resultBundlePath TestResults.xcresult \
            -enableCodeCoverage YES \
            | xcpretty

      - name: Upload test results
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-results
          path: TestResults.xcresult
```

### Deploy to TestFlight

```yaml
# .github/workflows/deploy.yml
name: Deploy to TestFlight

on:
  push:
    tags: ['v*']

jobs:
  deploy:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4

      - name: Select Xcode
        run: sudo xcode-select -switch /Applications/Xcode_16.0.app

      - name: Setup Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.3'
          bundler-cache: true

      - name: Install Fastlane
        run: gem install fastlane

      - name: Setup certificates
        env:
          MATCH_PASSWORD: ${{ secrets.MATCH_PASSWORD }}
          MATCH_GIT_BASIC_AUTHORIZATION: ${{ secrets.MATCH_GIT_AUTH }}
        run: fastlane match appstore --readonly

      - name: Build and upload
        env:
          APP_STORE_CONNECT_API_KEY_ID: ${{ secrets.ASC_KEY_ID }}
          APP_STORE_CONNECT_API_ISSUER_ID: ${{ secrets.ASC_ISSUER_ID }}
          APP_STORE_CONNECT_API_KEY: ${{ secrets.ASC_API_KEY }}
        run: fastlane beta
```

---

## Code Signing

### Automatic (Xcode Managed)
Best for solo developers. Xcode handles certificates and provisioning profiles automatically.

In Xcode: Signing & Capabilities → Check "Automatically manage signing" → Select team.

### Manual (Fastlane Match)
Best for teams and CI/CD. Match stores certificates in a shared Git repo or cloud storage.

```bash
# First time setup
fastlane match init

# Generate certificates
fastlane match development
fastlane match appstore

# On CI, use readonly mode
fastlane match appstore --readonly
```

### App Store Connect API Key
For CI/CD authentication without personal Apple ID:

1. Go to App Store Connect → Users and Access → Integrations → App Store Connect API
2. Generate a new key with "App Manager" role
3. Download the .p8 file
4. Store key ID, issuer ID, and .p8 contents as CI secrets

```ruby
# In Fastfile
app_store_connect_api_key(
  key_id: ENV["ASC_KEY_ID"],
  issuer_id: ENV["ASC_ISSUER_ID"],
  key_content: ENV["ASC_API_KEY"],
  is_key_content_base64: true
)
```

---

## Xcode Cloud

Built into Xcode, no external setup needed.

### Configuration
1. In Xcode: Product → Xcode Cloud → Create Workflow
2. Configure triggers (branch push, PR, tag, schedule)
3. Set build actions (build, test, analyze, archive)
4. Configure post-actions (notify, deploy to TestFlight)

### Custom Build Scripts
Place scripts in `ci_scripts/` directory:

```bash
# ci_scripts/ci_post_clone.sh
#!/bin/bash
# Runs after Xcode Cloud clones the repo

# Install tools
brew install swiftlint

# Generate files
./scripts/generate_config.sh
```

```bash
# ci_scripts/ci_pre_xcodebuild.sh
#!/bin/bash
# Runs before each xcodebuild invocation

# Run SwiftLint
swiftlint lint --strict
```

---

## TestFlight

### Distribution
1. Archive: Product → Archive in Xcode
2. Upload: Window → Organizer → Distribute App → App Store Connect
3. Process: Wait for Apple to process the build (5-30 minutes)
4. TestFlight: App Store Connect → TestFlight → Select build → Add testers

### Internal vs External Testing
- **Internal** (up to 100 testers): Team members in App Store Connect. No review required.
- **External** (up to 10,000 testers): Requires Beta App Review (usually quick). Can use public link.

### TestFlight Build Notes
```ruby
# In Fastlane
upload_to_testflight(
  changelog: "What's new in this build:\n- Fixed login bug\n- Improved performance\n- Added dark mode support",
  distribute_external: true,
  groups: ["Beta Testers"],
  notify_external_testers: true
)
```
