// ncnn CPU-vs-Vulkan inference benchmark for crop_heatmap.ncnn.{param,bin}
// (Phase 2 of the GPU-acceleration feasibility investigation, task_bac3fefed239
// / task_c5b91f0dce14). Loads the 12 real ground-truth-centered test crops
// from data/openloopshape-real/manifest.jsonl (same crop+normalize logic as
// compare_gt.py), runs N inferences per crop under net.opt.use_vulkan_compute
// = false vs true, and reports median/min/max per-inference wall-clock time
// for each path plus the model's own outputs (heatmap argmax + presence
// decision) so a correctness spot-check travels with the timing numbers.
//
// Model I/O contract (see README.md in this directory):
//   input  "in0": float32 CHW [3,96,96], (pixel/255 - mean[c]) / std[c]
//   output "out0": [1,24,24] heatmap logits
//   output "out1": [1] presence logit, sigmoid(x) >= 0.5 is the gate
//
// Vulkan wiring is NOT automatic from linking a Vulkan-enabled ncnn build —
// ncnn::create_gpu_instance() must run once, and each Net needing GPU
// inference needs opt.use_vulkan_compute=true set BEFORE load_param/
// load_model, per ncnn's own net.h / gpu.h. This harness does that
// explicitly and falls back to a clear skip message (not a silent no-op or
// a crash) if ncnn::get_gpu_count() reports zero — expected on a CPU-only
// dev host, and exactly what the real run on pikvm01 is meant to exercise
// for real.
//
// Build (see build.sh alongside this file for the exact nix-shell + g++
// invocation used to compile+verify this on a CPU-only x86_64 host).

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <net.h>
#include <mat.h>
#include <gpu.h>

#define STB_IMAGE_IMPLEMENTATION
#include <stb/stb_image.h>

#include <nlohmann/json.hpp>

