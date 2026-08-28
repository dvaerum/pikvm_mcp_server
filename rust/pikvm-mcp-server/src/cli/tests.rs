//! Tests for `cli`. TDD for the CLI option parser, mirroring
//! `cli.test.ts` + `hid-mode-source.test.ts`: transport selection
//! (flag > env > default), the --http shorthand, host/port overrides,
//! --help, validation of bad transport/port/target/security values, and
//! `resolve_hid_mode_source`'s exactly-one-source contract (#51).

use super::*;

fn argv(args: &[&str]) -> Vec<String> {
    args.iter().map(|s| s.to_string()).collect()
}

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

mod parse_cli_options_tests {
    use super::*;

    #[test]
    fn defaults_to_stdio_with_no_args_and_no_env() {
        let o = parse_cli_options(&argv(&[]), &env(&[])).unwrap();
        assert_eq!(o.transport, TransportKind::Stdio);
        assert!(!o.help);
    }

    #[test]
    fn transport_http_selects_http_with_default_host_port() {
        let o = parse_cli_options(&argv(&["--transport", "http"]), &env(&[])).unwrap();
        assert_eq!(o.transport, TransportKind::Http);
        assert_eq!(o.host, DEFAULT_HTTP_HOST);
        assert_eq!(o.port, DEFAULT_HTTP_PORT);
    }

    #[test]
    fn http_is_shorthand_for_transport_http() {
        let o = parse_cli_options(&argv(&["--http"]), &env(&[])).unwrap();
        assert_eq!(o.transport, TransportKind::Http);
    }

    #[test]
    fn host_and_port_override_the_defaults() {
        let o = parse_cli_options(
            &argv(&["--http", "--host", "0.0.0.0", "--port", "9123"]),
            &env(&[]),
        )
        .unwrap();
        assert_eq!(o.host, "0.0.0.0");
        assert_eq!(o.port, 9123);
    }

    #[test]
    fn falls_back_to_env_vars_when_the_flags_are_absent() {
        let o = parse_cli_options(
            &argv(&[]),
            &env(&[
                ("PIKVM_MCP_TRANSPORT", "http"),
                ("PIKVM_MCP_HOST", "1.2.3.4"),
                ("PIKVM_MCP_PORT", "8080"),
            ]),
        )
        .unwrap();
        assert_eq!(o.transport, TransportKind::Http);
        assert_eq!(o.host, "1.2.3.4");
        assert_eq!(o.port, 8080);
    }

    #[test]
    fn cli_flags_win_over_env_vars() {
        let o = parse_cli_options(
            &argv(&["--transport", "stdio", "--port", "5000"]),
            &env(&[("PIKVM_MCP_TRANSPORT", "http"), ("PIKVM_MCP_PORT", "8080")]),
        )
        .unwrap();
        assert_eq!(o.transport, TransportKind::Stdio);
        assert_eq!(o.port, 5000);
    }

    #[test]
    fn help_and_h_set_the_help_flag() {
        assert!(
            parse_cli_options(&argv(&["--help"]), &env(&[]))
                .unwrap()
                .help
        );
        assert!(parse_cli_options(&argv(&["-h"]), &env(&[])).unwrap().help);
    }

    #[test]
    fn rejects_an_unknown_transport() {
        let err = parse_cli_options(&argv(&["--transport", "ftp"]), &env(&[])).unwrap_err();
        assert!(err.to_lowercase().contains("transport"));
    }

    #[test]
    fn rejects_a_non_numeric_or_out_of_range_port() {
        assert!(
            parse_cli_options(&argv(&["--http", "--port", "abc"]), &env(&[]))
                .unwrap_err()
                .to_lowercase()
                .contains("port")
        );
        assert!(
            parse_cli_options(&argv(&["--http", "--port", "70000"]), &env(&[]))
                .unwrap_err()
                .to_lowercase()
                .contains("port")
        );
        assert!(
            parse_cli_options(&argv(&["--http", "--port", "0"]), &env(&[]))
                .unwrap_err()
                .to_lowercase()
                .contains("port")
        );
    }

