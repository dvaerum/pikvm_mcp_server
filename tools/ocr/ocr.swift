// Apple Vision OCR CLI — image path -> JSON [{text,conf,x,y,w,h,cx,cy}] in TOP-LEFT pixel coords.
// Used by target localization (Stage 1): OCR the iPad HDMI screenshot, match a text label, click its center.
import Foundation
import Vision
import AppKit

guard CommandLine.arguments.count > 1 else {
  FileHandle.standardError.write("usage: ocr <image>\n".data(using: .utf8)!); exit(1)
}
let path = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load \(path)\n".data(using: .utf8)!); exit(1)
}
let W = CGFloat(cg.width), H = CGFloat(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = false
try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
var out: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let c = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox                    // normalized, origin BOTTOM-left
  let x = b.minX * W, y = (1 - b.maxY) * H    // flip Y -> top-left
  let w = b.width * W, h = b.height * H
  out.append(["text": c.string, "conf": Double(c.confidence),
              "x": Int(x), "y": Int(y), "w": Int(w), "h": Int(h),
              "cx": Int(x + w/2), "cy": Int(y + h/2)])
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: out))
