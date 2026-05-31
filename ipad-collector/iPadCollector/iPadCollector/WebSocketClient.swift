// WebSocketClient.swift
//
// Wraps URLSessionWebSocketTask. Handles the protocol the collector
// expects: hello/hello-ack handshake, request/response (get-cursor,
// show-scene, ...), streaming (subscribe-cursor → cursor-event push),
// and time-ping/time-pong for clock sync.
//
// Lives in SessionStore; one instance per active connection.

import Foundation
import Combine
import UIKit

final class WebSocketClient: NSObject, URLSessionWebSocketDelegate {
    private let url: URL
    private let pointer: PointerTracker
    private let onConnected: () -> Void
    private let onDisconnected: (String?) -> Void
    private let onScene: (SceneSpec) -> Void
    private let onEffect: (EffectSpec) -> Void
    private let onOverlay: (OverlaySpec) -> Void

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var streaming = false
    private var streamCancellable: AnyCancellable?
    private var didOpen = false
    private var connectDeadline: DispatchSourceTimer?

    init(url: URL,
         pointer: PointerTracker,
         onConnected: @escaping () -> Void,
         onDisconnected: @escaping (String?) -> Void,
         onScene: @escaping (SceneSpec) -> Void,
         onEffect: @escaping (EffectSpec) -> Void,
         onOverlay: @escaping (OverlaySpec) -> Void) {
        self.url = url
        self.pointer = pointer
        self.onConnected = onConnected
        self.onDisconnected = onDisconnected
        self.onScene = onScene
        self.onEffect = onEffect
        self.onOverlay = onOverlay
    }

