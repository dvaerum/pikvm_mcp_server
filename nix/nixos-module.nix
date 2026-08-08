{ config, lib, pkgs, ... }:

let
  cfg = config.services.pikvm-mcp;
  # (#51) Is a derive-from-endpoint URL declared eval-visibly? Either the first-class
  # `hidModeUrl` option or a PIKVM_HIDMODE_URL in extraEnv. (A URL that arrives only
  # via a runtime EnvironmentFile is invisible here — hence hidModeUrl is preferred.)
  hidModeUrlSet = cfg.hidModeUrl != null || (cfg.extraEnv ? "PIKVM_HIDMODE_URL");
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
      type = lib.types.nullOr (lib.types.enum [ "ipad" "desktop" ]);
      default = null;
      example = "desktop";
      description = ''
        The DECLARED control path (stock PiKVM / pikvm01). `ipad` = curve-one-shot
        mover + cascade detector (relative mouse); `desktop` = legacy
        detect-then-move (absolute mouse). Passed as `--target` when set.

        Leave `null` on an appliance that DERIVES its mode from the /hidmode
        endpoint — set {option}`services.pikvm-mcp.hidModeUrl` instead. Exactly one
        of `target` / `hidModeUrl` must be the source (both = eval error; see the
        assertion below); a declared `target` would be a second copy of the mode
        that can disagree with the appliance at runtime (pikvm-nixos #51).
      '';
    };

    hidModeUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://127.0.0.1:8083/hidmode";
      description = ''
        The appliance's loopback /hidmode endpoint (pikvm-nixos #51). When set, the
        MCP DERIVES its relative/absolute behaviour from the assembled gadget the
        endpoint reports and holds no copy of the mode — so leave
        {option}`services.pikvm-mcp.target` `null`. Wired as `PIKVM_HIDMODE_URL`.

        The bearer token is a secret and is NOT set here — inject
        `PIKVM_HIDMODE_TOKEN` via {option}`services.pikvm-mcp.extraEnv` or a
        systemd `EnvironmentFile` (e.g. the appliance's hidmode-endpoint module).
        Setting the URL here (rather than only via an EnvironmentFile) keeps it
        eval-visible so the mutual-exclusion assertion can protect against a
        both-set misconfiguration at eval time instead of a runtime crash-loop.
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
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/pikvm-password";
      description = ''
        Path to a file holding the PiKVM password. Loaded via systemd
        `LoadCredential` and read by the server as the `pikvm-password`
        credential. Point this at a sops-nix / agenix secret, e.g.
        `config.sops.secrets."pikvm/password".path`. Optional: leave null to run
        the server as an authenticated MCP gateway without device credentials
        (a tool that actually drives the PiKVM then errors until this is set).
      '';
    };

    security = lib.mkOption {
      type = lib.types.enum [ "yes" "no" "kvmd" ];
      default = "yes";
      description = ''
        Whether/how the MCP HTTP endpoint authenticates. This endpoint drives
        real input on a physical machine, so it defaults to `"yes"`.
        - `"yes"`: HTTP Basic against a static credential; requires
          {option}`authPasswordFile`.
        - `"kvmd"`: HTTP Basic validated against PiKVM's own users
          (`/etc/kvmd/htpasswd`, via kvmd `GET /api/auth/check`) — clients log in
          with their PiKVM username/password. Uses {option}`host` +
          {option}`verifySsl`; needs NO {option}`authPasswordFile`.
        - `"no"`: serves /mcp with NO auth (anyone who can reach the port controls
          the machine).
        Passed as `--security`.
      '';
    };

    allowToolLogin = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Also expose an in-band `login` MCP tool so a client can authenticate its
        session by calling a tool, without setting an `Authorization` header.
        Opt-in; only meaningful with {option}`security` = "yes" or "kvmd". A
        pre-auth session may connect without a header but can call ONLY `login`
        until it authenticates (with the same credentials the header would carry).
        The header-at-connect path stays the default and recommended posture.
        Passed as `--allow-tool-login`.
      '';
    };

    authUsername = lib.mkOption {
      type = lib.types.str;
      default = "operator";
      description = "Username for the MCP HTTP Basic auth (used when security = \"yes\").";
    };

    authPasswordFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/pikvm-mcp-auth-password";
      description = ''
        Path to a file holding the MCP HTTP auth password. Required when
        {option}`security` = "yes". Loaded via systemd `LoadCredential` as the
        `pikvm-mcp-auth-password` credential (never enters the Nix store); point
        it at a sops-nix / agenix secret. Clients then authenticate with HTTP
        Basic ({option}`authUsername` + this password).
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
    assertions = [
      {
        assertion = cfg.security != "yes" || cfg.authPasswordFile != null;
        message =
          "services.pikvm-mcp.security = \"yes\" requires services.pikvm-mcp.authPasswordFile "
          + "to be set (use security = \"kvmd\" to validate clients against PiKVM's own users, "
          + "or security = \"no\" to serve /mcp without authentication).";
      }
      {
        # (#51) Mutual exclusion at EVAL time — a declared target AND a derive-URL
        # both set is the two-copies defect, and would crash-loop at runtime (the
        # server fail-fasts on --target + PIKVM_HIDMODE_URL). Catch it here so the
        # toplevel eval / host-eval gate rejects it, not the running unit.
        assertion = !(cfg.target != null && hidModeUrlSet);
        message =
          "services.pikvm-mcp: `target` and `hidModeUrl` are mutually exclusive — the appliance "
          + "/hidmode endpoint is the single source of truth for the HID mode, so a declared "
          + "`target` would be a second copy that disagrees at runtime. Set exactly one (leave "
          + "`target = null` when deriving from `hidModeUrl`; unset `hidModeUrl`/PIKVM_HIDMODE_URL "
          + "when using a declared `target`).";
      }
    ];

    # A soft nudge for the no-source case (the server fail-fasts at startup either
    # way). Not a hard assertion: the URL may legitimately arrive via a runtime-only
    # EnvironmentFile the module can't see at eval time.
    warnings = lib.optional (cfg.target == null && !hidModeUrlSet) (
      "services.pikvm-mcp: neither `target` nor `hidModeUrl` is set. The service will fail to "
      + "start unless PIKVM_HIDMODE_URL is injected another way (e.g. an EnvironmentFile). Set "
      + "`target = \"ipad\"|\"desktop\"` (declared) or `hidModeUrl` (derive) to be explicit."
    );

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
      # (#51) Derive the HID mode from the appliance /hidmode endpoint (the token is
      # a secret — inject PIKVM_HIDMODE_TOKEN via extraEnv / an EnvironmentFile).
      // lib.optionalAttrs (cfg.hidModeUrl != null) {
        PIKVM_HIDMODE_URL = cfg.hidModeUrl;
      }
      // cfg.extraEnv;

      serviceConfig = {
        # HTTP transport (a long-lived system service can't use stdio).
        ExecStart =
          "${lib.getExe cfg.package} --transport http --host ${cfg.address} "
          + "--port ${toString cfg.port} --security ${cfg.security}"
          # (#51) --target ONLY for a declared source; omitted when deriving from
          # hidModeUrl (both-set would be the runtime fail-fast we now reject at eval).
          + lib.optionalString (cfg.target != null) " --target ${cfg.target}"
          + lib.optionalString (cfg.security == "yes") " --auth-username ${cfg.authUsername}"
          + lib.optionalString cfg.allowToolLogin " --allow-tool-login";

        # systemd drops each credential (0400, on tmpfs) into
        # $CREDENTIALS_DIRECTORY; the server reads them by name via
        # resolveSecret (config.ts): pikvm-password / pikvm-username /
        # pikvm-mcp-auth-password. No secret ever touches the Nix store, the unit
        # env, or the process cmdline.
        LoadCredential =
          lib.optional (cfg.passwordFile != null) "pikvm-password:${toString cfg.passwordFile}"
          ++ lib.optional (cfg.usernameFile != null) "pikvm-username:${toString cfg.usernameFile}"
          ++ lib.optional (
            cfg.security == "yes" && cfg.authPasswordFile != null
          ) "pikvm-mcp-auth-password:${toString cfg.authPasswordFile}";

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
