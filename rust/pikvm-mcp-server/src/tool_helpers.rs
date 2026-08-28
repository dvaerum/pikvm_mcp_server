//! Input-validation helpers shared by every `pikvm_*` tool handler.
//!
//! Faithful port of `src/index.ts`'s "Input Validation Helpers" section.
//! Deliberately permissive, NOT zod-strict: a number is clamped to bounds
//! rather than rejected when out of range, an enum silently falls back to
//! its documented default rather than throwing, and only a genuinely
//! missing/wrong-typed REQUIRED field is an error. A Rust port using
//! strict schema validation (e.g. rmcp's `schemars`-derived strict
//! `Parameters<T>` extractor) would reject inputs the TS server has always
//! accepted — this module exists specifically to preserve that exact
//! permissiveness.
//!
//! Handlers work off a `&serde_json::Map<String, serde_json::Value>` (the
//! `arguments` object of a `tools/call` request) rather than TS's
//! `Record<string, unknown>` — same shape, different vocabulary.

use serde_json::{Map, Value};

/// Validate that a value is a string, returning `None` if not (or absent).
/// Faithful port of `validateString`.
pub fn validate_string(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key)?.as_str().map(str::to_string)
}

/// Validate that a value is a non-empty string; `Err` (mirroring the TS
/// `throw`) if missing/wrong-typed/empty. Faithful port of `requireString`.
pub fn require_string(args: &Map<String, Value>, key: &str) -> Result<String, String> {
    match args.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(format!("{key} is required and must be a non-empty string")),
    }
}

/// Validate + clamp a number to `[min, max]`, returning `None` if the
/// value is absent/not-a-finite-number. Faithful port of `validateNumber`
/// (clamp-not-reject, matching the TS `Math.max`/`Math.min` pair).
pub fn validate_number(
    args: &Map<String, Value>,
    key: &str,
    min: Option<f64>,
    max: Option<f64>,
) -> Option<f64> {
    let value = args.get(key)?.as_f64()?;
    if !value.is_finite() {
        return None;
    }
    Some(clamp(value, min, max))
}

/// Validate that a value is a number, `Err` if missing/wrong-typed;
/// clamps to `[min, max]` when present. Faithful port of `requireNumber`.
pub fn require_number(
    args: &Map<String, Value>,
    key: &str,
    field_name: &str,
    min: Option<f64>,
    max: Option<f64>,
) -> Result<f64, String> {
    let value = args
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| format!("{field_name} is required and must be a number"))?;
    Ok(clamp(value, min, max))
}

fn clamp(value: f64, min: Option<f64>, max: Option<f64>) -> f64 {
    let mut result = value;
    if let Some(min) = min {
        result = result.max(min);
    }
    if let Some(max) = max {
        result = result.min(max);
    }
    result
}

/// Faithful port of `validateBoolean`.
pub fn validate_boolean(args: &Map<String, Value>, key: &str) -> Option<bool> {
    args.get(key)?.as_bool()
}

/// An array of strings with at least `min_length` elements; `Err` if
/// missing/too-short/contains a non-string. Faithful port of
/// `requireStringArray`.
pub fn require_string_array(
    args: &Map<String, Value>,
    key: &str,
    field_name: &str,
    min_length: usize,
) -> Result<Vec<String>, String> {
    let arr = args
        .get(key)
        .and_then(Value::as_array)
        .filter(|a| a.len() >= min_length)
        .ok_or_else(|| {
            format!("{field_name} must be an array with at least {min_length} element(s)")
        })?;
    arr.iter()
        .map(|item| {
            item.as_str()
                .map(str::to_string)
                .ok_or_else(|| format!("{field_name} must contain only strings"))
        })
        .collect()
}

/// Optional string array — non-string elements are silently dropped, a
/// missing/non-array value yields an empty vec. Faithful port of
/// `validateStringArray`.
pub fn validate_string_array(args: &Map<String, Value>, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Faithful port of `validateEnum`: a value not present in `allowed`
/// (including wrong type or absent) silently falls back to `default`,
/// never an error.
pub fn validate_enum<'a>(
    args: &Map<String, Value>,
    key: &str,
    allowed: &[&'a str],
    default: &'a str,
) -> &'a str {
    match args.get(key).and_then(Value::as_str) {
        Some(v) if allowed.contains(&v) => allowed.iter().find(|a| **a == v).unwrap(),
        _ => default,
    }
}

