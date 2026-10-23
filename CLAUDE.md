# CLAUDE.md — Cairn

**Before starting work, read CLAUDE.md, ROADMAP.md and docs/SPEC.md; work on the first unchecked milestone; update ROADMAP.md checkboxes and add a short entry to docs/PROGRESS.md at the end of every session.**

Record every non-obvious technical decision in `docs/DECISIONS.md`.

## What Cairn is

A local-only desktop SSH / Serial / Telnet / RDP client with a network infrastructure
inventory and map, for a single network engineer. Targets: macOS (Apple Silicon only)
and Ubuntu 24.04+. Full spec: `docs/SPEC.md`.

## Architecture

- **Tauri 2** shell. Rust backend, React + TypeScript + Vite frontend.
- All domain logic lives in UI-free Rust crates under `crates/`. `src-tauri` is a thin
  layer: it validates IPC input, calls into the crates, and maps errors to
  user-friendly messages.
- Terminal and RDP data flow over **Tauri v2 Channels with binary payloads**
  (`tauri::ipc::Response` / `InvokeResponseBody::Raw`), never JSON byte arrays.
- Persistent data: SQLite + SQLCipher (`rusqlite`), key derived with Argon2id from the
  master password. Secrets never leave Rust.

## Layout

```
crates/
  core/          models, database, vault, audit, settings (no UI deps)
  proto-ssh/     SSH (russh, russh-sftp), host keys, algorithms
  proto-serial/  serial ports, line settings, X/Ymodem
  proto-telnet/  telnet IAC/option negotiation, NAWS
  proto-rdp/     IronRDP session: connect, certificate pin, frames, input, clipboard
  pty/           local shell sessions (pseudo-terminals), container discovery
  tftp/          TFTP server
  export/        SVG→PDF, CSV/JSON export, backups
src-tauri/       Tauri app: commands, events, capabilities, bundling config
ui/              React frontend (Vite root)
  src/app/       app shell, routing between views
  src/components/ui/  design-system primitives (Radix-based)
  src/styles/    tokens.css (design tokens), themes, fonts
  src/lib/       IPC wrappers (typed), theme, shortcuts, action registry
  src/stores/    Zustand stores (vault, settings, sessions, notifications, ui)
  src/screens/   setup and lock screens
  src/views/     main-area views (sessions, audit, settings, …)
  src/terminal/  terminal pane (xterm.js), controls, palettes, paste/privilege guards
  src/ssh/       SSH connection fields, host-key and credential prompts, quick connect
  src/connect/   connect dialog, serial/telnet/RDP fields, saved connections
  src/rdp/       RDP pane, frame decoding, input, certificate prompt
  src/map/       network map model, geometry/routing, rack elevation, SVG export
  src/recordings/  session recordings list and asciicast player
  src/backup/    backup, restore and data export dialogs
  src/test/      test setup and FakeBackend (mockIPC stand-in for src-tauri)
  public/licenses/  OFL texts for the fonts (bundled via @fontsource-variable, D-004)
vendor/         ironrdp-connector patched for dependency resolution (D-039)
docs/            SPEC.md, DECISIONS.md, PROGRESS.md
.github/workflows/  ci.yml, release.yml
```

## Commands

Run from the repo root.

