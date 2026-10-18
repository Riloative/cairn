# Progress log

## 2026-10-18 — Session 1: project setup and M0 scaffolding

- Added `docs/SPEC.md` (verbatim spec), `ROADMAP.md`, `CLAUDE.md`, `docs/DECISIONS.md`.
- Cargo workspace with all seven `crates/*` plus `src-tauri`; each crate has a tested
  seed type (see D-008). 24 Rust tests pass; clippy clean with `-D warnings`.
- Tauri 2 app with strict CSP, minimal capabilities, typed `app_info` command, app icon.
- React 19 + TS 6 + Vite 8 + Tailwind 4 + Radix frontend in `ui/` with design tokens,
  bundled Inter / JetBrains Mono (OFL licenses in `ui/public/licenses/`), Vitest + RTL.
- ESLint, Prettier, rustfmt, clippy configured. `deny.toml` for cargo-deny.
- CI (`.github/workflows/ci.yml`): frontend checks + npm audit, Rust fmt/clippy/test on
  ubuntu-24.04 and macos-14, cargo deny + cargo audit, `.deb` bundle with an Xvfb
  screenshot artifact, `.dmg` bundle for `aarch64-apple-darwin`.
- Release workflow on `v*` tags.
- Verified locally: `.deb` builds; the release binary launches under Xvfb and renders the
  shell with bundled fonts through the strict CSP.

**M0 complete:** CI run 2 green on ubuntu-24.04 and macos-14 with `.deb` and `.dmg`
artifacts.

### M1 (same session)

- `cairn-core`: Argon2id KDF with calibration, SQLCipher DB with migrations, vault
  (setup/unlock/lock/change password, crash-safe rekey, failed-attempt sidecar),
  hash-chained append-only audit log with tamper tests, typed settings with audited
  diffs, `SecretString` (zeroize). 43 Rust tests in core.
- `src-tauri`: vault/settings/audit commands, `CommandError` payloads, auto-lock task
  (idle + sleep detection by clock drift).
- Frontend: 6 themes + follow system (WCAG contrast tests), Radix primitives, shell with
  sidebar/tab bar, command palette, action + shortcut registry, toasts, notification
  center, setup/lock screens with zxcvbn strength meter, Settings (appearance, security,
  shortcuts, about), basic Audit view with integrity verification. 114 Vitest tests.
- `scripts/ui-smoke.sh`: drives the real release build under Xvfb with xdotool through
  setup → palette → every theme → lock → wrong password → unlock → audit, and uploads
  screenshots as a CI artifact.

**Next:** M2 — xterm.js over binary channels, local shells, profiles/palettes, full SSH.
