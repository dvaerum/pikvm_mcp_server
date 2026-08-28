//! TLS setup: the process-level crypto provider install and the
//! connector, including the `verify_ssl: false` self-signed-cert bypass
//! for the PiKVM's own deployment case. Self-contained — no dependency
//! on this module's own config/session types.

use std::sync::Arc;

/// rustls (as of the 0.23 line) needs a process-level `CryptoProvider`
/// installed explicitly before any `ClientConfig` can be built — it no
/// longer picks one automatically when multiple crypto backends could be
/// linked in. Caught live: this crate compiled and unit-tested cleanly
/// (the DI'd fake connector never touches real TLS), but the FIRST real
/// hardware run against the actual PiKVM panicked here — exactly the class
/// of bug this project's "gate through the real entry point" discipline
/// exists to catch. `Once`-guarded so calling this from multiple call
/// sites (or a caller that also installs a provider) doesn't panic on a
/// double-install.
fn ensure_crypto_provider() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

pub(super) fn build_tls_connector(verify_ssl: bool) -> tokio_rustls::TlsConnector {
    ensure_crypto_provider();
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let mut config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    if !verify_ssl {
        // The PiKVM's self-signed cert case — mirrors the TS
        // `rejectUnauthorized: this.config.verifySsl` (verify_ssl=false =>
        // don't reject unauthorized/self-signed certs).
        config
            .dangerous()
            .set_certificate_verifier(Arc::new(NoCertVerification));
    }
    tokio_rustls::TlsConnector::from(Arc::new(config))
}

/// Faithful equivalent of Node's `tls.connect({rejectUnauthorized: false})`
/// — accept any server certificate. Only used when `verify_ssl` is false
/// (the PiKVM's self-signed cert deployment case), never the default.
#[derive(Debug)]
struct NoCertVerification;

impl rustls::client::danger::ServerCertVerifier for NoCertVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &rustls_pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::aws_lc_rs::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