namespace {

constexpr int kCrop = 96;
constexpr int kIters = 50; // per crop, per backend — enough for a stable median on a Pi4
const float kMean[3] = { 0.485f, 0.456f, 0.406f };
const float kStd[3] = { 0.229f, 0.224f, 0.225f };

struct ManifestEntry {
  std::string file;
  int gt_x = 0;
  int gt_y = 0;
};

// manifest.jsonl is flat, one JSON object per line — nlohmann::json handles
// the whole line fine; we only pull the two fields the crop math needs.
std::vector<ManifestEntry> loadManifest(const std::string &path) {
  std::vector<ManifestEntry> out;
  std::ifstream f(path);
  if (!f) {
    fprintf(stderr, "cannot open manifest: %s\n", path.c_str());
    std::exit(1);
  }
  std::string line;
  while (std::getline(f, line)) {
    if (line.empty())
      continue;
    auto j = nlohmann::json::parse(line);
    ManifestEntry e;
    e.file = j.at("file").get<std::string>();
    e.gt_x = j.at("gt_x").get<int>();
    e.gt_y = j.at("gt_y").get<int>();
    out.push_back(std::move(e));
  }
  return out;
}

// Load a JPEG, crop kCrop x kCrop centered on (gt_x, gt_y) (clamped to stay
// in-bounds, matching compare_gt.py's `max(0, min(W - CROP, gt - half))`),
// and produce ImageNet-normalized CHW float32 — the exact preprocessing the
// model was converted/verified against in Phase 0.
std::vector<float> loadCropCHW(const std::string &imgPath, int gtX, int gtY) {
  int w, h, channels;
  unsigned char *data = stbi_load(imgPath.c_str(), &w, &h, &channels, 3);
  if (!data) {
    fprintf(stderr, "failed to load image: %s\n", imgPath.c_str());
    std::exit(1);
  }

  const int half = kCrop / 2;
  int left = std::max(0, std::min(w - kCrop, gtX - half));
  int top = std::max(0, std::min(h - kCrop, gtY - half));

  std::vector<float> chw(3 * kCrop * kCrop);
  for (int c = 0; c < 3; ++c) {
    for (int y = 0; y < kCrop; ++y) {
      for (int x = 0; x < kCrop; ++x) {
        int srcX = left + x;
        int srcY = top + y;
        unsigned char px = data[(srcY * w + srcX) * 3 + c];
        float normalized = (px / 255.0f - kMean[c]) / kStd[c];
        chw[c * kCrop * kCrop + y * kCrop + x] = normalized;
      }
    }
  }
  stbi_image_free(data);
  return chw;
}

float sigmoid(float x) { return 1.0f / (1.0f + std::expf(-x)); }

struct InferResult {
  std::vector<float> heatmap; // 24*24
  float presenceLogit = 0.0f;
  double millis = 0.0;
};

InferResult runOnce(ncnn::Net &net, const std::vector<float> &chw) {
  ncnn::Mat in(kCrop, kCrop, 3);
  // ncnn::Mat's channel-major layout matches our CHW buffer directly —
  // copy per-channel rather than trusting a single memcpy across the whole
  // Mat, since Mat may pad rows (cstep) beyond w*h. See
  // docs/learnings/ncnn-mat-buffer-constructor.md for the sibling footgun
  // this project already hit with the numpy Mat constructor — same
  // "don't assume the buffer layout, write through the Mat's own view"
  // discipline applies here in C++.
  for (int c = 0; c < 3; ++c) {
    float *dst = in.channel(c);
    const float *src = chw.data() + c * kCrop * kCrop;
    std::copy(src, src + kCrop * kCrop, dst);
  }

  auto t0 = std::chrono::steady_clock::now();
  ncnn::Extractor ex = net.create_extractor();
  ex.input("in0", in);
  ncnn::Mat out0, out1;
  ex.extract("out0", out0);
  ex.extract("out1", out1);
  auto t1 = std::chrono::steady_clock::now();

  InferResult r;
  r.heatmap.assign((float *)out0.data, (float *)out0.data + out0.w * out0.h * out0.c);
  r.presenceLogit = ((float *)out1.data)[0];
  r.millis = std::chrono::duration<double, std::milli>(t1 - t0).count();
  return r;
}

struct Stats {
  double median, min, max;
};

Stats summarize(std::vector<double> v) {
  std::sort(v.begin(), v.end());
  Stats s;
  s.min = v.front();
  s.max = v.back();
  s.median = v[v.size() / 2];
  return s;
}

// Runs kIters inferences per crop for one backend config, returns per-crop
// timing + the LAST crop's output (for the printed correctness spot-check).
void benchBackend(const char *label, bool useVulkan, const std::string &paramPath,
                   const std::string &binPath,
                   const std::vector<ManifestEntry> &manifest, const std::string &dataDir) {
  if (useVulkan && ncnn::get_gpu_count() == 0) {
    printf("[%s] SKIPPED — ncnn::get_gpu_count() == 0 (no Vulkan device on this host). "
           "Expected on a CPU-only dev box; this is exactly what the real run on "
           "pikvm01 (V3DV confirmed live) is meant to exercise.\n",
           label);
    return;
  }

  ncnn::Net net;
  net.opt.use_vulkan_compute = useVulkan;
  if (net.load_param(paramPath.c_str()) != 0 || net.load_model(binPath.c_str()) != 0) {
    fprintf(stderr, "[%s] failed to load model\n", label);
    std::exit(1);
  }

  std::vector<double> allTimings;
  InferResult lastResult;
  for (const auto &entry : manifest) {
    std::string imgPath = dataDir + "/" + entry.file;
    std::vector<float> chw = loadCropCHW(imgPath, entry.gt_x, entry.gt_y);

    // One untimed warm-up per crop (first Vulkan dispatch pays pipeline/
    // shader-compile cost that every subsequent call amortizes away — timing
    // it would overstate steady-state latency).
    runOnce(net, chw);

    for (int i = 0; i < kIters; ++i) {
      InferResult r = runOnce(net, chw);
      allTimings.push_back(r.millis);
      lastResult = r;
    }
  }

  Stats s = summarize(allTimings);
  int argmaxIdx = std::max_element(lastResult.heatmap.begin(), lastResult.heatmap.end()) -
                   lastResult.heatmap.begin();
  bool confident = sigmoid(lastResult.presenceLogit) >= 0.5f;
  printf("[%s] %d crops x %d iters = %zu inferences — median=%.3fms min=%.3fms max=%.3fms | "
         "last-crop check: argmax_idx=%d presence=%.4f (%s)\n",
         label, (int)manifest.size(), kIters, allTimings.size(), s.median, s.min, s.max,
         argmaxIdx, sigmoid(lastResult.presenceLogit), confident ? "CONFIDENT" : "low-conf");
}

} // namespace

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: %s <ncnn-param> <ncnn-bin> <data-dir>\n", argv[0]);
    fprintf(stderr, "  <data-dir> must contain manifest.jsonl + the referenced .jpg frames\n");
    return 1;
  }
  std::string paramPath = argv[1];
  std::string binPath = argv[2];
  std::string dataDir = argv[3];

  auto manifest = loadManifest(dataDir + "/manifest.jsonl");
  printf("loaded %zu manifest entries from %s\n", manifest.size(), dataDir.c_str());

  // create_gpu_instance() is required exactly once before ANY Vulkan Net
  // is used — ncnn's own gpu.h documents this. Harmless to call even when
  // we end up skipping the Vulkan backend below (get_gpu_count() still
  // needs the instance to enumerate devices at all).
  int vkInitRc = ncnn::create_gpu_instance();
  if (vkInitRc != 0) {
    printf("ncnn::create_gpu_instance() returned %d (no usable Vulkan loader/ICD on this "
           "host) — CPU backend still runs below.\n",
           vkInitRc);
  }

  benchBackend("CPU", false, paramPath, binPath, manifest, dataDir);
  benchBackend("Vulkan", true, paramPath, binPath, manifest, dataDir);

  if (vkInitRc == 0) {
    ncnn::destroy_gpu_instance();
  }
  return 0;
}
