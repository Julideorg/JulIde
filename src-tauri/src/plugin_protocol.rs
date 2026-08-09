//! Custom URI scheme that serves sandboxed plugin frames.
//!
//! Plugins must not run in julIDE's own realm: there they reach
//! `window.__TAURI_INTERNALS__` and every Tauri command with no declared permission at
//! all. The fix is to run each plugin in an `<iframe sandbox="allow-scripts">` — no
//! `allow-same-origin`, so the frame gets an opaque origin — with a per-plugin CSP.
//!
//! That CSP cannot be delivered by `srcdoc`, a `blob:` URL, or a `<meta>` tag. A
//! document created from `about:srcdoc` or `blob:` inherits the *embedder's* policy
//! container, and `'self'` evaluated inside an opaque origin matches nothing at all —
//! not inline script, not blob, not even the document's own source. A `<meta>` CSP can
//! only narrow what was inherited, never widen it. So a srcdoc frame either runs no
//! script whatsoever, or only runs script because the top-level `script-src` was
//! loosened — which would hand the main realm the exact capability this exists to remove.
//!
//! A custom scheme can set a real `Content-Security-Policy` *response header*, which is
//! the one mechanism that works. It is also well-trodden ground in this stack: julIDE's
//! own CSP arrives this way over `tauri://`, and Tauri's isolation pattern serves a
//! bespoke-CSP document into an iframe over a custom scheme on every platform.
//!
//! Verified on WebKitGTK: the frame loads, the header is applied (an un-nonced inline
//! script does not run), `window.origin` is `"null"`, `__TAURI_INTERNALS__` is absent,
//! `parent.document` throws, `localStorage` throws, and `fetch` is blocked by
//! `connect-src 'none'`.

use crate::plugins::{validate_plugin_name, PluginManifest};
use std::path::{Path, PathBuf};

/// The plugin bootstrap, built from `src/plugin-sdk/bootstrap.ts`.
///
/// Inlined into every frame document rather than served as a separate script: a
/// `<script src=...>` load from an opaque origin is a CORS fetch, and wry does not
/// register custom schemes as CORS-enabled on WebKitGTK.
///
/// Both this and the plugin's own entry are inlined as **classic** scripts, not modules.
/// Measured, not assumed: an inline `<script type="module">` in this frame does not
/// execute on WebKitGTK — it runs no code and raises no error, so a plugin simply looks
/// inert. A classic script in the same document runs normally. Since a plugin already
/// has to ship as one bundled file, module semantics buy nothing here, and targeting
/// IIFE is a standard bundler configuration.
///
/// So the contract for a plugin's entry file is: a classic script that assigns its
/// exports onto `window.julide`. `docs/PLUGIN_API_V2.md` is the author-facing version.
const BOOTSTRAP_JS: &str = include_str!("../assets/plugin-bootstrap.js");

/// What a request resolved to.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// The hidden frame that runs `activate`.
    Background { plugin: String },
    /// A frame rendering one declared view.
    View { plugin: String, view: String },
    /// A static asset from the plugin's own directory.
    File { plugin: String, rel: String },
}

/// Parse a decoded request path into a route.
///
/// Every segment is validated here rather than at the point of use, so a traversal
/// attempt is refused before anything touches the filesystem.
pub fn parse_route(path: &str) -> Option<Route> {
    let mut parts = path.trim_matches('/').splitn(3, '/');
    let plugin = parts.next()?.to_string();
    if validate_plugin_name(&plugin).is_err() {
        return None;
    }
    match parts.next()? {
        "background" => {
            if parts.next().is_some() {
                return None;
            }
            Some(Route::Background { plugin })
        }
        "view" => {
            let view = parts.next()?;
            if view.is_empty() || validate_plugin_name(view).is_err() {
                return None;
            }
            Some(Route::View {
                plugin,
                view: view.to_string(),
            })
        }
        "file" => {
            let rel = parts.next()?;
            if rel.is_empty() {
                return None;
            }
            Some(Route::File {
                plugin,
                rel: rel.to_string(),
            })
        }
        _ => None,
    }
}

