# Overrides nixpkgs' `onnxruntime` (C++) to enable the XNNPACK execution
# provider, for task_1f066737902c candidate 2 (CPU-speedup follow-up to the
# real-hardware GPU/INT8 NO-GOs — see README.md section 4/5 in this dir).
#
# WHY an overlay/override rather than a nixpkgs PR: this is a speculative
# research spike, not a shipped feature — same posture as the ncnn+Vulkan
# Phase 0 spike (scratch/ncnn-phase0/), kept out of pikvm-nixos's tracked
# module tree until/unless a real number justifies shipping it.
#
# WHY 4 new sources, not 3: nixpkgs' onnxruntime derivation
# (pkgs/by-name/on/onnxruntime/package.nix) has zero packaging for XNNPACK
# EP support. Reading onnxruntime's OWN cmake (not just cmake/deps.txt)
# shows 4 FetchContent deps get pulled in when onnxruntime_USE_XNNPACK=ON
# on aarch64-linux/non-MSVC: XNNPACK itself (declared as "googlexnnpack",
# not "xnnpack" — easy to get the override var name wrong), pthreadpool,
# fxdiv, AND kleidiai (Arm's NEON/SVE kernel lib — onnxruntime's
# cmake/external/xnnpack.cmake pulls this in unconditionally whenever
# `ORT_TARGET_PROCESSOR MATCHES "^arm64.*"`, which our target is). FP16 is
# already vendored in nixpkgs' onnxruntime for the coreml path (same exact
# revision XNNPACK's deps.txt entry wants) — reused via FETCHCONTENT_SOURCE_DIR_FP16
# regardless of coremlSupport being off.
#
# All 4 fetchFromGitHub revs/hashes below are pinned to the exact commits
# onnxruntime v1.24.4's own cmake/deps.txt and cmake/external/xnnpack.cmake
# reference — NOT arbitrary "latest" checkouts, so the built XNNPACK matches
# what upstream onnxruntime actually tests against for this ORT version.
#
# KNOWN CAVEAT: onnxruntime's own FetchContent_Declare for XNNPACK applies
# `AddEmscriptenAndIosSupport.patch` via PATCH_COMMAND. Setting
# FETCHCONTENT_SOURCE_DIR_GOOGLEXNNPACK bypasses FetchContent's
# download/patch steps entirely (CMake treats a pre-supplied source dir as
# already-populated) — so that patch is NOT applied here. The name strongly
# suggests Emscripten/iOS-only relevance, irrelevant to aarch64-linux; if
# that's wrong, the build fails loudly (unlike a silent behavior change),
# so this is a documented risk, not a silent gap.
{ repo }:
let
  pkgs = (builtins.getFlake (toString repo)).inputs.nixpkgs.legacyPackages.x86_64-linux;
  inherit (pkgs) lib;

  xnnpack-src = pkgs.fetchFromGitHub {
    owner = "google";
    repo = "XNNPACK";
    rev = "3cf85e705098622d59056dcb8f5f963ea7bb0a00";
    hash = "sha256-7J/XuFEirM3gcn62Fzrm8noRojj0QqE4/cxXt+w+Eu8=";
  };

  pthreadpool-src = pkgs.fetchFromGitHub {
    owner = "Maratyszcza";
    repo = "pthreadpool";
    rev = "dcc9f28589066af0dbd4555579281230abbf74dd";
    hash = "sha256-qogacGPNy6SKQaK8CZvGC8YZbVjhDTXuhDqGopB0Eps=";
  };

  fxdiv-src = pkgs.fetchFromGitHub {
    owner = "Maratyszcza";
    repo = "FXdiv";
    rev = "63058eff77e11aa15bf531df5dd34395ec3017c8";
    hash = "sha256-LjX5kivfHbqCIA5pF9qUvswG1gjOFo3CMpX0VR+Cn38=";
  };

  kleidiai-src = pkgs.fetchFromGitHub {
    owner = "ARM-software";
    repo = "kleidiai";
    tag = "v1.20.0";
    hash = "sha256-9lsZ0u65wy5dKhOID42xpoeMGeN1kyBILw3jYDpkEkI=";
  };

  # Same revision onnxruntime's own deps.txt pins for FP16, reused
  # independently of coremlSupport (nixpkgs only wires this dep in when
  # coremlSupport is on; we need it regardless once XNNPACK is on).
  fp16-src = pkgs.fetchFromGitHub {
    owner = "Maratyszcza";
    repo = "FP16";
    rev = "0a92994d729ff76a58f692d3028ca1b64b145d91";
    hash = "sha256-m2d9bqZoGWzuUPGkd29MsrdscnJRtuIkLIMp3fMmtRY=";
  };

  onnxruntime-xnnpack = pkgs.onnxruntime.overrideAttrs (old: {
    # nixpkgs' base package sets onnxruntime_BUILD_UNIT_TESTS = doCheck,
    # which defaults to true on native x86_64-linux — that compiles
    # onnxruntime's OWN full unit-test suite (onnxruntime_test_all,
    # onnxruntime_provider_test: hundreds of .cc files) as part of the
    # BUILD phase regardless of whether checkPhase later runs them. We
    # only need the library + wheel for a downstream correctness/timing
    # comparison (same pattern as compare_int8.py) — disabling doCheck +
    # onnxruntime_BUILD_UNIT_TESTS skips compiling test code we'll never
    # run, a large real saving on this shared/oversubscribed host for a
    # research-spike build. (Caught this only after a first build attempt
    # was already visibly compiling xnnpack_basic_test.cc etc; killed that
    # build cleanly — confirmed via `ps` the daemon-side workers died with
    # the client, no orphans — before restarting here.)
    #
    # onnxruntime_ENABLE_LTO also off: a SECOND attempt (doCheck already
    # off) still got OOM-killed mid-compile — confirmed via `journalctl -k`
    # a genuine kernel OOM-killer hit on cc1plus, in the nix-daemon.service
    # cgroup, triggered by an unrelated concurrent CI build (a gitea-runner
    # `nix build .#checks...` job) also running on this shared host at the
    # same time, not a bug in this override. LTO (`-flto=auto`, on by
    # default here since cudaSupport is off) makes individual
    # XNNPACK/Eigen translation units expensive to compile; combined with
    # full core-count parallelism stacking many such compiles at once,
    # peak memory spikes easily. Disabling LTO reduces this build's OWN
    # contribution to host memory pressure — the responsible lever
    # available here, since the concurrent CI job's timing isn't
    # something to control from this side. (`--cores` is capped
    # separately on the nix build invocation itself, see build script.)
    doCheck = false;
    cmakeFlags = old.cmakeFlags ++ [
      (lib.cmakeBool "onnxruntime_USE_XNNPACK" true)
      (lib.cmakeFeature "FETCHCONTENT_SOURCE_DIR_GOOGLEXNNPACK" "${xnnpack-src}")
      (lib.cmakeFeature "FETCHCONTENT_SOURCE_DIR_PTHREADPOOL" "${pthreadpool-src}")
      (lib.cmakeFeature "FETCHCONTENT_SOURCE_DIR_FXDIV" "${fxdiv-src}")
      (lib.cmakeFeature "FETCHCONTENT_SOURCE_DIR_KLEIDIAI" "${kleidiai-src}")
      (lib.cmakeFeature "FETCHCONTENT_SOURCE_DIR_FP16" "${fp16-src}")
      (lib.cmakeBool "onnxruntime_BUILD_UNIT_TESTS" false)
      (lib.cmakeBool "onnxruntime_ENABLE_LTO" false)
      # With LTO off, GCC's non-LTO optimizer takes a different data-flow
      # analysis path through core/framework/tensorprotoutils.cc's
      # CopySparseData() (a templated/inlined absl::InlinedVector::insert
      # call) and produces a `-Wmaybe-uninitialized` false positive on
      # `indices_values` that -Werror then hard-fails the build on — a
      # known class of GCC false positive around heavily-templated/inlined
      # container code, not a real bug in onnxruntime's own code (the
      # LTO-on build, nixpkgs' default, never hits this exact diagnostic
      # path). Same narrow-carve-out pattern nixpkgs' own package.nix
      # already uses for `-Wno-error=unused-variable` — this
      # -DCMAKE_CXX_FLAGS entry is processed after (so wins over) that
      # earlier one, so it must repeat the original flag too, not just add
      # to it.
      (lib.cmakeFeature "CMAKE_CXX_FLAGS" "-Wno-error=unused-variable -Wno-error=maybe-uninitialized")
    ];
  });
in
{
  inherit onnxruntime-xnnpack;
  # The python wheel just repackages onnxruntime.dist (built as part of the
  # C++ package's postBuild when pythonSupport is on) — overriding the base
  # `onnxruntime` input here is enough to carry XNNPACK through.
  onnxruntime-xnnpack-python = pkgs.python3Packages.onnxruntime.override {
    onnxruntime = onnxruntime-xnnpack;
  };
}
