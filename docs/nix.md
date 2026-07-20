# Nix / home-manager packaging

The repository ships a flake that builds the MCP server reproducibly and a
home-manager module that installs it and wires its environment; you register
it with Claude Code yourself via `claude mcp add`.

See [`nix/README.md`](../nix/README.md) for the full consumer-side guide,
options reference, and platform notes.