pub const VALID_BUTTONS: &[&str] = &["left", "right", "middle", "up", "down"];
pub const VALID_KEY_STATES: &[&str] = &["press", "release", "click"];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn validate_string_returns_the_string_when_present() {
        assert_eq!(
            validate_string(&args(json!({"a": "hi"})), "a"),
            Some("hi".to_string())
        );
    }

    #[test]
    fn validate_string_returns_none_for_absent_or_wrong_type() {
        assert_eq!(validate_string(&args(json!({})), "a"), None);
        assert_eq!(validate_string(&args(json!({"a": 5})), "a"), None);
    }

    #[test]
    fn require_string_errors_on_missing_or_empty() {
        assert!(require_string(&args(json!({})), "text").is_err());
        assert!(require_string(&args(json!({"text": ""})), "text").is_err());
    }

    #[test]
    fn require_string_returns_the_value_when_present() {
        assert_eq!(
            require_string(&args(json!({"text": "hi"})), "text").unwrap(),
            "hi"
        );
    }

    #[test]
    fn validate_number_clamps_to_bounds_rather_than_rejecting() {
        assert_eq!(
            validate_number(&args(json!({"q": 500})), "q", Some(1.0), Some(100.0)),
            Some(100.0)
        );
        assert_eq!(
            validate_number(&args(json!({"q": -5})), "q", Some(1.0), Some(100.0)),
            Some(1.0)
        );
        assert_eq!(
            validate_number(&args(json!({"q": 50})), "q", Some(1.0), Some(100.0)),
            Some(50.0)
        );
    }

    #[test]
    fn validate_number_returns_none_for_absent_or_non_finite() {
        assert_eq!(validate_number(&args(json!({})), "q", None, None), None);
        assert_eq!(
            validate_number(&args(json!({"q": "5"})), "q", None, None),
            None
        );
    }

    #[test]
    fn require_number_clamps_but_errors_when_not_a_number_at_all() {
        assert_eq!(
            require_number(
                &args(json!({"delay": 9999})),
                "delay",
                "delay",
                Some(0.0),
                Some(200.0)
            )
            .unwrap(),
            200.0
        );
        assert!(require_number(&args(json!({})), "delay", "delay", None, None).is_err());
    }

    #[test]
    fn validate_boolean_reads_a_real_bool_only() {
        assert_eq!(validate_boolean(&args(json!({"b": true})), "b"), Some(true));
        assert_eq!(validate_boolean(&args(json!({"b": "true"})), "b"), None);
    }

    #[test]
    fn require_string_array_enforces_min_length_and_string_elements() {
        assert!(require_string_array(&args(json!({"keys": []})), "keys", "keys", 1).is_err());
        assert!(require_string_array(&args(json!({"keys": ["a", 5]})), "keys", "keys", 1).is_err());
        assert_eq!(
            require_string_array(&args(json!({"keys": ["a", "b"]})), "keys", "keys", 1).unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn validate_string_array_drops_non_strings_and_defaults_to_empty() {
        assert_eq!(
            validate_string_array(&args(json!({})), "modifiers"),
            Vec::<String>::new()
        );
        assert_eq!(
            validate_string_array(
                &args(json!({"modifiers": ["ctrl", 5, "shift"]})),
                "modifiers"
            ),
            vec!["ctrl".to_string(), "shift".to_string()]
        );
    }

    #[test]
    fn validate_enum_falls_back_to_default_rather_than_erroring() {
        assert_eq!(
            validate_enum(
                &args(json!({"state": "press"})),
                "state",
                VALID_KEY_STATES,
                "click"
            ),
            "press"
        );
        assert_eq!(
            validate_enum(
                &args(json!({"state": "bogus"})),
                "state",
                VALID_KEY_STATES,
                "click"
            ),
            "click"
        );
        assert_eq!(
            validate_enum(&args(json!({})), "state", VALID_KEY_STATES, "click"),
            "click"
        );
    }
}
