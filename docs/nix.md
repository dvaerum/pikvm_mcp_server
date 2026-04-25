# Nix / home-manager packaging

The repository ships a flake that builds the MCP server reproducibly and a
home-manager module that installs it, wires its environment, and registers
it with Claude Code via `~/.claude.json`.

See [`nix/README.md`](../nix/README.md) for the full consumer-side guide,
options reference, and platform notes.