    #[test]
    fn rejects_unknown_flags_strict_cli() {
        assert!(parse_cli_options(&argv(&["--nope"]), &env(&[])).is_err());
    }

    #[test]
    fn target_is_none_when_neither_the_flag_nor_the_env_is_set() {
        assert_eq!(
            parse_cli_options(&argv(&[]), &env(&[])).unwrap().target,
            None
        );
    }

    #[test]
    fn target_ipad_desktop_are_accepted() {
        assert_eq!(
            parse_cli_options(&argv(&["--target", "ipad"]), &env(&[]))
                .unwrap()
                .target,
            Some(TargetKind::Ipad)
        );
        assert_eq!(
            parse_cli_options(&argv(&["--target", "desktop"]), &env(&[]))
                .unwrap()
                .target,
            Some(TargetKind::Desktop)
        );
    }

    #[test]
    fn target_falls_back_to_env_and_the_flag_wins_over_env() {
        assert_eq!(
            parse_cli_options(&argv(&[]), &env(&[("PIKVM_TARGET", "desktop")]))
                .unwrap()
                .target,
            Some(TargetKind::Desktop)
        );
        assert_eq!(
            parse_cli_options(
                &argv(&["--target", "ipad"]),
                &env(&[("PIKVM_TARGET", "desktop")])
            )
            .unwrap()
            .target,
            Some(TargetKind::Ipad)
        );
    }

    #[test]
    fn rejects_an_invalid_target_including_the_removed_auto() {
        assert!(parse_cli_options(&argv(&["--target", "tablet"]), &env(&[]))
            .unwrap_err()
            .to_lowercase()
            .contains("target"));
        assert!(parse_cli_options(&argv(&["--target", "auto"]), &env(&[]))
            .unwrap_err()
            .to_lowercase()
            .contains("target"));
    }

    #[test]
    fn an_empty_target_blank_flag_or_env_is_unset_not_invalid() {
        assert_eq!(
            parse_cli_options(&argv(&["--target", ""]), &env(&[]))
                .unwrap()
                .target,
            None
        );
        assert_eq!(
            parse_cli_options(&argv(&[]), &env(&[("PIKVM_TARGET", "")]))
                .unwrap()
                .target,
            None
        );
    }

    #[test]
    fn security_is_none_by_default() {
        assert_eq!(
            parse_cli_options(&argv(&[]), &env(&[])).unwrap().security,
            None
        );
    }

    #[test]
    fn security_yes_no_kvmd_parse_env_fallback_flag_wins() {
        assert_eq!(
            parse_cli_options(&argv(&["--security", "yes"]), &env(&[]))
                .unwrap()
                .security,
            Some(SecurityChoice::Yes)
        );
        assert_eq!(
            parse_cli_options(&argv(&["--security", "no"]), &env(&[]))
                .unwrap()
                .security,
            Some(SecurityChoice::No)
        );
        assert_eq!(
            parse_cli_options(&argv(&["--security", "kvmd"]), &env(&[]))
                .unwrap()
                .security,
            Some(SecurityChoice::Kvmd)
        );
        assert_eq!(
            parse_cli_options(&argv(&[]), &env(&[("PIKVM_MCP_SECURITY", "yes")]))
                .unwrap()
                .security,
            Some(SecurityChoice::Yes)
        );
        assert_eq!(
            parse_cli_options(
                &argv(&["--security", "no"]),
                &env(&[("PIKVM_MCP_SECURITY", "yes")])
            )
            .unwrap()
            .security,
            Some(SecurityChoice::No)
        );
    }

    #[test]
    fn rejects_an_invalid_security_value() {
        assert!(
            parse_cli_options(&argv(&["--security", "maybe"]), &env(&[]))
                .unwrap_err()
                .to_lowercase()
                .contains("security")
        );
    }