/// The frame's CSP, built per plugin.
///
/// `'self'` deliberately never appears: it resolves against the protected resource's
/// own origin, and an opaque origin is same-origin with nothing, so `'self'` would match
/// no script, style or image. Everything that needs to name this scheme names it
/// explicitly.
pub fn frame_csp(self_src: &str, nonce: &str, network: &[String], app_origin: &str) -> String {
    // `connect-src 'none'` is the default. A plugin reaches the network only by
    // declaring hosts in its manifest, which the user sees at the consent prompt.
    let connect = if network.is_empty() {
        "'none'".to_string()
    } else {
        network.join(" ")
    };
    format!(
        "default-src 'none'; \
         script-src 'nonce-{nonce}'; \
         style-src 'nonce-{nonce}' 'unsafe-inline'; \
         img-src {self_src} data: blob:; \
         font-src {self_src} data:; \
         media-src {self_src} blob:; \
         connect-src {connect}; \
         frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; \
         base-uri 'none'; form-action 'none'; \
         frame-ancestors {app_origin}; \
         sandbox allow-scripts"
    )
}

/// How this scheme names itself in a CSP source list.
///
/// Windows and Android serve custom schemes over `http(s)://<scheme>.localhost`; every
/// other platform uses the scheme directly. Same formula Tauri's isolation pattern uses.
pub fn self_source(scheme: &str, use_https: bool) -> String {
    if cfg!(any(windows, target_os = "android")) {
        let proto = if use_https { "https" } else { "http" };
        format!("{proto}://{scheme}.localhost")
    } else {
        format!("{scheme}:")
    }
}

/// Neutralise `</script` in plugin source before inlining it into the document.
///
/// The HTML parser ends a script element at the first `</script`, inside string
/// literals and comments included. Escaping the slash is always safe: `<\/` is not
/// valid JavaScript outside a string, and inside one it means exactly `</`.
pub fn escape_for_inline_script(source: &str) -> String {
    source.replace("</script", "<\\/script")
}

/// Only the origins julIDE's own `parseNetworkOrigins` would have accepted.
///
/// Re-validated here rather than trusted, because this is where the directive is
/// actually built. The frontend's copy exists to show the user what was accepted; this
/// one exists to make it true.
fn sanitize_network(raw: &[String]) -> Vec<String> {
    raw.iter()
        .filter_map(|entry| {
            let url = url::Url::parse(entry.trim()).ok()?;
            if !url.username().is_empty() || url.password().is_some() {
                return None;
            }
            let host = url.host_str()?;
            let loopback =
                host == "localhost" || host == "127.0.0.1" || host.ends_with(".localhost");
            if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
                return None;
            }
            if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
                return None;
            }
            if entry.contains('*') {
                return None;
            }
            Some(url.origin().ascii_serialization())
        })
        .take(16)
        .collect()
}

/// The document served for a background or view frame.
///
/// Pure, so the CSP and the escaping can be asserted in tests without a webview.
pub fn frame_document(
    manifest: &PluginManifest,
    entry_source: &str,
    role: &str,
    view_id: Option<&str>,
    nonce: &str,
    app_origin: &str,
) -> (String, String) {
    let csp = frame_csp(
        &self_source("julide-plugin", false),
        nonce,
        &sanitize_network(&manifest.network),
        app_origin,
    );

    let view_attr = view_id.unwrap_or("");
    let bootstrap = escape_for_inline_script(BOOTSTRAP_JS);
    let plugin_source = escape_for_inline_script(entry_source);

    let html = format!(
        r#"<!doctype html>
<html><head><meta charset="utf-8"><title>{title}</title></head>
<body>
<script nonce="{nonce}">
window.__JULIDE_FRAME__ = {{
  pluginId: {plugin:?},
  role: {role:?},
  viewId: {view_attr:?},
  frameId: new URLSearchParams(location.search).get("frame"),
}};
{bootstrap}
</script>
<script nonce="{nonce}">
{plugin_source}
</script>
</body></html>"#,
        title = html_escape(&manifest.display_name),
        plugin = manifest.name,
    );

    (csp, html)
}

/// Minimal escaping for the one manifest string that reaches markup.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn plugins_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".julide").join("plugins")
}

