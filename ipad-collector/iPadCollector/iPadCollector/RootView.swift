// RootView.swift
//
// Top-level view. Full-screen scene + cursor-tracking layer; falls back
// to a settings sheet when not connected.
//
// The settings sheet used to be opened via a small red/green dot in the
// top-right corner. That dot was hard to hit via PiKVM HID (which is
// excellent at keyboard, poor at small taps), and its pixels could
// confound training screenshots. It has been replaced with an invisible
// keyboard trigger: typing the literal sequence "h-e-l-p" (no modifiers,
// case-insensitive) opens the settings sheet.

import SwiftUI
import UIKit

struct RootView: View {
    @EnvironmentObject var session: SessionStore
    @State private var showSettings = false

    var body: some View {
        ZStack {
            // Scene fills the whole screen.
            SceneRendererView(scene: session.scene,
                              effect: session.effect,
                              overlay: session.overlay)
                .ignoresSafeArea()
                // PointerTracker subscribes to .onContinuousHover here. By
                // attaching the modifier to the full-screen scene view, we
                // get pointer events across the entire iPad display.
                .modifier(PointerTrackingModifier(tracker: session.pointerTracker))
                // Tap reporter for the click-isolation bench. Earlier
                // attempt with DragGesture(min=0, .global) backgrounded
                // iPadCollector after the first click — SwiftUI's
                // DragGesture is too greedy and competes with system
                // gestures. UITapGestureRecognizer on a UIView overlay is
                // the right primitive: only fires on true taps, and with
                // cancelsTouchesInView=true the touch never reaches
                // downstream system handlers so iPadOS can't reinterpret
                // it as a swipe / app switch.
                .overlay(
                    TapCaptureView(
                        onTap: { location in
                            session.reportTap(at: location)
                        },
                        onHover: { location, state in
                            session.reportHover(at: location, state: state)
                        }
                    )
                    .ignoresSafeArea()
                    .allowsHitTesting(true)
                )

            // Invisible keyboard-trigger layer. Listens for the literal
            // sequence h-e-l-p; on match, opens settings. Rendered last
            // so it sits on top of the scene and can become first
            // responder, but contains zero visible pixels.
            KeyCaptureView(triggerSequence: "help") {
                showSettings = true
            }
            .allowsHitTesting(false)  // don't intercept hover/tap events
            .frame(width: 0, height: 0)
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onAppear {
            // SessionStore.init() already starts the connect-and-reconnect
            // loop if a URL is saved — don't re-trigger here, that races
            // with the in-flight handshake and closes the live socket.
            if session.collectorURL.isEmpty {
                showSettings = true
            }
        }
    }
}

// MARK: - Tap + hover capture overlay

/// Transparent UIView that captures BOTH taps and hover positions.
///
/// - Taps: UITapGestureRecognizer fires only on true clicks (press +
///   release within ~3 pt, fast). `cancelsTouchesInView` is left at
///   the default `true` — the touch is consumed here and doesn't
///   propagate to system gesture handlers, so iPadOS can't reinterpret
///   our HID click as a swipe / app switch.
/// - Hovers: UIHoverGestureRecognizer fires on .began (cursor enters
///   the view), .changed (cursor moves within the view), and .ended
///   (cursor exits). Required because a SwiftUI `.onContinuousHover`
///   modifier on a sibling view stops firing when this UIView overlay
///   is present (this overlay sits above SceneRendererView in the
///   hierarchy and absorbs pointer hit-tests). Reporting hover from
///   the same UIView that's already capturing the pointer fixes that.
///
/// Both callbacks deliver coords in window space, which equals the
/// iPad's logical-points coord system for a full-screen window —
/// matches what PointerTracker / cursor-event consumers expect.
struct TapCaptureView: UIViewRepresentable {
    let onTap: (CGPoint) -> Void
    let onHover: (CGPoint, UIGestureRecognizer.State) -> Void

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .clear
        v.isUserInteractionEnabled = true

        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleTap(_:))
        )
        tap.numberOfTapsRequired = 1
        tap.numberOfTouchesRequired = 1
        v.addGestureRecognizer(tap)

        let hover = UIHoverGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleHover(_:))
        )
        v.addGestureRecognizer(hover)

        return v
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onTap = onTap
        context.coordinator.onHover = onHover
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onTap: onTap, onHover: onHover)
    }

    final class Coordinator: NSObject {
        var onTap: (CGPoint) -> Void
        var onHover: (CGPoint, UIGestureRecognizer.State) -> Void

        init(
            onTap: @escaping (CGPoint) -> Void,
            onHover: @escaping (CGPoint, UIGestureRecognizer.State) -> Void
        ) {
            self.onTap = onTap
            self.onHover = onHover
        }

        @objc func handleTap(_ sender: UITapGestureRecognizer) {
            onTap(sender.location(in: nil))
        }

        @objc func handleHover(_ sender: UIHoverGestureRecognizer) {
            onHover(sender.location(in: nil), sender.state)
        }
    }
}

