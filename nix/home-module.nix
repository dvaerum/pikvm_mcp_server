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
      export PIKVM_VERIFY_SSL=${lib.escapeShellArg (lib.boolToString cfg.verifySsl)}
      export PIKVM_DEFAULT_KEYMAP=${lib.escapeShellArg cfg.defaultKeymap}
      ${lib.concatStringsSep "\n" (lib.mapAttrsToList
        (k: v: "export ${k}=${lib.escapeShellArg v}")
        cfg.extraEnv)}

      # The server reads secrets from files itself (config.ts resolveSecret), so
      # rotations take effect on the next spawn without a home-manager switch and
      # no secret lands in the Nix store or the process environment.
      export PIKVM_PASSWORD_FILE=${lib.escapeShellArg (toString cfg.passwordFile)}
      ${if cfg.usernameFile != null
        then "export PIKVM_USERNAME_FILE=${lib.escapeShellArg (toString cfg.usernameFile)}"
        else "export PIKVM_USERNAME=${lib.escapeShellArg cfg.username}"}

      cd "$DATA_DIR"
      exec ${lib.getExe cfg.package} "$@"
    '';
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

    usernameFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/user/1000/secrets/pikvm-username";
      description = ''
        Optional path to a file containing the PiKVM username. When set it is
        read at MCP startup (via PIKVM_USERNAME_FILE) and overrides
        {option}`username`; never enters the Nix store. Pair with sops-nix or
        agenix. Leave null to use the literal {option}`username`.
      '';
    };

    passwordFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Path to a file containing the PiKVM password.
        Read at MCP startup (via PIKVM_PASSWORD_FILE); never enters the Nix
        store. Pair this with sops-nix or agenix for secret management; the MCP
        server picks up changes without a home-manager switch.
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

    # TODO(http-transport): Once the server gains an HTTP/SSE transport,
    # add `http.enable` here plus a systemd.user.services unit that runs
    # the wrapper as a long-lived listener. Currently stdio-only.
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ wrapperPkg cfg.package ];

    home.activation.pikvmMcpData =
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        $DRY_RUN_CMD mkdir -p ${lib.escapeShellArg cfg.dataDir}
        $DRY_RUN_CMD chmod 700 ${lib.escapeShellArg cfg.dataDir}
      '';
  };
}
