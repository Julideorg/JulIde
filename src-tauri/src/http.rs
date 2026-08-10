//! One hardened outbound HTTP client, shared by every feature that reaches the network.
//!
//! Extracted from `marketplace`, which had the only hardened client in the tree. The
//! hardening must not be re-derived — and re-forgotten — at each call site, which is
//! exactly what happened in the git provider modules, where every client is built with
//! no timeout and no redirect policy at all.
//!
//! Nothing here runs in the webview. Fetching in Rust keeps `connect-src` narrow: a
//! remote host reachable from the webview is reachable by everything sharing that realm.

use once_cell::sync::Lazy;
use std::time::Duration;

/// The shared client. `https_only`, bounded redirects, no scheme downgrade.
pub static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            // Limited, not disabled: GitHub sends release-asset downloads to a storage
            // host, so refusing redirects would break the common hosting layout. Each
            // hop is re-checked, because "the first URL was fine" says nothing about
            // where it points next.
            if attempt.previous().len() >= 3 {
                return attempt.error("too many redirects");
            }
            if attempt.url().scheme() != "https" {
                return attempt.stop();
            }
            // Re-checked per hop for the same reason the scheme is: a public URL that
            // 302s to http://169.254.169.254/ is the whole point of the redirect trick.
            if !is_plausibly_public(attempt.url()) {
                return attempt.stop();
            }
            attempt.follow()
        }))
        .user_agent(concat!("julIDE/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("shared HTTP client")
});

/// Refuse destinations that are obviously not on the public internet.
///
/// Honest about its limit: this checks IP **literals** and a few reserved names. A
/// hostname that resolves to 10.0.0.5 is still requested, because resolution happens
/// after this runs. It stops `https://10.0.0.1/admin` and `https://[::1]:9200` written
/// into a README — which is the shape that actually appears — and it is not an SSRF
/// boundary. Callers fetching constant URLs (the registry) do not need it; callers
/// fetching URLs out of a document do.
pub fn is_plausibly_public(url: &url::Url) -> bool {
    use std::net::Ipv4Addr;
    use url::Host;

    fn v4_is_public(v4: Ipv4Addr) -> bool {
        let o = v4.octets();
        !(v4.is_loopback()
            || v4.is_private()
            || v4.is_link_local()
            || v4.is_broadcast()
            || v4.is_documentation()
            || v4.is_unspecified()
            // 100.64.0.0/10, carrier-grade NAT.
            || (o[0] == 100 && (64..128).contains(&o[1]))
            // 0.0.0.0/8 and the 240/4 reserved block.
            || o[0] == 0
            || o[0] >= 240)
    }

    // `url::Host` rather than `host_str`, which keeps the brackets on an IPv6 literal
    // and so never parses as an address.
    match url.host() {
        None => false,
        Some(Host::Ipv4(v4)) => v4_is_public(v4),
        Some(Host::Ipv6(v6)) => {
            // `is_unique_local` and `is_unicast_link_local` are still unstable, so the
            // prefixes are matched by hand: fc00::/7 and fe80::/10.
            let seg = v6.segments()[0];
            if v6.is_loopback()
                || v6.is_unspecified()
                || (seg & 0xfe00) == 0xfc00
                || (seg & 0xffc0) == 0xfe80
            {
                return false;
            }
            // ::ffff:10.0.0.1 must not launder a private address through IPv6.
            match v6.to_ipv4_mapped() {
                Some(v4) => v4_is_public(v4),
                None => true,
            }
        }
        Some(Host::Domain(domain)) => {
            let host = domain.trim_end_matches('.').to_ascii_lowercase();
            if host == "localhost" || host.ends_with(".localhost") {
                return false;
            }
            // mDNS and the conventional private suffixes.
            if host.ends_with(".local")
                || host.ends_with(".internal")
                || host.ends_with(".home.arpa")
            {
                return false;
            }
            // A bare label with no dot resolves through the search domain, i.e. the LAN.
            host.contains('.')
        }
    }
}

/// Reject a URL before it is fetched, with a message worth reading.
pub fn assert_https(raw: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|_| format!("not a valid URL: {raw}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("refusing a non-https URL: {raw}"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(format!("refusing a URL with embedded credentials: {raw}"));
    }
    if parsed.host_str().is_none() {
        return Err(format!("URL has no host: {raw}"));
    }
    Ok(parsed)
}

/// Read a response body, giving up past `cap`.
///
/// `content_length` is advisory — it may be absent and it may lie — so the loop is the
/// guard. Checking the header first only avoids downloading something already known to
/// be too large.
///
/// `not_found_hint` is appended to a 404, where the caller usually knows something the
/// status code does not: for the registry, "not published yet" is the normal state
/// rather than a fault, and saying only "HTTP 404" leaves the reader to guess.
pub async fn read_capped(
    mut response: reqwest::Response,
    cap: usize,
    what: &str,
    not_found_hint: Option<&str>,
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        if response.status() == tauri::http::StatusCode::NOT_FOUND {
            let hint = not_found_hint.map(|h| format!(" {h}")).unwrap_or_default();
            return Err(format!("{what} was not found at {}.{hint}", response.url()));
        }
        return Err(format!("{what}: HTTP {}", response.status()));
    }
    if matches!(response.content_length(), Some(n) if n > cap as u64) {
        return Err(format!("{what} is larger than the {cap} byte limit"));
    }

    let mut out: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if out.len() + chunk.len() > cap {
            return Err(format!("{what} exceeded the {cap} byte limit"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn public(raw: &str) -> bool {
        is_plausibly_public(&url::Url::parse(raw).unwrap())
    }

    #[test]
    fn internal_destinations_are_refused() {
        for bad in [
            "https://127.0.0.1/x",
            "https://127.1.2.3/x",
            "https://10.1.2.3/x",
            "https://192.168.0.1/x",
            "https://172.16.0.1/x",
            "https://169.254.169.254/latest/meta-data/",
            "https://0.0.0.0/x",
            "https://100.64.0.1/x",
            "https://[::1]/x",
            "https://[fc00::1]/x",
            "https://[fe80::1]/x",
            "https://[::ffff:10.0.0.1]/x",
            "https://localhost/x",
            "https://foo.localhost/x",
            "https://printer.local/x",
            "https://db.internal/x",
            "https://router.home.arpa/x",
            // A bare label resolves through the search domain, i.e. on the LAN.
            "https://intranet/x",
        ] {
            assert!(!public(bad), "should have been refused: {bad}");
        }
    }

    #[test]
    fn ordinary_public_hosts_are_allowed() {
        for good in [
            "https://img.shields.io/badge/x.svg",
            "https://raw.githubusercontent.com/a/b/c.png",
            "https://example.co.uk/x",
            "https://8.8.8.8/x",
            "https://[2606:4700::1111]/x",
            // A trailing root dot is still the same public name.
            "https://example.com./x",
        ] {
            assert!(public(good), "should have been allowed: {good}");
        }
    }

    #[test]
    fn https_only_and_no_credentials() {
        assert!(assert_https("https://example.com/x").is_ok());
        for bad in [
            "http://example.com/x",
            "file:///etc/passwd",
            "ftp://example.com/x",
            "javascript:alert(1)",
            "https://user:pw@example.com/x",
            "not a url",
        ] {
            assert!(assert_https(bad).is_err(), "{bad}");
        }
    }
}