/// Read a file from inside a plugin's directory, refusing anything that escapes it.
///
/// Canonicalize both ends and require the
/// result to still be under the plugin root, so a symlink planted in the plugin
/// directory cannot be followed out of it.
fn read_confined(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let candidate = root.join(rel);
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical = candidate.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("path escapes the plugin directory".into());
    }
    std::fs::read(&canonical).map_err(|e| e.to_string())
}

fn content_type_for(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "json" => "application/json; charset=utf-8",
        // Deliberately not `text/javascript`: assets are not scripts here, and the
        // frame's CSP would refuse to run one anyway.
        _ => "application/octet-stream",
    }
}

fn not_found() -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::NOT_FOUND)
        .header(tauri::http::header::CONTENT_TYPE, "text/plain")
        .body(b"not found".to_vec())
        .unwrap()
}

/// Serve a plugin frame or one of its assets.
pub fn handle_request(
    request: &tauri::http::Request<Vec<u8>>,
    app_origin: &str,
) -> tauri::http::Response<Vec<u8>> {
    // Tauri percent-encodes the whole path when building custom-scheme URLs, so the
    // separators arrive as %2F and have to be decoded before routing.
    let raw = request.uri().path().trim_start_matches('/');
    let decoded = percent_encoding::percent_decode_str(raw)
        .decode_utf8_lossy()
        .into_owned();

    let route = match parse_route(&decoded) {
        Some(r) => r,
        None => return not_found(),
    };

    let root = plugins_dir().join(route_plugin(&route));

    if let Route::File { rel, .. } = &route {
        return match read_confined(&root, rel) {
            Ok(bytes) => tauri::http::Response::builder()
                .status(tauri::http::StatusCode::OK)
                .header(tauri::http::header::CONTENT_TYPE, content_type_for(rel))
                .body(bytes)
                .unwrap(),
            Err(_) => not_found(),
        };
    }

    let manifest: PluginManifest = match std::fs::read_to_string(root.join("plugin.json"))
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
    {
        Some(m) => m,
        None => return not_found(),
    };

    // A v1 plugin is never served: its code expects a live DOM node and a synchronous
    // context, neither of which exists here. The frontend refuses it earlier with a
    // migration message; this is the backstop.
    if manifest.api_version != 2 {
        return not_found();
    }

    let entry = match read_confined(&root, &manifest.main) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(s) => s,
            Err(_) => return not_found(),
        },
        Err(_) => return not_found(),
    };

    let (role, view_id) = match &route {
        Route::View { view, .. } => ("view", Some(view.as_str())),
        _ => ("background", None),
    };

    let nonce = random_nonce();
    let (csp, html) = frame_document(&manifest, &entry, role, view_id, &nonce, app_origin);

    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(
            tauri::http::header::CONTENT_TYPE,
            "text/html; charset=utf-8",
        )
        .header("Content-Security-Policy", csp)
        .body(html.into_bytes())
        .unwrap()
}

fn route_plugin(route: &Route) -> &str {
    match route {
        Route::Background { plugin } | Route::View { plugin, .. } | Route::File { plugin, .. } => {
            plugin
        }
    }
}

