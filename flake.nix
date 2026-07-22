{
  description = "PiKVM MCP server — give AI agents hands on a remote machine via PiKVM";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, ... }:
    let
      overlay = import ./nix/overlay.nix;
    in
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ overlay ];
        };
      in
      ({
        packages = {
          default = pkgs.pikvm-mcp-server;
          pikvm-mcp-server = pkgs.pikvm-mcp-server;
        };

        apps =
          let
            # Resolve the repo checkout (PIKVM_MCP_REPO env, git toplevel, or PWD) and cd in.
            # Detector tools run against the repo's own node_modules (onnxruntime-node, sharp)
            # and, for ML training, its .venv (torch/MPS — not cleanly nixifiable on macOS).
            resolveRepo = ''
              set -euo pipefail
              if [ -n "''${PIKVM_MCP_REPO:-}" ]; then REPO="$PIKVM_MCP_REPO"
              elif REPO=$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null); then :
              else REPO="$PWD"; fi
              cd "$REPO"
            '';
            # Offline TS tool.
            mkTs = name: cmd: {
              type = "app";
              program = "${pkgs.writeShellScriptBin "pikvm-${name}" ''
                ${resolveRepo}
                exec ${pkgs.tsx}/bin/tsx ${cmd} "$@"
              ''}/bin/pikvm-${name}";
            };
            # Live TS tool — defaults the loopback PiKVM proxy (macOS LAN workaround) if unset.
            mkLive = name: cmd: {
              type = "app";
              program = "${pkgs.writeShellScriptBin "pikvm-${name}" ''
                ${resolveRepo}
                export PIKVM_PROXY="''${PIKVM_PROXY:-http://127.0.0.1:8888}"
                exec ${pkgs.tsx}/bin/tsx ${cmd} "$@"
              ''}/bin/pikvm-${name}";
            };
            # Python ML tool — uses the repo's torch venv (torch/MPS is not nixified).
            mkPy = name: cmd: {
              type = "app";
              program = "${pkgs.writeShellScriptBin "pikvm-${name}" ''
                ${resolveRepo}
                if [ ! -x "$REPO/.venv/bin/python" ]; then
                  echo "error: $REPO/.venv/bin/python not found — ML tools need the torch venv." >&2
                  echo "  create it: python3 -m venv .venv && .venv/bin/pip install numpy torch torchvision pillow onnx" >&2
                  exit 1
                fi
                exec "$REPO/.venv/bin/python" ${cmd} "$@"
              ''}/bin/pikvm-${name}";
            };
          in {
            label-review = {
              type = "app";
              program = "${pkgs.writeShellScriptBin "pikvm-label-review" ''
                ${resolveRepo}
                if [ ! -f "$REPO/tools/label-review/server.ts" ]; then
                  echo "error: $REPO/tools/label-review/server.ts not found" >&2
                  echo "  set PIKVM_MCP_REPO=<path-to-checkout> or cd into the repo" >&2
                  exit 1
                fi
                exec ${pkgs.tsx}/bin/tsx tools/label-review/server.ts --repo "$REPO" "$@"
              ''}/bin/pikvm-label-review";
            };

            # --- detector: offline eval / gates ---
            cascade-eval = mkTs "cascade-eval" "scratch/cascade-eval.ts ml/cursor-v14-ep05.onnx ml/crop-heatmap.onnx";
            heatmap-gate = mkTs "heatmap-gate" "scratch/heatmap-gate.ts";
            integration-test = mkTs "integration-test" "scratch/test-cascade-integration.ts";
            # --- detector: LIVE (need the iPad env: tinyproxy + iPadCollector) ---
            health = mkLive "health" "scratch/healthcheck-shot.ts";
            explore = mkLive "explore" "scratch/explore.ts";           # nix run .#explore -- click 951 985
            live-bench = mkLive "live-bench" "scratch/click-bench80-retry3.ts";
            maps-precision = mkLive "maps-precision" "scratch/maps-buttons-precision.ts";
            # --- detector: ML pipeline (repo .venv/bin/python) ---
            gen-crops = mkPy "gen-crops" "ml/composite-crops.py";
            train-heatmap = mkPy "train-heatmap" "ml/train-crop-heatmap.py";
            export-heatmap = mkPy "export-heatmap" "ml/export-crop-heatmap-onnx.py";
          };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs
            pkg-config
            python3
            vips
            prefetch-npm-deps
          ];
          shellHook = ''
            echo "pikvm-mcp-server dev shell — Node $(node --version), npm $(npm --version)"
            echo "Regenerate npmDepsHash with: prefetch-npm-deps package-lock.json"
          '';
        };

        # NixOS VM test for the system service (Linux only — nixosTest needs a
        # Linux builder). Boots the service with credential FILES, asserts the
        # Streamable HTTP endpoint is up and that the secret was delivered via
        # systemd credentials, NOT the process environment.
        checks = pkgs.lib.optionalAttrs pkgs.stdenv.isLinux {
          nixos-service = pkgs.testers.runNixOSTest {
            name = "pikvm-mcp-service";
            nodes.machine = { ... }: {
              imports = [ self.nixosModules.pikvm-mcp ];
              environment.etc."pikvm-secrets/password".text = "testpassword";
              environment.etc."pikvm-secrets/username".text = "operator";
              environment.etc."pikvm-secrets/auth-password".text = "mcptoken";
              services.pikvm-mcp = {
                enable = true;
                target = "ipad";
                host = "https://pikvm.invalid";
                passwordFile = "/etc/pikvm-secrets/password";
                usernameFile = "/etc/pikvm-secrets/username";
                # HTTP auth (security defaults to "yes").
                authUsername = "operator";
                authPasswordFile = "/etc/pikvm-secrets/auth-password";
                openFirewall = true;
              };
            };
            testScript = ''
              import json

              machine.wait_for_unit("pikvm-mcp.service")
              machine.wait_for_open_port(3000)

              # /health is unauthenticated and reports the endpoint is secured.
              health = json.loads(machine.succeed("curl -sf http://127.0.0.1:3000/health"))
              assert health["transport"] == "streamable-http", health
              assert health["secured"] is True, health

              init = (
                "-H 'content-type: application/json' "
                "-H 'accept: application/json, text/event-stream' "
                "-d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\","
                "\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},"
                "\"clientInfo\":{\"name\":\"t\",\"version\":\"0\"}}}'"
              )
              code = lambda cmd: machine.succeed(
                f"curl -s -o /dev/null -w '%{{http_code}}' -X POST http://127.0.0.1:3000/mcp {cmd}"
              ).strip()

              # No credentials -> 401; wrong password -> 401; valid Basic -> accepted.
              assert code(init) == "401", "initialize without credentials must be 401"
              assert code(f"-u operator:wrong {init}") == "401", "wrong password must be 401"
              assert code(f"-u operator:mcptoken {init}") == "200", "valid credentials must be accepted"

              pid = machine.succeed("systemctl show -p MainPID --value pikvm-mcp.service").strip()
              # Neither secret may appear in the service's environment (both come
              # from systemd credential files instead).
              machine.fail(f"tr '\\0' '\\n' < /proc/{pid}/environ | grep -q testpassword")
              machine.fail(f"tr '\\0' '\\n' < /proc/{pid}/environ | grep -q mcptoken")
            '';
          };
        };
      }))
    // {
      # Cross-system outputs — independent of the host platform.
      overlays.default = overlay;

      homeManagerModules.default = self.homeManagerModules.pikvm-mcp;
      homeManagerModules.pikvm-mcp = import ./nix/home-module.nix;

      nixosModules.default = self.nixosModules.pikvm-mcp;
      nixosModules.pikvm-mcp = { pkgs, lib, ... }: {
        imports = [ ./nix/nixos-module.nix ];
        # Default the package to this flake's build for the node's system,
        # WITHOUT forcing a global `nixpkgs.overlays` (which is non-mergeable
        # inside nixosTest and errored: "defined multiple times ... unique").
        # mkDefault (prio 1000) still lets a consumer override the package.
        services.pikvm-mcp.package =
          lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      };
    };
}
