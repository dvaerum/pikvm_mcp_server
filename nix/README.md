# Nix flake — `pikvm-mcp-server`

This directory holds the Nix packaging and two consumer modules:

- **home-manager module** (`services.pikvm-mcp`) — installs the server for
  **stdio** use: Claude Code spawns it on demand, no daemon. It puts a wrapper
  on `PATH` and keeps runtime data under `$XDG_DATA_HOME/pikvm-mcp/`. You
  register it with Claude Code yourself (one `claude mcp add`, see below).
- **NixOS module** (`services.pikvm-mcp`) — runs the server as a hardened
  **systemd system service** speaking the **Streamable HTTP** transport, for
  networked/remote MCP clients.

Both take the PiKVM **username and password from files** (never the Nix store):
via `PIKVM_USERNAME_FILE` / `PIKVM_PASSWORD_FILE` (home-manager) or systemd
`LoadCredential` (NixOS), so they compose directly with **sops-nix** / **agenix**.

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
            target = "ipad";   # required: "ipad" or "desktop"
            host = "https://pikvm01.lan";
            # Anything that produces a path containing the password works:
            # sops-nix, agenix, or just a plain file outside the Nix store.
            passwordFile = "/run/secrets/pikvm-password";
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

Then register the wrapper with Claude Code once:

```sh
claude mcp add pikvm pikvm-mcp-server-wrapped
```

Open Claude Code; the `pikvm` server can be invoked with the existing
`pikvm_*` tools.

## All options

See `home-module.nix` for the authoritative list. Highlights:

| Option | Default | Notes |
|---|---|---|
| `services.pikvm-mcp.enable` | `false` | Master switch. |
| `services.pikvm-mcp.target` | *(required)* | `"ipad"` or `"desktop"` — the control path (passed as `--target`). |
| `services.pikvm-mcp.host` | *(required)* | E.g. `"https://pikvm01.lan"`. |
| `services.pikvm-mcp.username` | `"admin"` | Literal; ignored when `usernameFile` is set. |
| `services.pikvm-mcp.usernameFile` | `null` | Optional path to the username (sops-nix/agenix). Overrides `username`. |
| `services.pikvm-mcp.passwordFile` | `null` | PiKVM password file. Optional — leave unset to run as an authenticated MCP gateway without device credentials. Never enters the Nix store. |
| `services.pikvm-mcp.security` | `"yes"` | `"yes"` = require HTTP auth on `/mcp` (needs `authPasswordFile`); `"no"` = serve it open. Passed as `--security`. |
| `services.pikvm-mcp.authUsername` | `"operator"` | Username for the MCP HTTP Basic auth. |
| `services.pikvm-mcp.authPasswordFile` | `null` | MCP HTTP auth password file (required when `security = "yes"`). Loaded as the `pikvm-mcp-auth-password` credential; never enters the Nix store. |
| `services.pikvm-mcp.verifySsl` | `false` | Many PiKVMs ship with self-signed certs. |
| `services.pikvm-mcp.defaultKeymap` | `"en-us"` | |
| `services.pikvm-mcp.dataDir` | `${config.xdg.dataHome}/pikvm-mcp` | Holds `ballistics.json`, `cursor-template.jpg`. |
| `services.pikvm-mcp.extraEnv` | `{}` | E.g. `{ PIKVM_CALIBRATION_ROUNDS = "10"; }`. |

## NixOS system service (Streamable HTTP)

For a headless, long-running server exposed over HTTP, use the NixOS module. It
runs the server under `DynamicUser` with systemd hardening and pulls the username
and password from **systemd credentials** (`LoadCredential`) — the secrets live
on tmpfs at mode `0400`, never in the Nix store, the unit env, or the process
cmdline. The server reads them by credential name (`pikvm-password`,
`pikvm-username`) from `$CREDENTIALS_DIRECTORY`.

```nix
# flake inputs: nixpkgs, sops-nix, pikvm-mcp (with inputs.nixpkgs.follows)
{
  imports = [ pikvm-mcp.nixosModules.default sops-nix.nixosModules.sops ];

  # sops-nix decrypts these to files at /run/secrets/... at activation.
  sops.secrets."pikvm/username" = { };
  sops.secrets."pikvm/password" = { };

  services.pikvm-mcp = {
    enable = true;
    target = "desktop";   # required: "ipad" or "desktop"
    host = "https://pikvm01.lan";
    usernameFile = config.sops.secrets."pikvm/username".path;
    passwordFile = config.sops.secrets."pikvm/password".path;
    address = "0.0.0.0";   # bind for remote clients (default 127.0.0.1)
    port = 3000;
    openFirewall = true;
  };
}
```

The MCP endpoint is then `http://<host>:3000/mcp` (Streamable HTTP) with a
`GET /health` liveness check. agenix works the same way — pass its secret path
to `passwordFile`/`usernameFile`. A NixOS VM test
(`nix build .#checks.x86_64-linux.nixos-service`) boots the service and asserts
the endpoint is up and the password is delivered via the credential, not the env.

> **Note:** the shipped cascade model (`ml/crop-heatmap.onnx`, 196 KB) is bundled
> in the package and resolved relative to the binary, so the cursor-detection
> tools work headless too — no working-directory dependence. (The legacy
> training-only models are intentionally not shipped.)

## Updating the npm dependency hash

When `package-lock.json` changes, regenerate the `npmDepsHash` in
`nix/package.nix`:

```sh
nix run nixpkgs#prefetch-npm-deps -- package-lock.json
# paste the output into npmDepsHash
```

## Registering with Claude Code

The home-manager module installs the wrapper but does **not** touch
`~/.claude.json` — you register it yourself, which keeps this module free of
external merge tooling and leaves your Claude config entirely under your own
control. Add and remove it with Claude Code's own CLI:

```sh
claude mcp add pikvm pikvm-mcp-server-wrapped   # register
claude mcp remove pikvm                          # unregister
```

## Platform support

- ✅ `x86_64-linux`, `aarch64-linux`
- ✅ `aarch64-darwin`, `x86_64-darwin` — sharp builds from source
  against the nixpkgs vips on darwin too. Verified on aarch64-darwin.

## Known inconsistency: license

`package.json` declares `"license": "MIT"` while the repository's
`LICENSE` file is `GPL-3.0`. The Nix derivation tracks `package.json`
(`meta.license = lib.licenses.mit`). Resolve upstream when you have a
moment.

## Layout

```
flake.nix            # outputs: packages, apps, devShells, overlays,
                     #          homeManagerModules, nixosModules, checks (Linux)
flake.lock           # pinned input revisions (committed)
nix/
├── package.nix      # buildNpmPackage derivation
├── home-module.nix  # services.pikvm-mcp — home-manager (stdio) module body
├── nixos-module.nix # services.pikvm-mcp — NixOS systemd (HTTP) module body
├── overlay.nix      # adds pkgs.pikvm-mcp-server
└── README.md        # this file
```
