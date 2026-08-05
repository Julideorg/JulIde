# Security Policy

## Supported versions

julIDE is pre-1.0. Only the latest release receives security fixes.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | Yes                |
| Anything older | No — please update |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[security advisory form](https://github.com/sinisterMage/julide/security/advisories/new),
or by email to the address on the maintainer's GitHub profile.

Please include:

- what the issue is and roughly how severe you think it is,
- steps to reproduce, or a proof of concept,
- the julIDE version, your OS, and how you installed it (AppImage, `.deb`, `.rpm`, `.msi`, `.dmg`, source).

You can expect an acknowledgement within a week. Once a fix ships, you will be
credited in the release notes unless you would rather not be.

## What julIDE handles that is worth knowing about

Understanding the trust model helps when judging whether something is a bug:

- **Julia code you run is not sandboxed.** Running a script, evaluating a cell, or
  typing in the REPL executes with your full user privileges. That is what an IDE is
  for; it is not a vulnerability.
- **Git access tokens** are stored in the OS keychain (Keychain on macOS, Credential
  Manager on Windows, Secret Service on Linux) — never in `settings.json`. API calls
  to self-hosted Git providers are forced to `https` for any non-loopback host, so a
  repository with a hostile `origin` cannot cause a token to be sent in cleartext.
- **Plugins** in `~/.julide/plugins/` are unsigned third-party code running inside the
  app. They must declare the permissions they need, and the user approves them
  explicitly; approvals are bound to a fingerprint of the plugin manifest. Anything a
  plugin can reach _without_ an approved permission is a bug worth reporting.
- **Dev containers** may declare an `initializeCommand`, which the devcontainer spec
  runs on the host. julIDE prompts for workspace trust and shows the exact commands
  before running any of them. A path that skips that prompt is a bug worth reporting.
- **The webview** loads no remote code: Monaco is bundled locally, and a
  Content-Security-Policy restricts `script-src` to `'self'`. Any way to get remote or
  injected script executing in the webview is a serious bug — it holds the IPC bridge.
- **Updates** are verified against a signing key held by the maintainer. julIDE
  binaries themselves are not currently OS code-signed, so Windows SmartScreen and
  macOS Gatekeeper will warn on first launch. That is expected, not a compromise.

## Out of scope

- Vulnerabilities in Julia itself or in Julia packages — report those upstream.
- Anything requiring an attacker to already have local code execution as your user.
- Missing OS code signing (known and documented).
