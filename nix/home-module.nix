{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.pikvm-mcp;

  # Wrapper script: reads the password file at every spawn so rotations
  # work without rebuilds, exports the static env vars, ensures the data
  # dir exists, and chdirs into it so the server's relative ./data/
  # paths (ballistics.json, cursor-template.jpg) land there.
  wrapperPkg = pkgs.writeShellApplication {
    name = "pikvm-mcp-server-wrapped";
    runtimeInputs = [ cfg.package ];
    text = ''
      set -euo pipefail

      DATA_DIR="${cfg.dataDir}"
      mkdir -p "$DATA_DIR"

      export PIKVM_HOST=${lib.escapeShellArg cfg.host}
      export PIKVM_USERNAME=${lib.escapeShellArg cfg.username}
      export PIKVM_VERIFY_SSL=${lib.escapeShellArg (lib.boolToString cfg.verifySsl)}
      export PIKVM_DEFAULT_KEYMAP=${lib.escapeShellArg cfg.defaultKeymap}
      ${lib.concatStringsSep "\n" (lib.mapAttrsToList
        (k: v: "export ${k}=${lib.escapeShellArg v}")
        cfg.extraEnv)}

      # Read the password fresh on every spawn so password rotations
      # don't require home-manager switch.
      PIKVM_PASSWORD="$(cat ${lib.escapeShellArg (toString cfg.passwordFile)})"
      export PIKVM_PASSWORD

      cd "$DATA_DIR"
      exec ${lib.getExe cfg.package} "$@"
    '';
  };

  wrapperBin = "${wrapperPkg}/bin/pikvm-mcp-server-wrapped";

  # Fragment to merge into ~/.claude.json. The deepMerge strategy on the
  # outer object preserves any other top-level keys the user has, and
  # the deepMerge on `mcpServers` preserves any other registered MCP
  # servers from other tools.
  claudeFragment = pkgs.writers.writeJSON "pikvm-mcp-claude-fragment.json" {
    mcpServers.${cfg.claudeCode.name} = {
      command = wrapperBin;
      args = [ ];
    };
  };
in
{
  options.services.pikvm-mcp = {
    enable = lib.mkEnableOption "PiKVM MCP server (stdio, on-demand)";

    package = lib.mkPackageOption pkgs "pikvm-mcp-server" { };

    host = lib.mkOption {
      type = lib.types.str;
      example = "https://pikvm01.lan";
      description = "PiKVM base URL (with scheme).";
    };

    username = lib.mkOption {
      type = lib.types.str;
      default = "admin";
      description = "PiKVM API username.";
    };

    passwordFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Path to a file containing the PiKVM password.
        Read at MCP startup; never enters the Nix store. Pair this with
        sops-nix or agenix for secret management; the MCP server picks
        up changes without a home-manager switch.
      '';
    };

    verifySsl = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Verify the PiKVM's TLS certificate. Most PiKVM appliances ship
        with self-signed certs, hence the default. Set to true if you
        have provisioned a real cert.
      '';
    };

    defaultKeymap = lib.mkOption {
      type = lib.types.str;
      default = "en-us";
      description = "Default keyboard layout used when typing text.";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.dataHome}/pikvm-mcp";
      defaultText = lib.literalExpression ''"${"$"}{config.xdg.dataHome}/pikvm-mcp"'';
      description = ''
        Where the MCP server keeps its mutable runtime data
        (ballistics.json, cursor-template.jpg). Created with mode 0700
        on activation.
      '';
    };

    extraEnv = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''{ PIKVM_CALIBRATION_ROUNDS = "10"; }'';
      description = "Additional environment variables to export when launching the server.";
    };

    claudeCode = {
      enable = lib.mkEnableOption "register the MCP server in ~/.claude.json";

      name = lib.mkOption {
        type = lib.types.str;
        default = "pikvm";
        description = ''
          Key under `mcpServers` in ~/.claude.json — also the name Claude
          Code uses to refer to this server in `claude mcp list`.
        '';
      };
    };

    # TODO(http-transport): Once the server gains an HTTP/SSE transport,
    # add `http.enable` here plus a systemd.user.services unit that runs
    # the wrapper as a long-lived listener. Currently stdio-only.
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.packages = [ wrapperPkg cfg.package ];

      home.activation.pikvmMcpData =
        lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          $DRY_RUN_CMD mkdir -p ${lib.escapeShellArg cfg.dataDir}
          $DRY_RUN_CMD chmod 700 ${lib.escapeShellArg cfg.dataDir}
        '';
    }

    (lib.mkIf cfg.claudeCode.enable {
      # Delegate the actual deep-merge into ~/.claude.json to nix-it-in's
      # own home-manager module. Pulling in nix-it-in is the consumer's
      # responsibility (the flake's homeManagerModules.pikvm-mcp imports
      # nixitin's module so they get composed automatically).
      services.nixitin = {
        enable = true;
        runOnActivation = true;
        merges.pikvm-mcp = {
          src = claudeFragment;
          dst = ".claude.json";
          outputFormat = "json";
          objectMergeStrategy = "deepMerge";
          # Defensive: we don't write arrays, but if Claude Code does,
          # accumulate rather than replace.
          arrayMergeStrategy = "append";
          conflictResolution = "preferSource";
          createDstFileIfMissing = true;
          createDstFileParentFolderIfMissing = true;
        };
      };
    })
  ]);
}