| Task | Command |
|---|---|
| **Everything CI checks** | `scripts/check.sh` |
| Install JS deps | `npm ci` |
| Dev app | `npm run tauri dev` |
| Frontend only | `npm run dev` |
| Build bundles | `npm run tauri build` (Linux: `-- --bundles deb`; macOS: `-- --target aarch64-apple-darwin --bundles dmg`) |
| Rust format | `cargo fmt --all` (check: `cargo fmt --all -- --check`) |
| Rust lint | `cargo clippy --workspace --all-targets -- -D warnings` |
| Rust tests | `cargo test --workspace` |
| Supply chain | `cargo deny check`, `cargo audit`, `npm audit --audit-level=high` |
| Frontend lint | `npm run lint` |
| Frontend format | `npm run format` (check: `npm run format:check`) |
| Typecheck | `npm run typecheck` |
| Frontend tests | `npm test` |
| SSH integration tests (Linux, root) | `sudo scripts/test-sshd.sh && source /tmp/cairn-sshd/env && CAIRN_SSH_TESTS=1 cargo test -p cairn-proto-ssh` |
| Telnet integration tests (Linux, root; inetutils-telnetd + socat) | `sudo scripts/test-telnetd.sh 2323 && CAIRN_TELNET_PORT=2323 cargo test -p cairn-proto-telnet` |
| RDP integration tests (Linux, root; xrdp + xorgxrdp) | `sudo scripts/test-xrdp.sh && source /tmp/cairn-xrdp/env && CAIRN_RDP_TESTS=1 cargo test -p cairn-proto-rdp` |
| Demo data (map, inventory) | `echo "<password>" \| cargo run -p cairn-core --example seed_demo -- <vault dir>` |
| UI smoke test (Linux, needs Xvfb + xdotool) | `npm run tauri build -- --bundles deb && scripts/ui-smoke.sh target/release/cairn screenshots` |
| WebDriver e2e smoke (Linux: `apt install webkit2gtk-driver`, `cargo install tauri-driver`) | `xvfb-run -a node e2e/smoke.mjs target/release/cairn screenshots/e2e` |
| Scale data + read timings | `echo "<password>" \| cargo run --release -p cairn-core --example seed_scale -- <vault dir>` |

Linux build deps: `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev libudev-dev libssl-dev pkg-config build-essential patchelf`.

## Coding conventions

- Read existing code before changing it. Small functions, focused modules.
- Rust: edition 2021, `thiserror` for typed errors in every crate; every error maps to a
  human-readable, actionable message (`UserMessage` trait / `to_user_message`). No
  `unwrap()`/`expect()` outside tests except on proven invariants (comment why).
- Clippy must be clean with `-D warnings`. rustfmt default style.
- Public crate APIs are unit-tested. Integration tests against real local servers go in
  `crates/*/tests/`.
- TypeScript: `strict`, no `any`. IPC calls go only through typed wrappers in
  `ui/src/lib/ipc.ts`. State in Zustand stores (`ui/src/stores`).
- Styling only via design tokens (CSS variables in `ui/src/styles/tokens.css`) exposed
  through Tailwind theme names. No raw hex colors in components. 8 px spacing grid.
- Transitions 120–200 ms; skeletons instead of spinners; empty states with one CTA.
- Every user command is an `Action` in the registry (`ui/src/lib/actions.ts`); the
  palette, global shortcuts and the Settings shortcut list all read from it.
- New IPC commands: add to `src-tauri/src/commands`, register in `lib.rs`, add a typed
  wrapper in `ui/src/lib/ipc.ts` and a case in `ui/src/test/fakeBackend.ts`.
- Schema changes: append a new `crates/core/src/migrations/NNNN_*.sql`; never edit a
  released migration.
- Do not leave stubs/TODOs in a milestone marked complete.
- Do not put model identifiers in commits, PRs or code.

## Security rules (non-negotiable, from SPEC §9)

- **Master password** required on first launch and to unlock. Argon2id (~0.5–1 s) derives
  the SQLCipher key. Auto-lock after idle (default 15 min) and on system sleep. Strength
  indicator on setup; warn that a lost master password means lost data; offer an
  encrypted backup right after setup.
- **Secrets stay in Rust:** credentials, keys and passphrases live only in the encrypted
  vault and in Rust memory wrapped in `zeroize` types. They never reach the frontend.
  The frontend references credentials by ID and shows masked values; explicit reveal is
  audited. Clipboard copies of passwords are cleared after 30 s.
- **Tauri hardening:** strict CSP, no remote content, minimal capabilities per window.
  All IPC commands are typed and validated. Nothing from the network is rendered as
  HTML; terminal web links open only on explicit click.
- **Logs never contain secrets.** Input typed after a detected password prompt is
  redacted in audit/transcripts; raw output is kept.
- **Supply chain:** `cargo audit`, `cargo deny`, `npm audit` run in CI.
- **Fully local:** no telemetry, no network calls except user-initiated connections.
