{
  description = "PiKVM MCP server — give AI agents hands on a remote machine via PiKVM";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Declarative file-merge tool used by the home-manager module to splice
    # this server's entry into the user's existing ~/.claude.json without
    # clobbering other writers.
    nixitin.url = "git+https://cms.best.aau.dk/ai-projects/nix-it-in";
    nixitin.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, flake-utils, nixitin, ... }:
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

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_20
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
      }))
    // {
      # Cross-system outputs — independent of the host platform.
      overlays.default = overlay;

      homeManagerModules.default = self.homeManagerModules.pikvm-mcp;
      homeManagerModules.pikvm-mcp = { ... }: {
        # Compose the upstream nixitin home-manager module so consumers get
        # services.nixitin wired automatically when they enable our
        # services.pikvm-mcp.claudeCode.enable.
        imports = [
          nixitin.homeManagerModules.default
          ./nix/home-module.nix
        ];
      };
    };
}
