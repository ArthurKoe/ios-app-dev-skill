# Accessibility Reference

## Table of Contents
1. [VoiceOver](#voiceover)
2. [Dynamic Type](#dynamic-type)
3. [Color and Contrast](#color-contrast)
4. [Motion and Animations](#motion)
5. [Testing Accessibility](#testing)

---

## VoiceOver

VoiceOver reads UI elements aloud. Every interactive element needs a clear label and, optionally, a hint.

### Labels and Hints

```swift
// Images
Image("profile-photo")
    .accessibilityLabel("Profile photo of \(user.name)")

Image(systemName: "heart.fill")
    .accessibilityLabel("Favorited")

// Buttons
Button(action: toggleFavorite) {
    Image(systemName: isFavorite ? "heart.fill" : "heart")
}
.accessibilityLabel(isFavorite ? "Remove from favorites" : "Add to favorites")
.accessibilityHint("Double-tap to toggle")

// Complex views — combine children into one element
HStack {
    Image(systemName: "star.fill")
    Text("4.8")
    Text("(120 reviews)")
}
.accessibilityElement(children: .combine)
// VoiceOver reads: "star fill, 4.8, (120 reviews)"

// Or provide a custom label
HStack {
    Image(systemName: "star.fill")
    Text("4.8")
    Text("(120 reviews)")
}
.accessibilityElement(children: .ignore)
.accessibilityLabel("Rating: 4.8 out of 5, based on 120 reviews")
```

### Traits

```swift
// Mark headers for navigation
Text("Settings")
    .font(.title)
    .accessibilityAddTraits(.isHeader)

// Mark images that are decorative (VoiceOver skips them)
Image("decorative-divider")
    .accessibilityHidden(true)

// Mark elements that update frequently
Text(timerValue)
    .accessibilityAddTraits(.updatesFrequently)

// Custom actions
Text(item.title)
    .accessibilityAction(named: "Delete") {
        deleteItem(item)
    }
    .accessibilityAction(named: "Edit") {
        editItem(item)
    }
```

### Announcements

```swift
// Notify VoiceOver of changes
func saveCompleted() {
    AccessibilityNotification.Announcement("Item saved successfully").post()
}

func errorOccurred(_ message: String) {
    AccessibilityNotification.Announcement("Error: \(message)").post()
}
```

---

## Dynamic Type

Support user-preferred text sizes. SwiftUI handles this automatically with semantic fonts.

```swift
// Use semantic fonts (automatically scale)
Text("Title").font(.title)
Text("Body text").font(.body)
Text("Caption").font(.caption)

// Custom fonts that scale
Text("Custom")
    .font(.custom("Helvetica", size: 17, relativeTo: .body))

// ScaledMetric for non-text values
@ScaledMetric(relativeTo: .body) private var iconSize = 24.0
@ScaledMetric private var spacing = 16.0

Image(systemName: "star")
    .frame(width: iconSize, height: iconSize)

VStack(spacing: spacing) {
    Text("First")
    Text("Second")
}

// Responding to size category changes
@Environment(\.sizeCategory) private var sizeCategory

var body: some View {
    if sizeCategory.isAccessibilityCategory {
        // Use vertical layout for very large text
        VStack { content }
    } else {
        // Use horizontal layout for normal text
        HStack { content }
    }
}
```

### Minimum Tap Targets

```swift
// Ensure 44x44pt minimum tap targets
Button("Small Text") { }
    .frame(minWidth: 44, minHeight: 44)

// For custom hit areas
Image(systemName: "gear")
    .frame(width: 20, height: 20)
    .contentShape(Rectangle().size(width: 44, height: 44))
```

---

## Color and Contrast

```swift
// Use semantic colors that adapt to dark mode
Text("Primary text")
    .foregroundStyle(.primary)

Text("Secondary text")
    .foregroundStyle(.secondary)

// Never rely on color alone to convey meaning
HStack {
    Circle()
        .fill(status == .active ? .green : .red)
        .frame(width: 12, height: 12)
    Text(status == .active ? "Active" : "Inactive")  // Text backup for color
}

// Check for reduced transparency
@Environment(\.accessibilityReduceTransparency) private var reduceTransparency

var background: some View {
    if reduceTransparency {
        Color(.systemBackground)
    } else {
        Color(.systemBackground).opacity(0.8)
            .background(.ultraThinMaterial)
    }
}

// High contrast support
@Environment(\.colorSchemeContrast) private var contrast

var textColor: Color {
    contrast == .increased ? .primary : .secondary
}
```

---

## Motion

```swift
// Respect reduced motion preferences
@Environment(\.accessibilityReduceMotion) private var reduceMotion

var body: some View {
    Circle()
        .scaleEffect(isExpanded ? 1.5 : 1.0)
        .animation(reduceMotion ? .none : .spring(), value: isExpanded)
}

// Provide static alternatives for animations
struct AnimatedContent: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            // Show content without animation
            staticContent
        } else {
            // Show animated version
            animatedContent
        }
    }
}
```

---

## Testing

### Xcode Accessibility Inspector
1. Xcode → Open Developer Tools → Accessibility Inspector
2. Point at your running app
3. Check that every element has appropriate label, value, and traits

### VoiceOver Testing
1. Settings → Accessibility → VoiceOver → Enable
2. Navigate your app using swipe gestures
3. Verify every screen is navigable and every action is announced

### Preview Testing
```swift
#Preview("Large Text") {
    ContentView()
        .environment(\.sizeCategory, .accessibilityExtraExtraLarge)
}

#Preview("Dark Mode") {
    ContentView()
        .environment(\.colorScheme, .dark)
}

#Preview("High Contrast") {
    ContentView()
        .environment(\.colorSchemeContrast, .increased)
}

#Preview("Reduced Motion") {
    ContentView()
        .environment(\.accessibilityReduceMotion, true)
}
```

### Automated Accessibility Audit (Xcode 15+)
```swift
import XCTest

final class AccessibilityAuditTests: XCTestCase {
    func testAccessibility() throws {
        let app = XCUIApplication()
        app.launch()

        // Runs Apple's accessibility audit
        try app.performAccessibilityAudit()
    }

    func testAccessibilityWithExclusions() throws {
        let app = XCUIApplication()
        app.launch()

        // Exclude specific audit types if needed
        try app.performAccessibilityAudit(for: [
            .dynamicType,
            .contrast,
            .hitRegion
        ])
    }
}
```
