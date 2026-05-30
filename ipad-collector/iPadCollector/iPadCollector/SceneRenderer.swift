// SceneRenderer.swift
//
// Declarations and renderer for the three scene kinds the collector
// can ask the app to display: an image, a procedural pattern, or a
// looping video.
//
// The collector sends a `show-scene` message whose `kind` + `params`
// fields are decoded here into a SceneSpec, then dispatched to the
// matching renderer.

import SwiftUI
import UIKit
import AVKit
import Combine

/// One scene to display. `kind` selects the renderer.
struct SceneSpec: Equatable {
    enum Kind: String, Equatable {
        case blackHoldingPattern
        case image
        case procedural
        case video
    }
    var kind: Kind = .blackHoldingPattern
    /// For .image: base64-encoded JPEG/PNG bytes
    var imageBase64: String? = nil
    /// For .procedural: kind label + params
    var proceduralKind: String? = nil
    var proceduralParams: [String: Double] = [:]
    /// For .video: URL the app fetches and loops
    var videoURL: String? = nil

    static let blackHoldingPattern = SceneSpec(kind: .blackHoldingPattern)
}

struct EffectSpec: Equatable {
    var blur: Double = 0           // 0–30 px
    var brightness: Double = 0     // -1..1
    var colorMul: (Double, Double, Double) = (1, 1, 1)

    static let none = EffectSpec()

    static func == (lhs: EffectSpec, rhs: EffectSpec) -> Bool {
        lhs.blur == rhs.blur &&
        lhs.brightness == rhs.brightness &&
        lhs.colorMul == rhs.colorMul
    }
}

struct SceneRendererView: View {
    let scene: SceneSpec
    let effect: EffectSpec

    var body: some View {
        ZStack {
            content
        }
        .blur(radius: CGFloat(effect.blur))
        .brightness(effect.brightness)
        .colorMultiply(Color(.sRGB,
                             red: effect.colorMul.0,
                             green: effect.colorMul.1,
                             blue: effect.colorMul.2,
                             opacity: 1))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }

    @ViewBuilder
    private var content: some View {
        switch scene.kind {
        case .blackHoldingPattern:
            Color.black
        case .image:
            ImageScene(base64: scene.imageBase64 ?? "")
        case .procedural:
            ProceduralScene(kind: scene.proceduralKind ?? "solid",
                            params: scene.proceduralParams)
        case .video:
            VideoScene(urlString: scene.videoURL ?? "")
        }
    }
}

// MARK: - Image scene

struct ImageScene: View {
    let base64: String

    var body: some View {
        if let data = Data(base64Encoded: base64),
           let ui = UIImage(data: data) {
            Image(uiImage: ui)
                .resizable()
                .scaledToFill()
                .ignoresSafeArea()
        } else {
            Color.gray  // bad data — show neutral background
        }
    }
}

// MARK: - Procedural scene

struct ProceduralScene: View {
    let kind: String
    let params: [String: Double]

    var body: some View {
        Canvas { ctx, size in
            switch kind {
            case "solid":
                let r = params["r"] ?? 0.5
                let g = params["g"] ?? 0.5
                let b = params["b"] ?? 0.5
                ctx.fill(Path(CGRect(origin: .zero, size: size)),
                         with: .color(Color(.sRGB, red: r, green: g, blue: b)))
            case "gradient":
                let stops: [Gradient.Stop] = [
                    .init(color: .black, location: 0),
                    .init(color: .white, location: 1),
                ]
                let angle = params["angle"] ?? 0  // radians
                let start = CGPoint(x: 0, y: 0)
                let end = CGPoint(x: size.width * cos(angle),
                                  y: size.height * sin(angle))
                ctx.fill(Path(CGRect(origin: .zero, size: size)),
                         with: .linearGradient(Gradient(stops: stops),
                                              startPoint: start, endPoint: end))
            case "checker":
                let cell = max(8, params["cell"] ?? 64)
                var path = Path()
                for r in stride(from: 0.0, through: size.height, by: cell) {
                    for c in stride(from: 0.0, through: size.width, by: cell) {
                        if Int((r + c) / cell) % 2 == 0 {
                            path.addRect(CGRect(x: c, y: r, width: cell, height: cell))
                        }
                    }
                }
                ctx.fill(Path(CGRect(origin: .zero, size: size)),
                         with: .color(.black))
                ctx.fill(path, with: .color(.white))
            case "noise":
                // Cheap deterministic noise via per-cell random fill.
                let seed = UInt64(params["seed"] ?? 0)
                let cell = max(2, params["cell"] ?? 4)
                var rng = SplitMix64(seed: seed)
                for r in stride(from: 0.0, through: size.height, by: cell) {
                    for c in stride(from: 0.0, through: size.width, by: cell) {
                        let v = Double(rng.next() % 256) / 255.0
                        ctx.fill(Path(CGRect(x: c, y: r, width: cell, height: cell)),
                                 with: .color(Color(.sRGB, red: v, green: v, blue: v)))
                    }
                }
            default:
                ctx.fill(Path(CGRect(origin: .zero, size: size)),
                         with: .color(.gray))
            }
        }
        .ignoresSafeArea()
    }
}

// Cheap 64-bit PRNG for deterministic patterns.
private struct SplitMix64 {
    var state: UInt64
    init(seed: UInt64) { self.state = seed &+ 0x9E3779B97F4A7C15 }
    mutating func next() -> UInt64 {
        state = state &+ 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}

// MARK: - Video scene

struct VideoScene: View {
    let urlString: String

    var body: some View {
        if let url = URL(string: urlString) {
            VideoPlayerLooping(url: url)
                .ignoresSafeArea()
        } else {
            Color.purple  // bad URL — show neutral background
        }
    }
}

private struct VideoPlayerLooping: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let player = AVQueuePlayer()
        let item = AVPlayerItem(url: url)
        let looper = AVPlayerLooper(player: player, templateItem: item)
        context.coordinator.looper = looper
        player.isMuted = true
        player.play()

        let vc = AVPlayerViewController()
        vc.player = player
        vc.showsPlaybackControls = false
        vc.videoGravity = .resizeAspectFill
        return vc
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) { }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var looper: AVPlayerLooper?
    }
}