// MARK: - Invisible keyboard trigger

/// SwiftUI wrapper around a UIViewController that registers a UIKeyCommand
/// for every lowercase letter and tracks the typed sequence. When the
/// sequence matches `triggerSequence` (case-insensitive), `onMatch` fires.
///
/// We use UIKeyCommand rather than a hidden UITextField because key
/// commands work regardless of first-responder state at the view level —
/// UIKit walks the responder chain looking for them. They also produce
/// no visible UI (no keyboard, no cursor, no autocorrect bar).
///
/// iPadOS 16 compatible (SwiftUI .onKeyPress requires iOS 17).
struct KeyCaptureView: UIViewControllerRepresentable {
    let triggerSequence: String
    let onMatch: () -> Void

    func makeUIViewController(context: Context) -> KeyCaptureViewController {
        let vc = KeyCaptureViewController()
        vc.triggerSequence = triggerSequence.lowercased()
        vc.onMatch = onMatch
        return vc
    }

    func updateUIViewController(_ uiViewController: KeyCaptureViewController, context: Context) {
        uiViewController.triggerSequence = triggerSequence.lowercased()
        uiViewController.onMatch = onMatch
    }
}

final class KeyCaptureViewController: UIViewController {
    var triggerSequence: String = "help"
    var onMatch: (() -> Void)?

    private var buffer: String = ""

    override var canBecomeFirstResponder: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false  // pass touches through
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        becomeFirstResponder()
    }

    override var keyCommands: [UIKeyCommand]? {
        // One UIKeyCommand per lowercase letter, no modifier flags. UIKit
        // dispatches the matching command on key-down regardless of which
        // view holds first-responder, as long as some view in the chain
        // exposes it.
        let letters = "abcdefghijklmnopqrstuvwxyz"
        return letters.map { ch in
            let cmd = UIKeyCommand(
                input: String(ch),
                modifierFlags: [],
                action: #selector(handleKey(_:))
            )
            if #available(iOS 15.0, *) {
                cmd.wantsPriorityOverSystemBehavior = true
            }
            return cmd
        }
    }

    @objc private func handleKey(_ sender: UIKeyCommand) {
        guard let input = sender.input?.lowercased(), input.count == 1 else {
            buffer = ""
            return
        }
        // Extend buffer if the next char matches the expected next char
        // in the trigger; otherwise reset (but allow the new char to be
        // the start of a fresh attempt, e.g. "hhelp" still triggers).
        let nextIndex = buffer.count
        if nextIndex < triggerSequence.count,
           triggerSequence[triggerSequence.index(triggerSequence.startIndex, offsetBy: nextIndex)] == Character(input) {
            buffer.append(input)
            if buffer == triggerSequence {
                buffer = ""
                onMatch?()
            }
        } else {
            // Reset; if the wrong char happens to be the first char of
            // the trigger, start a fresh run from here.
            buffer = (input == String(triggerSequence.first ?? " ")) ? input : ""
        }
    }
}
