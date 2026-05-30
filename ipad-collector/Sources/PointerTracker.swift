// PointerTracker.swift
//
// Observes pointer movements over the scene view. Uses SwiftUI's
// `.onContinuousHover` to receive pointer events without applying any
// pointer-style effects (which would morph the cursor pixels over
// interactive UI and ruin training data).
//
// The tracker maintains the latest known cursor position and a
// monotone-increasing event counter. WebSocketClient reads from it
// for `get-cursor` responses and streams `cursor-event` messages when
// streaming is enabled.

import SwiftUI
import Combine

final class PointerTracker: ObservableObject {
    struct Sample {
        let x: Double
        let y: Double
        let tIpad: Double   // ms since epoch (Date().timeIntervalSince1970 * 1000)
        let phase: String   // "moved" | "entered" | "exited"
    }

    @Published private(set) var last: Sample?
    private let stream = PassthroughSubject<Sample, Never>()

    var events: AnyPublisher<Sample, Never> { stream.eraseToAnyPublisher() }

    func record(x: Double, y: Double, phase: String) {
        let s = Sample(x: x, y: y, tIpad: Date().timeIntervalSince1970 * 1000.0, phase: phase)
        last = s
        stream.send(s)
    }
}

struct PointerTrackingModifier: ViewModifier {
    let tracker: PointerTracker

    func body(content: Content) -> some View {
        content
            .onContinuousHover(coordinateSpace: .global) { phase in
                switch phase {
                case .active(let p):
                    tracker.record(x: Double(p.x), y: Double(p.y), phase: "moved")
                case .ended:
                    if let last = tracker.last {
                        tracker.record(x: last.x, y: last.y, phase: "exited")
                    }
                }
            }
    }
}
