## What does this change?

<!-- A sentence or two. Link the issue it addresses, if there is one. -->

## How was it tested?

<!-- What you actually ran or clicked through. "Ran the test suite" is fine if that
     genuinely covers it; if the change is UI-facing, say what you exercised by hand. -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes
- [ ] `bun run format:check` passes
- [ ] `bun test` passes
- [ ] `cargo test` passes (if Rust changed)
- [ ] `cargo clippy --all-targets -- -D warnings` passes (if Rust changed)
- [ ] `cargo fmt --all --check` passes (if Rust changed)
- [ ] Added or updated tests for the behaviour this changes
- [ ] Updated `CHANGELOG.md` under Unreleased, if this is user-visible
