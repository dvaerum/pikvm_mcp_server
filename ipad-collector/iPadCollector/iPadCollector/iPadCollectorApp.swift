// iPadCollectorApp.swift
//
// Entry point for the iPad data-collection app. See ../README.md for
// Xcode project setup (Info.plist values, capabilities, build target).
//
// Companion to bench-collect-synthetic.ts and bench-collect-trajectory.ts
// in the parent repo. App connects to a WebSocket on the Mac (URL
// configured in SettingsView), reports cursor positions, and renders
// whichever scene the Mac requests.

import SwiftUI
import Combine

@main
struct iPadCollectorApp: App {
    @StateObject private var session = SessionStore()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Disable iOS's idle-timer auto-lock while iPadCollector is
        // foreground. Otherwise long benches (>30 s) hit the iPad's
        // auto-lock; once locked, iPadCollector is suspended, no
        // .onContinuousHover or TapCaptureView events fire, and every
        // remaining trial silently no-ops against the lock screen.
        UIApplication.shared.isIdleTimerDisabled = true
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)  // hide Home Indicator hint when possible
                .preferredColorScheme(.dark)        // so a black scene-loading view matches the letterbox
        }
        .onChange(of: scenePhase) { _, newPhase in
            // 2026-06-03: forward every scene-phase transition to the
            // collector over WS so the bench can detect "iPadCollector
            // backgrounded mid-run" in real time instead of getting
            // stale getCursor results until something times out.
            // Phase mapping:
            //   .active    → "active"     (normal operation)
            //   .inactive  → "inactive"   (system overlay, mid-transition)
            //   .background → "background" (suspended — bench must abort)
            let stateName: String
            switch newPhase {
            case .active:     stateName = "active"
            case .inactive:   stateName = "inactive"
            case .background: stateName = "background"
            @unknown default: stateName = "unknown"
            }
            session.reportLifecycle(state: stateName)
        }
    }
}

/// Holds the WS connection + the currently displayed scene.
final class SessionStore: ObservableObject {
    @Published var collectorURL: String = UserDefaults.standard.string(forKey: "collectorURL") ?? ""
    @Published var connected: Bool = false
    @Published var scene: SceneSpec = .blackHoldingPattern
    @Published var effect: EffectSpec = .none
    @Published var overlay: OverlaySpec = .none
    @Published var lastError: String = ""

    let pointerTracker = PointerTracker()

    private var client: WebSocketClient?
    private var shouldReconnect = false
    private var reconnectTask: Task<Void, Never>?

    init() {
        // If a URL is already saved from a previous launch, start trying
        // to reach the collector immediately. The retry loop in
        // scheduleReconnect() handles "collector not yet up" gracefully.
        if !collectorURL.isEmpty {
            connect()
        }
    }

    func setCollectorURL(_ url: String) {
        collectorURL = url
        UserDefaults.standard.set(url, forKey: "collectorURL")
    }

    func connect() {
        guard !collectorURL.isEmpty else { return }
        guard let url = URL(string: collectorURL) else {
            lastError = "Bad URL: \(collectorURL)"
            return
        }
        shouldReconnect = true
        openSocket(url: url)
    }

    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        client?.close()
        client = nil
        connected = false
    }

    /// Report a tap on the scene view to the collector. Wired from
    /// RootView's `.onTapGesture` — used by the click-isolation bench
    /// to verify clicks land inside the app at the expected coords
    /// without depending on real iPad UI state.
    func reportTap(at point: CGPoint) {
        client?.sendTap(location: point)
    }

    /// Forward a SwiftUI scene-phase transition over the WS so the
    /// bench can detect iPadCollector backgrounding in real time.
    /// Best-effort — if the WS isn't connected we silently drop;
    /// the iPad's local scene-phase change is what triggered this
    /// call, and the bench will see the WS go away anyway.
    func reportLifecycle(state: String) {
        client?.sendLifecycle(state: state)
    }

    /// Report a pointer hover event from the TapCaptureView's
    /// UIHoverGestureRecognizer. Calls into PointerTracker.record so
    /// `getCursor()` RPCs return fresh coords AND streaming
    /// subscribers receive a cursor-event (via the existing
    /// pointerTracker.events Combine publisher that WebSocketClient
    /// subscribes to during subscribe-cursor). Wired this way because
    /// the TapCaptureView UIView overlay sits above SceneRendererView
    /// and absorbs pointer hit-tests, preventing the existing
    /// SwiftUI `.onContinuousHover` modifier from receiving events.
    func reportHover(at point: CGPoint, state: UIGestureRecognizer.State) {
        let phase: String
        switch state {
        case .began:   phase = "entered"
        case .ended, .cancelled, .failed: phase = "exited"
        default:       phase = "moved"
        }
        pointerTracker.record(x: Double(point.x), y: Double(point.y), phase: phase)
    }

    private func openSocket(url: URL) {
        client?.close()
        let c = WebSocketClient(
            url: url,
            pointer: pointerTracker,
            onConnected: { [weak self] in
                Task { @MainActor in self?.connected = true; self?.lastError = "" }
            },
            onDisconnected: { [weak self] reason in
                Task { @MainActor in
                    guard let self else { return }
                    self.connected = false
                    if let reason { self.lastError = reason }
                    self.scheduleReconnect()
                }
            },
            onScene: { [weak self] spec in
                Task { @MainActor in self?.scene = spec }
            },
            onEffect: { [weak self] e in
                Task { @MainActor in self?.effect = e }
            },
            onOverlay: { [weak self] o in
                Task { @MainActor in self?.overlay = o }
            }
        )
        client = c
        c.start()
    }

    private func scheduleReconnect() {
        guard shouldReconnect else { return }
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)  // 1 s
            guard let self, !Task.isCancelled, self.shouldReconnect,
                  let url = URL(string: self.collectorURL) else { return }
            await MainActor.run { self.openSocket(url: url) }
        }
    }
}
