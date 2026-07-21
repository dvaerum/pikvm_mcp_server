{
  lib,
  stdenv,
  autoPatchelfHook,
  buildNpmPackage,
  fetchpatch,
  onnxruntime,
  pkg-config,
  python3,
  vips,
  ...
}:

let
  package = lib.importJSON ../package.json;

  # onnxruntime-node downloads the ONNX Runtime shared lib from a Nuget feed in
  # its install script — impossible in a pure sandbox (no network) and on a
  # device rebuild. Instead we skip that download (ONNXRUNTIME_NODE_INSTALL=skip)
  # and symlink the nixpkgs onnxruntime lib into the binding dir (postInstall).
  # onnxruntime-node is pinned to 1.24.x to match nixpkgs's onnxruntime minor:
  # the prebuilt binding must not request a newer ORT C API than the lib provides.
  ortPlat = if stdenv.hostPlatform.isDarwin then "darwin" else "linux";
  ortArch = if stdenv.hostPlatform.isAarch64 then "arm64" else "x64";
  ortLibName = if stdenv.hostPlatform.isDarwin then "libonnxruntime.1.dylib" else "libonnxruntime.so.1";
  ortLibSrc =
    if stdenv.hostPlatform.isDarwin
    then "${onnxruntime}/lib/libonnxruntime.dylib"
    else "${onnxruntime}/lib/libonnxruntime.so.1";
in
buildNpmPackage {
  pname = package.name;
  version = package.version;

  # Filter source so rebuilds don't bust on local artifacts (dist/, data/,
  # the Nix files themselves, gitignored test fixtures, lockfile-adjacent
  # files etc.).
  src = lib.cleanSourceWith {
    src = lib.cleanSource ../.;
    filter = path: type:
      let
        rel = lib.removePrefix (toString ../. + "/") (toString path);
        topLevel = lib.head (lib.splitString "/" rel);
      in
      ! (
        topLevel == "dist"
        || topLevel == "data"
        || topLevel == "node_modules"
        || topLevel == "nix"
        # Dev/eval-only trees — NOT needed to build the server (tsc uses only src/) and
        # NOT loaded from the package at runtime (models resolve from process.cwd()/ml/,
        # see cursor-ml-detect.ts). Excluding them keeps the build lean (ml/ alone is
        # ~200 MB of model binaries; scratch/ holds experiment scripts + screenshots).
        # Exclude ml/ EXCEPT the shipped cascade model, which is bundled into
        # the install tree (see postInstall) so the detector works headless.
        || (topLevel == "ml" && rel != "ml" && rel != "ml/crop-heatmap.onnx")
        || topLevel == "scratch"
        || topLevel == "tools"
        || topLevel == "docs"
        || topLevel == "flake.nix"
        || topLevel == "flake.lock"
        || topLevel == "test-client.ts"
        || topLevel == "test-screenshot.jpg"
        || (lib.hasPrefix "result" topLevel)
        || (lib.hasPrefix ".env" topLevel)
      );
  };

  # Regenerate when package-lock.json changes:
  #   nix run nixpkgs#prefetch-npm-deps -- package-lock.json
  npmDepsHash = "sha256-GERvAyOo45Hwuplg6irW16dnXURtKW2bpibocV+GieY=";

  # Use buildNpmPackage's default nodejs (current maintained major). Node 20
  # is EOL and flagged insecure in nixpkgs 26.05.

  # sharp ships pre-built binaries that aren't compatible with NixOS's
  # glibc. Force build-from-source against the host's vips.
  # onnxruntime-node's prebuilt onnxruntime_binding.node is the same story on
  # Linux (needs libstdc++ etc. patched onto its RUNPATH) — autoPatchelfHook +
  # the runtime libs fix it. (No-op on darwin, which uses dyld/install-names.)
  nativeBuildInputs = [ pkg-config python3 ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = [ vips ]
    ++ lib.optionals stdenv.hostPlatform.isLinux [ onnxruntime stdenv.cc.cc.lib ];
  env = {
    npm_config_sharp_install_force_build = "true";
    npm_config_build_from_source = "true";
    # Don't fetch the ONNX Runtime lib from the network; we provide it below.
    ONNXRUNTIME_NODE_INSTALL = "skip";
  };

  npmBuildScript = "build";

  # Bundle the shipped cascade model next to dist/ in the install tree so the
  # runtime resolves it relative to its own module (cursor-ml-detect.ts
  # resolveVerifierModel) — no dependence on the working directory. Only the
  # 196 KB crop-heatmap.onnx is shipped; the legacy models stay out.
  postInstall = ''
    for d in "$out"/lib/node_modules/*/dist; do
      install -Dm444 ml/crop-heatmap.onnx "$(dirname "$d")/ml/crop-heatmap.onnx"
    done

    # onnxruntime-node ships prebuilt binding + lib for EVERY platform in one
    # tarball. Keep only the host os/arch (slims the package and stops
    # autoPatchelf from choking on foreign-arch ELF), then replace the bundled
    # (Microsoft-prebuilt) ORT lib with the nixpkgs one — NixOS-compatible and
    # ABI-matched to the pinned onnxruntime-node minor — next to the binding so
    # its $ORIGIN/@loader_path rpath finds it.
    linked=0
    for ortpkg in "$out"/lib/node_modules/*/node_modules/onnxruntime-node; do
      napi="$ortpkg/bin/napi-v6"
      [ -d "$napi" ] || continue
      find "$napi" -mindepth 1 -maxdepth 1 -type d ! -name "${ortPlat}" -exec rm -rf {} +
      find "$napi/${ortPlat}" -mindepth 1 -maxdepth 1 -type d ! -name "${ortArch}" -exec rm -rf {} +
      ln -sf ${ortLibSrc} "$napi/${ortPlat}/${ortArch}/${ortLibName}"
      linked=1
    done
    [ "$linked" = 1 ] || { echo "ERROR: onnxruntime-node binding dir not found — ORT lib not linked" >&2; exit 1; }
  '';

  meta = {
    description = "MCP server for controlling remote machines via PiKVM";
    homepage = "https://github.com/dvaerum/pikvm_mcp_server";
    # NOTE: package.json declares MIT but the repository's LICENSE file is
    # GPL-3.0. This is a pre-existing inconsistency in the source repo;
    # the derivation follows package.json. See nix/README.md.
    license = lib.licenses.mit;
    mainProgram = "pikvm-mcp-server";
    # Linux + Darwin both verified to build sharp-from-source against
    # nixpkgs vips. If a darwin build ever regresses we can narrow back.
    platforms = lib.platforms.unix;
  };
}
