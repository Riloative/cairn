# Cairn Roadmap

Source of truth: [docs/SPEC.md](docs/SPEC.md). Work on the first unchecked milestone.
A milestone is checked only when every task is done, all tests pass, CI is green on
both platforms, and there are no stubs/TODOs left inside it.

## M0 – Scaffolding ✅

- [x] `docs/SPEC.md`, `ROADMAP.md`, `CLAUDE.md`, `docs/DECISIONS.md`, `docs/PROGRESS.md`
- [x] Cargo workspace with `crates/{core,proto-ssh,proto-serial,proto-telnet,proto-rdp,tftp,export}` and `src-tauri`
- [x] Each crate compiles with a minimal, tested public surface (no UI deps)
- [x] Tauri 2 app (`src-tauri`) with strict CSP, minimal capabilities, typed `app_info` command
- [x] Frontend: React + TypeScript + Vite + Tailwind + Radix in `ui/`
- [x] Bundled Inter + JetBrains Mono with OFL licenses
- [x] Design-token CSS variables (base theme) and a minimal app shell placeholder
- [x] Lint/format: rustfmt, clippy (`-D warnings`), eslint, prettier, `tsc --noEmit`
- [x] Vitest + React Testing Library set up with a first test
- [x] `deny.toml` for `cargo deny`; `cargo audit` and `npm audit` in CI
- [x] CI workflow: lint + test on ubuntu-24.04 and macos-14
- [x] CI builds unsigned `.deb` (ubuntu-24.04) and `.dmg` (macos-14, `aarch64-apple-darwin`) as artifacts
- [x] Release workflow on `v*` tags attaching the bundles to a GitHub Release
- [x] CI verified green on both platforms (run 2: lint/test on ubuntu-24.04 + macos-14, `.deb` + `.dmg` artifacts)

## M1 – Core and shell ✅

- [x] `core::kdf`: Argon2id (64 MiB, calibrated to ~0.7 s), random salt, params in `vault.json`; `zeroize` secrets
- [x] SQLCipher database (`rusqlite` + `bundled-sqlcipher-vendored-openssl`), raw-key mode, versioned migrations
- [x] Master password setup / unlock / lock / change (crash-safe rekey); failed attempts audited; idle auto-lock (default 15 min) and lock on system sleep
- [x] Password strength meter on setup (zxcvbn-ts, lazy-loaded) + "no recovery" acknowledgment
- [x] Audit core: append-only table (UPDATE/DELETE triggers), SHA-256 hash chain, `verify`, typed event enum
- [x] Settings store (typed, serde defaults, validated, field-level diff audited)
- [x] Typed errors (`CoreError` → `ErrorPayload {code, message, hint}`) across IPC
- [x] Design system: tokens (color, radius, 8px spacing, shadow, motion), 3 dark + 3 light themes + follow system, WCAG contrast tests
- [x] Primitives: Button, Input, Field, Dialog, Sheet, Tooltip, DropdownMenu, ContextMenu, Tabs, Switch, Popover, Toast, Skeleton, EmptyState, Kbd/Shortcut
- [x] App shell: collapsible sidebar (Sessions, Inventory, Map, Audit, Settings + open sessions), top session tabs with protocol dot + state
- [x] Command palette (Cmd/Ctrl+K) backed by the action registry
- [x] Toasts + notification center
- [x] Shortcut registry, listed in Settings → Shortcuts
- [x] Tests: Rust (vault, db, migrations, audit tamper detection, settings, autolock) and Vitest (stores, actions, components, full UI flows on a mocked IPC); Xvfb UI smoke test against the real backend in CI
- [x] CI green on both platforms for M1

## M2 – Terminal and SSH ✅

- [x] CI green on both platforms for the final M2 commit (run 12)

- [x] xterm.js (WebGL, fit, search, unicode11, web-links, serialize, image) over binary Tauri Channels
- [x] Session manager in Rust (session IDs, lifecycle events; raw-body input, raw-channel output)
- [x] Local shell tabs (`portable-pty`, new `crates/pty`); Linux Podman/Toolbox/Distrobox quick-launch
- [x] Terminal profile model + validated storage (font, size, line height, cursor, scrollback 10k, palette, opacity, bell, copy-on-select, paste delay, shell)
- [x] Profile behaviors: bell (visual/sound), copy-on-select
- [x] ≥15 bundled palettes with attribution (20, MIT; `ui/public/licenses/terminal-palettes.txt`)
- [x] Palette import: iTerm2/Ghostty/Windows Terminal/Alacritty with live preview
- [x] SSH: password, pubkey (ed25519/ECDSA/RSA, encrypted), keyboard-interactive, agent; agent forwarding toggle
- [x] Host keys: own known-hosts store, TOFU with fingerprint, changed-key full-screen warning ("accept"), optional `~/.ssh/known_hosts`
- [x] Legacy algorithms per connection (dh-group1/14/gex-sha1, ssh-rsa, aes-cbc, 3des-cbc, hmac-sha1) + warning badge in the connect dialog (per-device badge lands with inventory in M4)
- [x] Jump host chains, SOCKS5/HTTP proxy
- [x] Keepalive, auto-reconnect with backoff, reconnect overlay
- [x] Quick-connect dialog (`Mod+N`), host-key and credential prompts, known-hosts manager in Settings
- [x] Session logging with timestamps (raw output, per-line timestamps, opt-in in Settings → Security)
- [x] Keyword highlighting overlay engine (xterm decorations; byte stream untouched) + vendor rule sets (IOS/IOS-XE/NX-OS, Junos, FortiOS, AOS-CX, ProCurve, Comware, UniFi/EdgeOS, Linux), per-tab vendor, validated custom sets in prefs
- [x] Highlighting rule editor in Settings
- [x] Scrollback search (regex/case/whole word, match count, `Mod+F`)
- [x] Paste safety dialog (line count + preview) + per-line delay; copy/paste shortcuts per platform
- [x] Tab overview grid with live thumbnails (`Mod+Shift+O`)
- [x] Context-colored header bar + privilege prompt regexes (defaults for Cisco/Aruba/HP `#`, Junos, Linux root, Comware)
- [x] Settings UI for terminal profiles, palettes and prompt patterns
- [x] Disconnect notifications (desktop, when the tab is in the background)
- [x] OSC 133 long-command notifications (threshold in Settings)
- [x] Integration tests against local openssh-server (modern + legacy config) — 16 tests in CI

