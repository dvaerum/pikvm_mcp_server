// SettingsView.swift
//
// A small modal sheet for entering the collector's WebSocket URL.
// Used on first launch (when no URL is saved) and when the user taps
// the status chip in the top-right corner.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var session: SessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var draftURL: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Collector WebSocket") {
                    TextField("ws://192.168.x.x:8767", text: $draftURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                }
                Section("Status") {
                    HStack {
                        Image(systemName: session.connected ? "checkmark.circle.fill" : "xmark.circle.fill")
                            .foregroundColor(session.connected ? .green : .red)
                        Text(session.connected ? "Connected" : "Disconnected")
                    }
                    if !session.lastError.isEmpty {
                        Text(session.lastError)
                            .foregroundColor(.secondary)
                            .font(.footnote)
                    }
                }
                Section {
                    Button("Connect") {
                        session.setCollectorURL(draftURL)
                        session.connect()
                        dismiss()
                    }
                    .disabled(draftURL.isEmpty)
                    Button("Disconnect", role: .destructive) {
                        session.disconnect()
                    }
                    .disabled(!session.connected)
                }
            }
            .navigationTitle("iPad Collector")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                draftURL = session.collectorURL
            }
        }
    }
}