    #[test]
    fn allow_tool_login_defaults_false_flag_and_env_enable_it_flag_wins() {
        assert!(
            !parse_cli_options(&argv(&[]), &env(&[]))
                .unwrap()
                .allow_tool_login
        );
        assert!(
            parse_cli_options(&argv(&["--allow-tool-login"]), &env(&[]))
                .unwrap()
                .allow_tool_login
        );
        assert!(
            parse_cli_options(&argv(&[]), &env(&[("PIKVM_MCP_ALLOW_TOOL_LOGIN", "true")]))
                .unwrap()
                .allow_tool_login
        );
        assert!(
            parse_cli_options(&argv(&[]), &env(&[("PIKVM_MCP_ALLOW_TOOL_LOGIN", "1")]))
                .unwrap()
                .allow_tool_login
        );
        assert!(
            !parse_cli_options(&argv(&[]), &env(&[("PIKVM_MCP_ALLOW_TOOL_LOGIN", "no")]))
                .unwrap()
                .allow_tool_login
        );
        // Flag present overrides a falsey env.
        assert!(
            parse_cli_options(
                &argv(&["--allow-tool-login"]),
                &env(&[("PIKVM_MCP_ALLOW_TOOL_LOGIN", "no")])
            )
            .unwrap()
            .allow_tool_login
        );
    }

    #[test]
    fn parses_the_http_auth_options_flag_plus_env_for_username() {
        let o = parse_cli_options(
            &argv(&[
                "--auth-username",
                "alice",
                "--auth-password",
                "pw",
                "--auth-password-file",
                "/run/p",
            ]),
            &env(&[]),
        )
        .unwrap();
        assert_eq!(o.auth_username.as_deref(), Some("alice"));
        assert_eq!(o.auth_password.as_deref(), Some("pw"));
        assert_eq!(o.auth_password_file.as_deref(), Some("/run/p"));
        assert_eq!(
            parse_cli_options(&argv(&[]), &env(&[("PIKVM_MCP_AUTH_USERNAME", "bob")]))
                .unwrap()
                .auth_username
                .as_deref(),
            Some("bob")
        );
    }
}

mod resolve_hid_mode_source_tests {
    use super::*;

    #[test]
    fn declared_target_with_no_endpoint_url_stock_pikvm01_regression_clean() {
        assert_eq!(
            resolve_hid_mode_source(Some(TargetKind::Ipad), None),
            Ok(HidModeSource::Declared {
                target: TargetKind::Ipad
            })
        );
        assert_eq!(
            resolve_hid_mode_source(Some(TargetKind::Desktop), None),
            Ok(HidModeSource::Declared {
                target: TargetKind::Desktop
            })
        );
        // Blank URL = unset.
        assert_eq!(
            resolve_hid_mode_source(Some(TargetKind::Ipad), Some("")),
            Ok(HidModeSource::Declared {
                target: TargetKind::Ipad
            })
        );
        assert_eq!(
            resolve_hid_mode_source(Some(TargetKind::Ipad), Some("   ")),
            Ok(HidModeSource::Declared {
                target: TargetKind::Ipad
            })
        );
    }

    #[test]
    fn endpoint_url_with_no_target_the_appliance() {
        assert_eq!(
            resolve_hid_mode_source(None, Some("http://127.0.0.1:8080")),
            Ok(HidModeSource::Endpoint)
        );
    }

    #[test]
    fn both_set_errors_the_two_copies_defect_caught_at_config_time() {
        let err = resolve_hid_mode_source(Some(TargetKind::Ipad), Some("http://127.0.0.1:8080"))
            .unwrap_err();
        let lower = err.to_lowercase();
        assert!(lower.contains("mutually exclusive") || lower.contains("single source of truth"));
    }

    #[test]
    fn neither_set_errors_no_source() {
        let err = resolve_hid_mode_source(None, None).unwrap_err();
        let lower = err.to_lowercase();
        assert!(lower.contains("required") || lower.contains("source"));
    }
}
