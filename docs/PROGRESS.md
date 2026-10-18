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

### M2 (same session)

- Terminal: xterm.js 6 (WebGL, fit, search, unicode11, web-links, serialize, image) over
  raw binary Tauri channels; local shells via new `crates/pty`; Podman/Toolbox/Distrobox
  quick-launch; terminal registry keeps scrollback across tab/view switches.
- Profiles (font, size, line height, cursor, scrollback 10k, palette, opacity, bell,
  copy-on-select, paste delay, shell), 20 bundled MIT palettes, import from iTerm2,
  Ghostty, Windows Terminal and Alacritty with live preview.
- SSH (`proto-ssh` on russh 0.64 with `ring`): password, keys (ed25519/ECDSA/RSA, encrypted),
  keyboard-interactive, agent + opt-in forwarding; TOFU and changed-key warning with
  Cairn's own known-hosts store (+ optional ~/.ssh/known_hosts); legacy algorithms
  (dh-group1/14/gex-sha1, ssh-rsa, aes-cbc, 3des-cbc, hmac-sha1); jump-host chains;
  SOCKS5/HTTP proxies; keepalive; auto-reconnect with backoff; 16 integration tests
  against real modern + legacy-only OpenSSH servers in Linux CI.
- Keyword highlighting overlay (decorations; byte stream untouched) with vendor rule
  sets and an editor; context-colored header with privileged-prompt detection;
  scrollback search; paste safety; copy/paste shortcuts; bell; session overview;
  disconnect + OSC 133 long-command notifications; session logging with timestamps.
- Fixes found by driving the real app under Xvfb: xterm.js 6 breaks with Tauri's
  `freezePrototype` (D-017); the image addon needs `wasm-unsafe-eval` (D-018); dialog
  focus handling; connect timeout no longer counts time spent in prompts.
- CI: Rust toolchain pinned to 1.99.1 (D-020); RUSTSEC-2023-0071 accepted with
  justification (D-019).

**Next:** confirm CI green for M2, then M3 (serial with hotplug, BREAK, X/Ymodem; Telnet
with reverse Telnet to console servers).

**Test manually:** on macOS and Ubuntu, connect to a real switch with legacy
algorithms; check Cmd/Ctrl+Shift+C/V, the changed-host-key warning (edit the key in
Settings → Security → Known hosts by forgetting it and re-keying a lab device), desktop
notifications (permission prompt on first disconnect), and WebGL rendering on your GPU.
