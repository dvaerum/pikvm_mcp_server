//! An explicit, named opt-in to skip TLS certificate verification —
//! needed for a `pikvm-mcp-server` behind its own self-signed appliance
//! cert (the real `pikvm` cert's `subjectAltName` covers `CN=pikvm`, not
//! whatever external hostname a reverse proxy fronts it as). Mirrors the
//! spirit of this project's existing `PikvmConfig::verify_ssl` knob for
//! talking to a PiKVM appliance's own cert — a real, scoped, opt-in
//! feature, never a silent default.
//!
//! Only reachable via `connection.rs`'s own `insecure_tls: bool` param,
//! itself only set from `--insecure-tls`/`PIKVM_OFFLOAD_INSECURE_TLS=1`
//! (`config.rs`) — an operator has to ask for this explicitly.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};

/// A `rustls::ClientConfig` that accepts any server certificate — the
/// insecure-TLS opt-in's actual mechanism.
pub(super) fn client_config() -> ClientConfig {
    // rustls 0.23 requires a process-wide crypto provider; installing it
    // here (idempotent — an already-installed provider's Err is ignored,
    // matching this crate's own `ort::init().commit()` idempotency
    // convention) means this function stays a self-contained, callable-
    // anywhere entry point rather than requiring `main.rs` to remember a
    // separate one-time setup step.
    let _ = rustls::crypto::ring::default_provider().install_default();

    ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(std::sync::Arc::new(AcceptAnyCert))
        .with_no_client_auth()
}

#[derive(Debug)]
struct AcceptAnyCert;

impl ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        // Never actually checked (verify_tls*_signature always accepts),
        // but rustls requires a non-empty list to pick a cipher suite at
        // all — list everything it knows about.
        vec![
            SignatureScheme::RSA_PKCS1_SHA1,
            SignatureScheme::ECDSA_SHA1_Legacy,
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP521_SHA512,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
            SignatureScheme::ED448,
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_config_builds_without_panicking() {
        // The real assertion: this doesn't panic (a missing crypto
        // provider or a malformed verifier setup would panic deep inside
        // rustls during a later handshake, not here — but constructing
        // the config at all is the first real checkpoint).
        let _config = client_config();
    }
}