/// 128 bits from the same generator the rest of the app already uses for ids.
fn random_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(network: Vec<String>) -> PluginManifest {
        PluginManifest {
            name: "my-plugin".into(),
            version: "1.0.0".into(),
            display_name: "My Plugin".into(),
            description: None,
            author: None,
            main: "dist/index.js".into(),
            api_version: 2,
            activation_events: vec![],
            permissions: vec![],
            network,
            contributes: None,
        }
    }

    // ── CSP ────────────────────────────────────────────────────────────────

    #[test]
    fn csp_denies_everything_by_default() {
        let csp = frame_csp("julide-plugin:", "abc123", &[], "tauri://localhost");
        assert!(csp.starts_with("default-src 'none'"));
        assert!(csp.contains("connect-src 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(csp.contains("base-uri 'none'"));
        assert!(csp.contains("frame-src 'none'"));
    }

    #[test]
    fn csp_never_grants_eval_or_unsafe_inline_script() {
        let csp = frame_csp("julide-plugin:", "abc123", &[], "tauri://localhost");
        assert!(!csp.contains("'unsafe-eval'"));
        // style-src carries 'unsafe-inline' deliberately; script-src must not.
        let script_src = csp
            .split("; ")
            .find(|d| d.trim_start().starts_with("script-src"))
            .expect("script-src present");
        assert!(!script_src.contains("'unsafe-inline'"), "got: {script_src}");
        assert!(script_src.contains("'nonce-abc123'"));
    }

    #[test]
    fn csp_never_uses_self_which_would_match_nothing_in_an_opaque_origin() {
        let csp = frame_csp("julide-plugin:", "abc123", &[], "tauri://localhost");
        assert!(!csp.contains("'self'"), "got: {csp}");
    }

    #[test]
    fn csp_repeats_the_sandbox_directive() {
        // Belt and braces for the day someone edits the <iframe> and drops the
        // attribute. The two intersect and say the same thing.
        let csp = frame_csp("julide-plugin:", "n", &[], "tauri://localhost");
        assert!(csp.contains("sandbox allow-scripts"));
    }

    // ── network sanitisation ───────────────────────────────────────────────

    #[test]
    fn declared_network_hosts_become_connect_src() {
        let m = manifest(vec!["https://api.github.com".into()]);
        let (csp, _) = frame_document(&m, "", "background", None, "n", "tauri://localhost");
        assert!(csp.contains("connect-src https://api.github.com"));
    }

    #[test]
    fn the_rust_side_re_validates_rather_than_trusting_the_manifest() {
        // The frontend shows the user what it accepted; this is where the directive is
        // actually built, so it must not accept anything wider.
        let hostile = vec![
            "https://*.evil.com".into(),
            "https:".into(),
            "http://evil.com".into(),
            "https://user:pw@evil.com".into(),
            "https://evil.com/path".into(),
            "data:text/html,x".into(),
            "javascript:alert(1)".into(),
        ];
        let m = manifest(hostile);
        let (csp, _) = frame_document(&m, "", "background", None, "n", "tauri://localhost");
        assert!(csp.contains("connect-src 'none'"), "got: {csp}");
    }

    #[test]
    fn loopback_http_is_allowed_for_local_services() {
        let m = manifest(vec!["http://localhost:8080".into()]);
        let (csp, _) = frame_document(&m, "", "background", None, "n", "tauri://localhost");
        assert!(
            csp.contains("connect-src http://localhost:8080"),
            "got: {csp}"
        );
    }

    // ── inlining ───────────────────────────────────────────────────────────

    #[test]
    fn script_close_tag_in_plugin_source_cannot_end_the_element() {
        let hostile = r#"const s = "</script><script>alert(1)</script>";"#;
        let escaped = escape_for_inline_script(hostile);
        assert!(!escaped.contains("</script"));
        assert!(escaped.contains("<\\/script"));
    }

    #[test]
    fn a_hostile_entry_file_cannot_break_out_of_the_document() {
        let m = manifest(vec![]);
        let hostile = r#"</script><script>window.__TAURI_INTERNALS__.invoke("x")</script>"#;
        let (_, html) = frame_document(&m, hostile, "background", None, "n", "tauri://localhost");

        // Only `</script` ends a script element — a literal `<script>` inside script
        // content is inert text, so counting opening tags would be measuring the wrong
        // thing. What matters is that the element closes exactly where the handler
        // intended: twice, once for the bootstrap and once for the plugin module.
        assert_eq!(html.matches("</script>").count(), 2, "got: {html}");
        assert!(
            html.contains(r#"<\/script>"#),
            "the hostile close tag was not escaped"
        );
    }

    #[test]
    fn a_hostile_display_name_cannot_inject_markup() {
        let mut m = manifest(vec![]);
        m.display_name = r#"<img src=x onerror=alert(1)>"#.into();
        let (_, html) = frame_document(&m, "", "background", None, "n", "tauri://localhost");
        assert!(!html.contains("<img"), "got: {html}");
        assert!(html.contains("&lt;img"));
    }

    #[test]
    fn the_frame_is_told_which_role_it_is() {
        let m = manifest(vec![]);
        let (_, html) = frame_document(&m, "", "view", Some("log"), "n", "tauri://localhost");
        assert!(html.contains(r#"role: "view""#), "got: {html}");
        assert!(html.contains(r#"viewId: "log""#));
    }

    // ── routing ────────────────────────────────────────────────────────────

    #[test]
    fn routes_parse() {
        assert_eq!(
            parse_route("my-plugin/background"),
            Some(Route::Background {
                plugin: "my-plugin".into()
            })
        );
        assert_eq!(
            parse_route("my-plugin/view/log"),
            Some(Route::View {
                plugin: "my-plugin".into(),
                view: "log".into()
            })
        );
        assert_eq!(
            parse_route("my-plugin/file/dist/style.css"),
            Some(Route::File {
                plugin: "my-plugin".into(),
                rel: "dist/style.css".into()
            })
        );
    }

    #[test]
    fn a_traversing_plugin_name_does_not_route() {
        // The name is joined into a path under ~/.julide/plugins, so this is the same
        // check the plugin directory name must satisfy — one implementation rather than
        // writing a second that can drift.
        // `parse_route` sees the decoded path, so these are the forms it can actually
        // receive. The encoded case is covered by the handler test below.
        for path in [
            "../../../etc/background",
            "../background",
            "/background",
            "a/b/background",
            "my plugin\n/background",
        ] {
            assert!(parse_route(path).is_none(), "{path}");
        }
    }

    #[test]
    fn the_handler_decodes_before_routing() {
        // Tauri percent-encodes the whole path when building these URLs, so `%2F`
        // arrives where a separator was meant. Routing on the raw string would treat
        // `..%2F..%2Fetc` as one innocent-looking component and let it through.
        let request = tauri::http::Request::builder()
            .uri("julide-plugin://localhost/..%2F..%2Fetc%2Fbackground")
            .body(Vec::new())
            .unwrap();
        let response = handle_request(&request, "tauri://localhost");
        assert_eq!(response.status(), tauri::http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn the_handler_refuses_a_plugin_that_does_not_exist() {
        let request = tauri::http::Request::builder()
            .uri("julide-plugin://localhost/no-such-plugin%2Fbackground")
            .body(Vec::new())
            .unwrap();
        assert_eq!(
            handle_request(&request, "tauri://localhost").status(),
            tauri::http::StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn a_traversing_view_id_does_not_route() {
        assert!(parse_route("my-plugin/view/..").is_none());
        assert!(parse_route("my-plugin/view/").is_none());
    }

    #[test]
    fn an_unknown_role_does_not_route() {
        assert!(parse_route("my-plugin/exec").is_none());
        assert!(parse_route("my-plugin").is_none());
        assert!(parse_route("").is_none());
    }

    #[test]
    fn a_background_route_takes_no_extra_segments() {
        assert!(parse_route("my-plugin/background/extra").is_none());
    }

    // ── asset confinement ──────────────────────────────────────────────────

    #[test]
    fn file_reads_are_confined_to_the_plugin_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("my-plugin");
        std::fs::create_dir_all(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/style.css"), "body{}").unwrap();
        std::fs::write(tmp.path().join("outside.txt"), "secret").unwrap();

        assert!(read_confined(&root, "dist/style.css").is_ok());
        assert!(read_confined(&root, "../outside.txt").is_err());
        assert!(read_confined(&root, "/etc/passwd").is_err());
    }

    #[test]
    fn a_symlink_out_of_the_plugin_directory_is_refused() {
        // Canonicalising both ends is what catches this; a string prefix check on the
        // un-resolved path would not.
        #[cfg(unix)]
        {
            let tmp = tempfile::tempdir().unwrap();
            let root = tmp.path().join("my-plugin");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(tmp.path().join("secret.txt"), "secret").unwrap();
            std::os::unix::fs::symlink(tmp.path().join("secret.txt"), root.join("link.txt"))
                .unwrap();

            assert!(read_confined(&root, "link.txt").is_err());
        }
    }

    #[test]
    fn assets_are_never_served_as_javascript() {
        // The frame's CSP would refuse to run one anyway, but a script content type on
        // an attacker-supplied file is not something to hand out.
        assert_eq!(content_type_for("x.js"), "application/octet-stream");
        assert_eq!(content_type_for("x.html"), "application/octet-stream");
        assert_eq!(content_type_for("x.css"), "text/css; charset=utf-8");
    }
}