## M3 – Serial and Telnet ✅

- [x] Serial port discovery + USB VID/PID friendly names; prefer `/dev/cu.*` on macOS (crate)
- [x] Hotplug events to the UI (live port list in the connect dialog)
- [x] Full line settings, live DTR/RTS, BREAK, local echo, newline mapping (crate)
- [x] Xmodem / Xmodem-1K / Ymodem send & receive with progress (crate; tested against lrzsz)
- [x] Permission problem detection with per-OS fixes
- [x] Serial UI: connect dialog, header controls (DTR/RTS/BREAK), transfer dialog with progress
- [x] Telnet: IAC/option negotiation (loop-safe), NAWS, terminal type, BREAK, raw TCP mode (crate)
- [x] Reverse Telnet port mapping for console servers (Opengear, Cisco lines, Avocent, Lantronix, Digi)
- [x] Telnet / console-server UI in the connect dialog
- [x] Unplug/replug and dropped Telnet sessions reconnect with backoff (D-022)
- [x] CI green on both platforms for M3 (run 16)
- [x] Integration tests: socat PTY pairs (incl. Xmodem/Ymodem vs lrzsz), real telnetd + scripted server

## M4 – Inventory ✅

- [x] Location hierarchy: Site → Building → Floor → Room → Rack (U height)
- [x] Devices with all fields, IP validation + duplicate warnings, connection methods
- [x] Interfaces + bulk create from patterns (`Gi1/0/1-48`, `xe-0/[0-1]/[0-3]`)
- [x] VLAN registry with colors
- [x] Credential profiles (secrets in vault only, reveal/copy audited, clipboard clear 30 s)
- [x] Custom fields (text, number, select, multi-select, date, URL, IP, boolean)
- [x] Inventory table: filter, group, sort, column chooser, saved views, full-text search
- [x] Side-sheet detail view, minimal forms with validation + keyboard nav
- [x] Duplicate device with interfaces
- [x] Field-level diff audit for inventory CRUD
- [x] Connect from inventory (resolved in Rust from the credential profile), auto login / enable
- [x] CI green on both platforms for M4 (run 18)

## M5 – Map ✅

- [x] Campus / Building / Floor / Rack views with breadcrumbs
- [x] Original SVG icon set for all device types, vendor badge
- [x] Interface-to-interface links (media, speed, VLANs, LAG, description)
- [x] Link labels toggles (per link + global), color by media/speed/VLAN
- [x] Orthogonal routing + parallel link bundling
- [x] Snap-to-grid, alignment guides, multi-select, zones, lock, undo/redo
- [x] ELK auto-layout (whole/selection)
- [x] Context menu, hover card, double-click connect, search/focus, mini-map
- [x] Floor plan backgrounds (PNG/JPG/SVG/PDF page) with scale/opacity
- [x] Rack elevation with collision-free drag
- [x] Export PNG (1x/2x/4x), SVG, PDF (Rust `svg2pdf`) with title/legend/date, theme or forced light
- [x] CI green on both platforms for M5 (run 21)

## M6 – Power tools

- [x] SFTP side panel (tree, DnD, rename/delete/mkdir/chmod, transfer queue) + SCP
- [x] Port forwarding manager (local/remote/dynamic, presets, live status)
- [x] TFTP server (root, bind, rw perms, transfer log, custom port + setcap/authbind docs)
- [x] Snippets library with variables, palette + snippet bar
- [x] Broadcast from tabs and map with banner
- [x] Grab config (vendor commands, paging) + snapshots + side-by-side diff + export
- [x] Audit integration for all of the above
- [x] CI green on both platforms for M6 (run 30)

## M7 – RDP

- [ ] IronRDP session, dirty-rect frames over binary channel to canvas
- [ ] Keyboard/mouse input incl. macOS key mapping
- [ ] NLA/CredSSP, TLS cert trust prompt
- [ ] Dynamic resize, fit/scaled, fullscreen, Ctrl+Alt+Del, text clipboard sync
- [ ] RDP profiles (resolution, color depth, gateway if feasible, SSH tunnel)
- [ ] External client fallback (FreeRDP on Linux, `.rdp` on macOS)
- [ ] xrdp integration test if feasible

## M8 – Audit and data

- [ ] Audit view: filters (time, device, event, protocol), verify integrity, CSV/JSON export, retention
- [ ] asciicast v2 recording (per device / global), replay player (seek, speed), transcript export
- [ ] Encrypted `.cairn-backup` full backup + restore
- [ ] Offer an encrypted backup right after first-run setup (moved here from M1, see D-012)
- [ ] JSON/CSV readable export (credentials opt-in with warning)

## M9 – Polish

- [ ] Performance: 300 devices, 30 sessions, 500-link map; cold start < 1.5 s
- [ ] Accessibility: focus rings, contrast checks in all themes
- [ ] Empty states, onboarding, keyboard shortcuts sheet
- [ ] tauri-driver e2e smoke tests under xvfb + screenshot artifacts
- [ ] README with install notes (macOS quarantine, Ubuntu dialout)
