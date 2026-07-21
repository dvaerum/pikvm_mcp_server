{ config, lib, pkgs, ... }:

let
  cfg = config.services.pikvm-mcp;
in
{
  options.services.pikvm-mcp = {
    enable = lib.mkEnableOption "PiKVM MCP server as a Streamable HTTP system service";

    package = lib.mkPackageOption pkgs "pikvm-mcp-server" { };

    host = lib.mkOption {
      type = lib.types.str;
      example = "https://pikvm01.lan";
      description = "PiKVM base URL (with scheme). Not a secret — it is an ordinary env var.";
    };

    target = lib.mkOption {
      type = lib.types.enum [ "ipad" "desktop" ];
      example = "desktop";
      description = ''
        Which control path to use (REQUIRED — no auto-detect). `ipad` =
        curve-one-shot mover + cascade detector (relative mouse); `desktop` =
        legacy detect-then-move (absolute mouse). Passed as `--target`.
      '';
    };

    username = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "admin";
      description = ''
        PiKVM API username as a literal string. To keep it out of the Nix store
        set {option}`usernameFile` instead (which takes precedence).
      '';
    };

    usernameFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/pikvm-username";
      description = ''
        Path to a file holding the PiKVM username. Loaded via systemd
        `LoadCredential` (mode 0400, tmpfs — never enters the Nix store) and
        read by the server as the `pikvm-username` credential. Point this at a
        sops-nix or agenix secret. Overrides {option}`username`.
      '';
    };

    passwordFile = lib.mkOption {
      type = lib.types.path;
      example = "/run/secrets/pikvm-password";
      description = ''
        Path to a file holding the PiKVM password. Loaded via systemd
        `LoadCredential` and read by the server as the `pikvm-password`
        credential. Point this at a sops-nix / agenix secret, e.g.
        `config.sops.secrets."pikvm/password".path`.
      '';
    };

    address = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address the Streamable HTTP transport binds to.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port the Streamable HTTP transport listens on (POST/GET/DELETE /mcp).";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open {option}`port` in the firewall.";
    };

    verifySsl = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Verify the PiKVM TLS certificate (most appliances ship self-signed).";
    };

    extraEnv = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = lib.literalExpression ''{ PIKVM_DEFAULT_KEYMAP = "de"; }'';
      description = "Extra environment variables for the service.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.pikvm-mcp = {
      description = "PiKVM MCP server (Streamable HTTP)";
      documentation = [ "https://github.com/dvaerum/pikvm_mcp_server" ];
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        PIKVM_HOST = cfg.host;
        PIKVM_VERIFY_SSL = lib.boolToString cfg.verifySsl;
      }
      # Literal username only when NOT provided via a credential file.
      // lib.optionalAttrs (cfg.usernameFile == null && cfg.username != null) {
        PIKVM_USERNAME = cfg.username;
      }
      // cfg.extraEnv;

      serviceConfig = {
        # HTTP transport (a long-lived system service can't use stdio).
        ExecStart = "${lib.getExe cfg.package} --transport http --host ${cfg.address} --port ${toString cfg.port} --target ${cfg.target}";

        # systemd drops each credential (0400, on tmpfs) into
        # $CREDENTIALS_DIRECTORY; the server reads them by name via
        # resolveSecret (config.ts): pikvm-password / pikvm-username. No secret
        # ever touches the Nix store, the unit env, or the process cmdline.
        LoadCredential =
          [ "pikvm-password:${toString cfg.passwordFile}" ]
          ++ lib.optional (cfg.usernameFile != null) "pikvm-username:${toString cfg.usernameFile}";

        DynamicUser = true;
        StateDirectory = "pikvm-mcp";
        WorkingDirectory = "%S/pikvm-mcp";
        Restart = "on-failure";
        RestartSec = 5;

        # Hardening.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        LockPersonality = true;
        # Node's V8 JIT needs writable+executable pages, so W^X must stay off.
        MemoryDenyWriteExecute = false;
        SystemCallFilter = [ "@system-service" ];
        SystemCallErrorNumber = "EPERM";
        UMask = "0077";
      };
    };

    networking.firewall = lib.mkIf cfg.openFirewall {
      allowedTCPPorts = [ cfg.port ];
    };
  };
}
