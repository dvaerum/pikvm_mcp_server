{
  lib,
  buildNpmPackage,
  fetchpatch,
  nodejs_20,
  pkg-config,
  python3,
  vips,
  ...
}:

let
  package = lib.importJSON ../package.json;
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
  npmDepsHash = "sha256-qYsgotMhRiI4c0LVAjZAPYaS4q9AUb1iEPoJB/uI/T8=";

  nodejs = nodejs_20;

  # sharp ships pre-built binaries that aren't compatible with NixOS's
  # glibc. Force build-from-source against the host's vips.
  nativeBuildInputs = [ pkg-config python3 ];
  buildInputs = [ vips ];
  env = {
    npm_config_sharp_install_force_build = "true";
    npm_config_build_from_source = "true";
  };

  npmBuildScript = "build";

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
