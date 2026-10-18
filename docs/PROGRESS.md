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

**Next:** confirm CI green on both platforms (last M0 box), then M1 (vault, SQLCipher,
audit chain, settings, themes, shell, command palette, notifications).
