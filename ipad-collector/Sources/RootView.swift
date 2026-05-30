// RootView.swift
//
// Top-level view. Full-screen scene + cursor-tracking layer; falls back
// to a settings sheet when not connected.

import SwiftUI

struct RootView: View {
    @EnvironmentObject var session: SessionStore
    @State private var showSettings = false

    var body: some View {
        ZStack {
            // Scene fills the whole screen.
            SceneRendererView(scene: session.scene, effect: session.effect)
                .ignoresSafeArea()
                // PointerTracker subscribes to .onContinuousHover here. By
                // attaching the modifier to the full-screen scene view, we
                // get pointer events across the entire iPad display.
                .modifier(PointerTrackingModifier(tracker: session.pointerTracker))

            // Small status chip in the top-right corner; tap to open settings.
            // Position this far from the cursor's typical roaming area to
            // avoid the chip's pixels confounding training data — top-right
            // is the iPad's status-bar zone which is hidden anyway.
            VStack {
                HStack {
                    Spacer()
                    Button {
                        showSettings = true
                    } label: {
                        Circle()
                            .fill(session.connected ? Color.green.opacity(0.6) : Color.red.opacity(0.6))
                            .frame(width: 14, height: 14)
                            .padding(8)
                            .background(Color.black.opacity(0.3))
                            .clipShape(Circle())
                    }
                    .accessibilityLabel("Open settings")
                    .padding([.top, .trailing], 4)
                }
                Spacer()
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onAppear {
            if !session.connected && !session.collectorURL.isEmpty {
                session.connect()
            }
            if session.collectorURL.isEmpty {
                showSettings = true
            }
        }
    }
}
