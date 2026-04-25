# Nix flake — `pikvm-mcp-server`

This directory holds the Nix packaging and a home-manager module that
installs the MCP server, wires its environment, and registers it with
Claude Code.

The MCP server speaks **stdio** — Claude Code spawns it on demand. There
is no long-running daemon. The home-manager module installs a wrapper on
`PATH`, ensures runtime data lives under `$XDG_DATA_HOME/pikvm-mcp/`, and
deep-merges an `mcpServers.pikvm` entry into your existing `~/.claude.json`
without touching anything else in that file.

## Consumer flake — minimal example

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    pikvm-mcp.url = "github:dvaerum/pikvm_mcp_server";
    pikvm-mcp.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, home-manager, pikvm-mcp, ... }: {
    homeConfigurations."georg" = home-manager.lib.homeManagerConfiguration {
      pkgs = import nixpkgs {
        system = "x86_64-linux";
        overlays = [ pikvm-mcp.overlays.default ];
      };
      modules = [
        pikvm-mcp.homeManagerModules.default
        ({ ... }: {
          home.username = "georg";
          home.homeDirectory = "/home/georg";
          home.stateVersion = "24.11";

          services.pikvm-mcp = {
            enable = true;
            host = "https://pikvm01.lan";
            # Anything that produces a path containing the password works:
            # sops-nix, agenix, or just a plain file outside the Nix store.
            passwordFile = "/run/secrets/pikvm-password";
            claudeCode.enable = true;
          };
        })
      ];
    };
  };
}
```

`home-manager switch --flake .#georg` will:

1. Build `pikvm-mcp-server` and its wrapper.
2. Place `pikvm-mcp-server` and `pikvm-mcp-server-wrapped` on `PATH`.
3. Create `~/.local/share/pikvm-mcp/` (mode `0700`).
4. Deep-merge `{ "mcpServers": { "pikvm": { "command": "<wrapper>", "args": [] } } }`
   into `~/.claude.json` via `nix-it-in`. Any other top-level keys and
   any other `mcpServers.*` entries are preserved.

Open Claude Code; the `pikvm` server is auto-discovered and can be
invoked with the existing `pikvm_*` tools.

## All options

See `home-module.nix` for the authoritative list. Highlights:

| Option | Default | Notes |
|---|---|---|
| `services.pikvm-mcp.enable` | `false` | Master switch. |
| `services.pikvm-mcp.host` | *(required)* | E.g. `"https://pikvm01.lan"`. |
| `services.pikvm-mcp.username` | `"admin"` | |
| `services.pikvm-mcp.passwordFile` | *(required)* | Path read at MCP startup. Never enters the Nix store. |
| `services.pikvm-mcp.verifySsl` | `false` | Many PiKVMs ship with self-signed certs. |
| `services.pikvm-mcp.defaultKeymap` | `"en-us"` | |
| `services.pikvm-mcp.dataDir` | `${config.xdg.dataHome}/pikvm-mcp` | Holds `ballistics.json`, `cursor-template.jpg`. |
| `services.pikvm-mcp.extraEnv` | `{}` | E.g. `{ PIKVM_CALIBRATION_ROUNDS = "10"; }`. |
| `services.pikvm-mcp.claudeCode.enable` | `false` | Register in `~/.claude.json`. |
| `services.pikvm-mcp.claudeCode.name` | `"pikvm"` | Key under `mcpServers`. |

## Updating the npm dependency hash

When `package-lock.json` changes, regenerate the `npmDepsHash` in
`nix/package.nix`:

```sh
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
# paste the output into npmDepsHash
```

## Multi-producer `~/.claude.json`

The merge is delegated to [nix-it-in](https://cms.best.aau.dk/ai-projects/nix-it-in)
with `objectMergeStrategy = "deepMerge"` and
`arrayMergeStrategy = "append"`. Any other tool that writes to
`~/.claude.json` (Claude Code itself, `claude mcp add`, another
home-manager module) coexists without conflict, as long as no two
producers write the *same* key.

**Caveat — disable cleanup.** When you set `services.pikvm-mcp.enable = false`
and re-switch, the binary leaves `PATH` and the wrapper goes away, but the
`mcpServers.pikvm` entry stays in `~/.claude.json` (orphaned). nix-it-in
doesn't yet track ownership; until it does, remove the orphaned entry by
hand:

```sh
jq 'del(.mcpServers.pikvm)' ~/.claude.json | sponge ~/.claude.json
```

Or tell Claude Code itself:

```sh
claude mcp remove pikvm
```

## Platform support

- ✅ `x86_64-linux`, `aarch64-linux`
- ❌ `*-darwin` — `sharp` builds-from-source against vips on Darwin
  haven't been verified for this codebase. Evaluation works
  (`nix flake check` passes on macOS) so you can drive a Linux
  home-manager from a Mac, but `nix build` is Linux-only for now.

## Known inconsistency: license

`package.json` declares `"license": "MIT"` while the repository's
`LICENSE` file is `GPL-3.0`. The Nix derivation tracks `package.json`
(`meta.license = lib.licenses.mit`). Resolve upstream when you have a
moment.

## Layout

```
flake.nix            # inputs + outputs (packages, devShells, overlays, homeManagerModules)
flake.lock           # pinned input revisions (committed)
nix/
├── package.nix      # buildNpmPackage derivation
├── home-module.nix  # services.pikvm-mcp module body
├── overlay.nix      # adds pkgs.pikvm-mcp-server
└── README.md        # this file
```
