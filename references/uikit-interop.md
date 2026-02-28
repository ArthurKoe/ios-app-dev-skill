# UIKit Interoperability Reference

## Table of Contents
1. [UIViewRepresentable](#uiviewrepresentable)
2. [UIViewControllerRepresentable](#uiviewcontrollerrepresentable)
3. [Coordinator Pattern](#coordinator)
4. [Common UIKit Bridges](#common-bridges)
5. [Hosting SwiftUI in UIKit](#hosting-swiftui)

---

## UIViewRepresentable

Wrap a UIKit `UIView` for use in SwiftUI.

```swift
struct MapView: UIViewRepresentable {
    @Binding var region: MKCoordinateRegion
    var annotations: [MapAnnotation]

    func makeUIView(context: Context) -> MKMapView {
        let mapView = MKMapView()
        mapView.delegate = context.coordinator
        return mapView
    }

    func updateUIView(_ mapView: MKMapView, context: Context) {
        mapView.setRegion(region, animated: true)

        // Update annotations
        mapView.removeAnnotations(mapView.annotations)
        let mkAnnotations = annotations.map { annotation -> MKPointAnnotation in
            let point = MKPointAnnotation()
            point.coordinate = annotation.coordinate
            point.title = annotation.title
            return point
        }
        mapView.addAnnotations(mkAnnotations)
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, MKMapViewDelegate {
        var parent: MapView

        init(_ parent: MapView) {
            self.parent = parent
        }

        func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
            parent.region = mapView.region
        }

        func mapView(_ mapView: MKMapView, didSelect annotation: MKAnnotation) {
            // Handle annotation tap
        }
    }
}
```

### Key Rules
- `makeUIView` is called once — create and configure the view here
- `updateUIView` is called whenever SwiftUI state changes — sync UIKit state here
- Don't create new UIView instances in `updateUIView` — only update the existing one
- Use `Coordinator` for delegate methods and callbacks

---

## UIViewControllerRepresentable

Wrap a UIKit `UIViewController` for use in SwiftUI.

```swift
struct ImagePicker: UIViewControllerRepresentable {
    @Binding var selectedImage: UIImage?
    @Environment(\.dismiss) private var dismiss
    var sourceType: UIImagePickerController.SourceType = .photoLibrary

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = sourceType
        picker.delegate = context.coordinator
        picker.allowsEditing = true
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {
        // Usually nothing needed here
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: ImagePicker

        init(_ parent: ImagePicker) {
            self.parent = parent
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let edited = info[.editedImage] as? UIImage {
                parent.selectedImage = edited
            } else if let original = info[.originalImage] as? UIImage {
                parent.selectedImage = original
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}

// Usage
struct ContentView: View {
    @State private var image: UIImage?
    @State private var showPicker = false

    var body: some View {
        VStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
            }
            Button("Select Photo") { showPicker = true }
        }
        .sheet(isPresented: $showPicker) {
            ImagePicker(selectedImage: $image)
        }
    }
}
```

---

## Coordinator

The `Coordinator` is the bridge between UIKit delegates/callbacks and SwiftUI state.

```swift
struct TextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var onCommit: (() -> Void)?

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.font = .preferredFont(forTextStyle: .body)
        textView.isScrollEnabled = true
        textView.backgroundColor = .clear
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        if textView.text != text {
            textView.text = text
        }

        if isFocused && !textView.isFirstResponder {
            textView.becomeFirstResponder()
        } else if !isFocused && textView.isFirstResponder {
            textView.resignFirstResponder()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, UITextViewDelegate {
        var parent: TextView

        init(_ parent: TextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.isFocused = true
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.isFocused = false
            parent.onCommit?()
        }
    }
}
```

---

## Common UIKit Bridges

### Activity View Controller (Share Sheet)
```swift
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

// Usage
.sheet(isPresented: $showShare) {
    ShareSheet(items: ["Check out this app!", URL(string: "https://example.com")!])
}
```

### Safari View Controller
```swift
import SafariServices

struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
```

### Mail Compose
```swift
import MessageUI

struct MailComposer: UIViewControllerRepresentable {
    @Environment(\.dismiss) private var dismiss
    var recipients: [String]
    var subject: String
    var body: String

    func makeUIViewController(context: Context) -> MFMailComposeViewController {
        let composer = MFMailComposeViewController()
        composer.mailComposeDelegate = context.coordinator
        composer.setToRecipients(recipients)
        composer.setSubject(subject)
        composer.setMessageBody(body, isHTML: false)
        return composer
    }

    func updateUIViewController(_ uiViewController: MFMailComposeViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, MFMailComposeViewControllerDelegate {
        let parent: MailComposer

        init(_ parent: MailComposer) {
            self.parent = parent
        }

        func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
            parent.dismiss()
        }
    }
}
```

---

## Hosting SwiftUI in UIKit

When you have an existing UIKit app and want to add SwiftUI views.

```swift
import SwiftUI
import UIKit

class SettingsViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()

        // Embed SwiftUI view in UIKit
        let swiftUIView = SettingsView()
        let hostingController = UIHostingController(rootView: swiftUIView)

        addChild(hostingController)
        view.addSubview(hostingController.view)
        hostingController.view.translatesAutoresizingMaskIntoConstraints = false

        NSLayoutConstraint.activate([
            hostingController.view.topAnchor.constraint(equalTo: view.topAnchor),
            hostingController.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            hostingController.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hostingController.view.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        hostingController.didMove(toParent: self)
    }
}

// Passing data from UIKit to SwiftUI
class ProfileViewController: UIViewController {
    var user: User

    init(user: User) {
        self.user = user
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        let profileView = ProfileView(user: user)
        let hosting = UIHostingController(rootView: profileView)

        addChild(hosting)
        view.addSubview(hosting.view)
        hosting.view.frame = view.bounds
        hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        hosting.didMove(toParent: self)
    }
}
```