    func start() {
        let cfg = URLSessionConfiguration.default
        cfg.waitsForConnectivity = false        // fail fast if the host is unreachable
        let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
        let t = s.webSocketTask(with: url)
        session = s
        task = t
        didOpen = false
        t.resume()
        listen()
        sendHello()

        // 3-second deadline ONLY for the initial handshake. Once didOpen
        // fires we cancel this; the live socket has no message-level
        // timeout so quiet stretches don't kill it.
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 3)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if !self.didOpen {
                self.task?.cancel(with: .invalid, reason: nil)
                DispatchQueue.main.async { self.onDisconnected("connect timeout") }
            }
        }
        timer.resume()
        connectDeadline = timer
    }

    func close() {
        connectDeadline?.cancel()
        connectDeadline = nil
        streamCancellable?.cancel()
        streamCancellable = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session = nil
    }

    // MARK: - WebSocket delegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        didOpen = true
        connectDeadline?.cancel()
        connectDeadline = nil
        DispatchQueue.main.async { self.onConnected() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        let r = reason.flatMap { String(data: $0, encoding: .utf8) } ?? "code \(closeCode.rawValue)"
        DispatchQueue.main.async { self.onDisconnected(r) }
    }

    // MARK: - I/O

    private func listen() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let err):
                DispatchQueue.main.async { self.onDisconnected(err.localizedDescription) }
            case .success(let msg):
                switch msg {
                case .string(let s):
                    self.handle(text: s)
                case .data(let d):
                    if let s = String(data: d, encoding: .utf8) {
                        self.handle(text: s)
                    }
                @unknown default: break
                }
                self.listen()
            }
        }
    }

    private func sendHello() {
        let screen = UIScreen.main.bounds
        let model = UIDevice.current.model
        let payload: [String: Any] = [
            "logicalW": Int(screen.width),
            "logicalH": Int(screen.height),
            "model": model
        ]
        send(["type": "hello", "payload": payload])
    }

    private func send(_ obj: [String: Any]) {
        guard let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: obj),
              let s = String(data: data, encoding: .utf8) else { return }
        task.send(.string(s)) { _ in }
    }

    /// Report a tap to the collector. The bench uses these to verify
    /// "did the click I emitted via PiKVM HID actually register inside
    /// the app, and at what coordinate?" — independent of any iPadOS
    /// app-launch path. Always-fire; no subscribe handshake.
    func sendTap(location: CGPoint) {
        let payload: [String: Any] = [
            "x": Double(location.x),
            "y": Double(location.y),
            "t_ipad": Date().timeIntervalSince1970 * 1000.0,
        ]
        send(["type": "tap-event", "payload": payload])
    }

    // MARK: - Protocol dispatch

    private func handle(text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else {
            return
        }
        let id = obj["id"] as? String
        let payload = obj["payload"] as? [String: Any]

        switch type {
        case "hello-ack":
            break  // already onConnected'd on socket-open
        case "get-cursor":
            ackCursor(refId: id)
        case "show-scene":
            handleShowScene(payload: payload, refId: id)
        case "set-effect":
            handleSetEffect(payload: payload, refId: id)
        case "set-overlay":
            handleSetOverlay(payload: payload, refId: id)
        case "subscribe-cursor":
            startStreaming(refId: id)
        case "unsubscribe-cursor":
            stopStreaming(refId: id)
        case "time-ping":
            handleTimePing(payload: payload, refId: id)
        case "ping":
            break
        default:
            break
        }
    }

    private func ackCursor(refId: String?) {
        let s = pointer.last
        var payload: [String: Any] = [
            "t_ipad": Date().timeIntervalSince1970 * 1000.0
        ]
        if let s {
            payload["x"] = s.x
            payload["y"] = s.y
        } else {
            payload["x"] = 0
            payload["y"] = 0
        }
        send(["type": "cursor", "id": refId as Any, "payload": payload])
    }

    private func handleShowScene(payload: [String: Any]?, refId: String?) {
        guard let p = payload else { return }
        let kindStr = p["kind"] as? String ?? "blackHoldingPattern"
        var spec = SceneSpec()
        switch kindStr {
        case "image":
            spec.kind = .image
            spec.imageBase64 = p["image"] as? String
        case "procedural":
            spec.kind = .procedural
            spec.proceduralKind = p["proc_kind"] as? String
            spec.proceduralParams = (p["params"] as? [String: Double]) ?? [:]
        case "video":
            spec.kind = .video
            spec.videoURL = p["url"] as? String
        default:
            spec.kind = .blackHoldingPattern
        }
        DispatchQueue.main.async { self.onScene(spec) }
        if let refId {
            send(["type": "ack", "payload": ["ref": refId]])
        }
    }

    private func handleSetEffect(payload: [String: Any]?, refId: String?) {
        guard let p = payload else { return }
        var e = EffectSpec()
        if let b = p["blur"] as? Double { e.blur = b }
        if let br = p["brightness"] as? Double { e.brightness = br }
        if let cm = p["colorMul"] as? [Double], cm.count == 3 {
            e.colorMul = (cm[0], cm[1], cm[2])
        }
        DispatchQueue.main.async { self.onEffect(e) }
        if let refId {
            send(["type": "ack", "payload": ["ref": refId]])
        }
    }

    private func handleSetOverlay(payload: [String: Any]?, refId: String?) {
        guard let p = payload else { return }
        var o = OverlaySpec()
        let kindStr = (p["kind"] as? String) ?? "none"
        switch kindStr {
        case "text-field": o.kind = .textField
        default:           o.kind = .none
        }
        if let x = p["x"] as? Double { o.x = x }
        if let y = p["y"] as? Double { o.y = y }
        if let w = p["w"] as? Double { o.w = w }
        if let h = p["h"] as? Double { o.h = h }
        DispatchQueue.main.async { self.onOverlay(o) }
        if let refId {
            send(["type": "ack", "payload": ["ref": refId]])
        }
    }

    private func handleTimePing(payload: [String: Any]?, refId: String?) {
        let receive = Date().timeIntervalSince1970 * 1000.0
        // Bounce a tiny bit after receive to ensure receive < send in the timestamps.
        let sendTs = Date().timeIntervalSince1970 * 1000.0
        let resp: [String: Any] = [
            "t_collector_in": (payload?["t_collector_out"] as? Double) ?? 0,
            "t_ipad_at_receive": receive,
            "t_ipad_at_send": sendTs
        ]
        send(["type": "time-pong", "id": refId as Any, "payload": resp])
    }

    private func startStreaming(refId: String?) {
        guard !streaming else {
            if let refId { send(["type": "ack", "payload": ["ref": refId]]) }
            return
        }
        streaming = true
        streamCancellable = pointer.events.sink { [weak self] sample in
            guard let self else { return }
            let payload: [String: Any] = [
                "x": sample.x,
                "y": sample.y,
                "t_ipad": sample.tIpad,
                "phase": sample.phase
            ]
            self.send(["type": "cursor-event", "payload": payload])
        }
        if let refId { send(["type": "ack", "payload": ["ref": refId]]) }
    }

    private func stopStreaming(refId: String?) {
        streamCancellable?.cancel()
        streamCancellable = nil
        streaming = false
        if let refId { send(["type": "ack", "payload": ["ref": refId]]) }
    }
}

