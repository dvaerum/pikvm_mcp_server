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

@main
struct iPadCollectorApp: App {
    @StateObject private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)  // hide Home Indicator hint when possible
                .preferredColorScheme(.dark)        // so a black scene-loading view matches the letterbox
        }
    }
}

/// Holds the WS connection + the currently displayed scene.
final class SessionStore: ObservableObject {
    @Published var collectorURL: String = UserDefaults.standard.string(forKey: "collectorURL") ?? ""
    @Published var connected: Bool = false
    @Published var scene: SceneSpec = .blackHoldingPattern
    @Published var effect: EffectSpec = .none
    @Published var lastError: String = ""

    let pointerTracker = PointerTracker()

    private var client: WebSocketClient?

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
        client?.close()
        let c = WebSocketClient(
            url: url,
            pointer: pointerTracker,
            onConnected: { [weak self] in
                Task { @MainActor in self?.connected = true; self?.lastError = "" }
            },
            onDisconnected: { [weak self] reason in
                Task { @MainActor in
                    self?.connected = false
                    if let reason { self?.lastError = reason }
                }
            },
            onScene: { [weak self] spec in
                Task { @MainActor in self?.scene = spec }
            },
            onEffect: { [weak self] e in
                Task { @MainActor in self?.effect = e }
            }
        )
        client = c
        c.start()
    }

    func disconnect() {
        client?.close()
        client = nil
        connected = false
    }
}
