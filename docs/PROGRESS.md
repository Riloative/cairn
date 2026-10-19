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

### M3 (session 3)

- `proto-serial`: port discovery with USB VID/PID chip names (`/dev/cu.*` only on macOS),
  full line settings, DTR/RTS, BREAK (500 ms), local echo, newline mapping, permission
  errors with the per-OS fix, and Xmodem / Xmodem-1K / Ymodem send and receive,
  integration-tested over socat PTY pairs against lrzsz (`sx`, `rb`, `sb`).
- `proto-telnet`: loop-safe IAC/option negotiation, NAWS, terminal type, BREAK, raw TCP
  mode, console-server port mapping (Opengear, Cisco lines, Avocent, Lantronix, Digi);
  tested against a real inetutils telnetd and scripted servers.
- App: `serial_*` and `telnet_open` commands, a generic `session_break`, hotplug
  watching while the Serial tab is open (D-021), and transfers in a blocking thread
  with throttled progress, cancellation and `file_transferred` audit entries (D-023).
- UI: the connect dialog (`Mod+N`) has SSH / Telnet / Serial tabs; serial header
  controls (DTR/RTS toggles, Break, Transfer menu); a transfer dialog with progress
  that can be hidden and reopened; palette actions for BREAK and transfers. Serial and
  Telnet tabs reconnect with backoff like SSH (D-022). Audit view labels sessions and
  transfers.
- Verified in the real release build under Xvfb: serial console over a socat null
  modem, a 70 kB Ymodem upload to `rb` (byte-identical), unplug → "Was the cable
  unplugged?" → automatic resume on replug, and Telnet to telnetd with NAWS and BREAK.

**Next:** confirm CI green for M3, then M4 (inventory).

**Test manually:** real USB-serial adapters (FTDI, Prolific, CP210x, CH340) on both OSes,
including hotplug and the Linux `dialout` hint; BREAK into ROMMON on a Cisco device;
an Xmodem image upload in ROMMON; reverse Telnet through an Opengear/Avocent/Cisco
terminal server; on macOS, that only `/dev/cu.*` ports are listed.

### M4 (session 3, continued)

- M3 closed: CI run 16 green on both platforms.
- Schema v3 and `core::inventory`: sites → buildings → floors → rooms → racks, devices
  (all spec fields, connection methods, VLANs, tags, Markdown notes, custom fields),
  interfaces with bulk creation from patterns, VLAN registry with colors, custom field
  definitions, saved table views, user vendors. Every change is audited with a
  field-level diff; rack positions cannot overlap; duplicate IPs/hostnames warn.
- Credential profiles with secrets kept write-only (D-026): reveal and copy are audited;
  copy goes from Rust to the clipboard and is cleared after 30 s.
- Connect from inventory (D-027): `device_connect` builds SSH, Telnet, console-server
  and serial sessions in Rust from the device's profile; `core::login` answers
  Username/Password prompts and enters enable mode once, never retrying.
- UI: Inventory view with Devices / Locations / VLANs / Credentials / Fields; a
  virtualized TanStack table with full-text search, facet filters, grouping, sorting,
  column chooser and saved views; side sheet with overview (connect buttons, legacy-SSH
  badge, Markdown notes) and interfaces; device form with inline validation, cascading
  location pickers, connection editor and custom fields; palette actions per device.
- Verified in the release build under Xvfb: SSH to a device logs in with the vault
  password (TOFU prompt only); Telnet to a scripted Cisco-style login logs in and
  reaches `sw1#` automatically; duplicate-IP warning; audit entries for each step.

**Next:** M5 (map). M4 CI run 18 is green on both platforms.

**Test manually:** a real Cisco/Aruba switch with a credential profile (SSH with
auto-enable, and Telnet/console-server login); copy a password and check that the
clipboard clears after 30 s and that clipboard managers (GNOME/KDE, macOS) don't keep
it; an inventory of a few hundred devices for table speed.

### M5 (session 3, continued)

- M4 closed: CI run 18 green on both platforms.
- Schema v4 and `core::map` (D-028): interface-to-interface links (media, speed,
  VLANs, LAG, description, per-link label overrides; audited), per-view node
  positions and zones, floor plans stored in the encrypted database, map preferences.
- `cairn-export` renders map SVG to PNG (1×/2×/4×, resvg) and vector PDF (svg2pdf)
  with system fonts; `map_export` writes the file and audits it (D-029).
- Map view: campus (buildings, cables aggregated), building (floor bands, outside
  peers dimmed) and floor views with breadcrumbs, floor chips and search across
  views; original icons with vendor badges; links colored by media, speed or VLAN with
  a legend; port/speed/VLAN labels (global and per link); orthogonal routing that
  avoids nodes, nests parallel links, marks LAG bundles and spreads links sharing a
  side (D-033); snap to grid, alignment guides, multi-select, zones that carry their
  devices, per-node and global lock, undo/redo; ELK auto-layout by role or floor
  (D-031); context menus (connect, ping, traceroute, copy IP, edit), hover cards,
  double-click to connect or open, mini-map. Draw a link by dragging from a device
  onto another; the dialog creates missing interfaces.
- Floor plans: PNG/JPEG/SVG or a PDF page (rendered with pdf.js, D-030), auto-fitted
  behind the floor's devices, with scale/opacity/offset. Rack elevations with
  pointer drag (fit preview, collision-free) and 1U keyboard moves.
- Export dialog: PNG/SVG/PDF, title, legend, date, current or light theme, selection
  only.
- `seed_demo` example fills a vault with a demo campus for trying the map.
- Verified in the release build under Xvfb: first-open auto-layout and fit on campus,
  building and floor views; drawing a link with new interfaces; rack drag between
  racks; PNG and PDF export (fonts embedded, matches the canvas); PDF floor plan
  upload, fit and reload after restart.

**Next:** M6 (power tools). M5 CI run 21 is green on both platforms.

**Test manually:** the map with a real inventory of a few hundred devices (drag
performance, auto-layout time, readability of routes); PDF export opened in a PDF
viewer and printed; a multi-page PDF floor plan (page choice); trackpad pinch/zoom
and Cmd-click multi-select on macOS; the map in each theme, including "light theme"
exports from a dark theme.

### M6 (session 3, continued)

- Schema v5 (`0005_tools.sql`): snippets (with starter snippets), port-forward presets
  per device, config snapshots.
- Shared SSH connection (D-034): SFTP, SCP, forwards and Grab config open extra
  channels on the open tab's connection, so there is no second login and no second
  OTP prompt.
- SFTP file panel next to SSH tabs: browse, path bar, mkdir, rename, delete, chmod,
  drag and drop from the desktop, and a sequential transfer queue with progress and
  cancel. SCP is available as the transfer protocol for devices without SFTP; IOS
  paths like `flash:` work.
- Port forwarding manager (Tools, Mod+5): local, remote and dynamic (SOCKS5)
  forwards with live connection and byte counters, presets per device, and
  autostart when a session connects.
- TFTP server (`cairn-tftp`, D-036): root jail, bind address and port (6969 by
  default on Linux, with setcap/authbind help), read/write/overwrite switches,
  blksize/tsize/timeout options, a live transfer log, and atomic uploads.
- Snippets: a library with folders and `{{variables}}`, a variables dialog, a snippet
  bar (Mod+Shift+S), and one palette entry per snippet.
- Broadcast (D-037): choose tabs or select devices on the map, type once into all of
  them. A banner and a tab marker show the group. Mod+Shift+B stops it.
- Grab config (D-035): the vendor's show command runs on a hidden channel, handling
  enable, paging and prompts for Cisco, Juniper, Fortinet, Aruba/HP, MikroTik and
  Ubiquiti. Each grab is stored as a snapshot. The Configs tab in the device sheet
  shows the history, a side-by-side diff that folds unchanged lines, and export as
  text or unified diff. Grab is also in the device and map menus and the SSH tab
  header.
- Audit: broadcast start and end, config grabs, port forwards, the TFTP server and
  its transfers, SFTP/SCP transfers and exports, all with readable summaries in the
  audit view.
- Tests: core (snippets, forwards, snapshots, grab per vendor, diff), the TFTP server
  over UDP, proto-ssh tool tests against a real sshd (forwards, SFTP, SCP, grab), and
  UI tests for each new panel.
- Verified in the release build under Xvfb against the local test sshd: TFTP get and
  put with curl, plus refused requests (missing file, overwrite off) in the live log
  and the audit; the SFTP panel on the shared connection (list, refresh, rename);
  a local forward carrying traffic; broadcast across two SSH tabs (both shells ran
  the command) and a snippet with a variable typed into both; audit summaries for
  each event. That pass found and fixed: forward traffic counters were only added
  when a connection closed cleanly (now counted live), refused TFTP requests were
  not audited, and cramped columns in the forwards and TFTP tables.
- Grab config and the diff viewer were not run against a real network device here
  (the test server is a Linux shell). Grab is covered by the per-vendor state-machine
  tests and an integration test on a real SSH channel, and the viewer by UI tests.
- CI: the Linux Rust job ran out of disk once the M6 crates were added. Dev profile
  debug info is now off in CI, and unused preinstalled SDKs are removed.

**Next:** M7 (RDP). M6 CI run 30 is green on both platforms.

**Test manually:** Grab config on real Cisco IOS/NX-OS, Junos, FortiOS, ArubaOS-CX,
MikroTik and EdgeOS devices (enable secret, paging, long configs), then compare two
snapshots and export the diff; `copy tftp:` of a large IOS image to a switch (block
rollover past 32 MB with 512-byte blocks); TFTP on port 69 after `setcap`; SCP to
an IOS device's `flash:` when SFTP is off; dragging files from the desktop onto the
file panel on macOS and GNOME; a SOCKS forward used by a browser; remote forwards
on a server that only allows `GatewayPorts no`; broadcast from a map selection
with a mix of SSH and serial devices.

### M7 (session 3, continued)

- `proto-rdp` on IronRDP 0.17 (D-039, D-040): connects over TCP or an SSH tunnel,
  requests NLA and falls back to TLS (xrdp), pins the server certificate in the
  known-hosts store before any credential is sent, streams dirty rectangles (≤ 60 fps,
  one binary message per flush) and cursor bitmaps, takes keyboard (physical codes →
  scancodes), mouse and wheel input, Ctrl+Alt+Del, Display Control resize with
  Deactivation-Reactivation, and text clipboard both ways. One thread per session.
- `ironrdp-connector` vendored with `sspi` 0.23 so it resolves next to russh; workspace
  `rust-version` 1.93.
- Tauri: `rdp_open` / `device_rdp_open` with password prompt, SSH tunnel prompts and the
  certificate prompt on the session's event channel; input, resize, clipboard,
  Ctrl+Alt+Del and close commands; session start/end and certificate decisions audited;
  external client (FreeRDP with the password on stdin, `.rdp` on macOS).
- UI (D-041): RDP tabs with a persistent canvas, fit / 1:1, desktop follows the tab
  size, full screen (F11), ⌘-as-Ctrl on macOS, all keys to the server except palette,
  tab switching and lock, certificate dialog (changed certificates get the host-key
  warning), quick-connect RDP tab and palette action, device RDP settings (domain,
  security, resolution, colors, clipboard, SSH tunnel, external client).
- Tests: Rust unit tests (frames, keymap, input, clipboard backend, certificate,
  errors, config), xrdp integration tests (certificate rejection stops before sign-in;
  connect, real frames, typing, close), Tauri command tests (options, FreeRDP args never
  carry the password, `.rdp` file), UI tests (quick connect → certificate → password →
  frames → input → reconnect asks again; changed certificate; device and external
  client). CI starts xrdp for the integration tests.
- Verified in the release build under Xvfb against xrdp: quick connect, password
  prompt, certificate trust dialog, the xterm desktop fitted to the tab, typing (Ctrl+U
  and Ctrl+W go to the desktop, the tab stays), full screen, audit entries for trust,
  start and end, and a second connection reattaching without a certificate prompt.
- Found on the way: `parse_target("user@")` accepted an empty host (also affected SSH
  jump hosts); fixed. Raising the MSRV turned on a clippy lint in two older tests.
- CI run 35 hit a 5-minute hang in the config-grab integration test: the grabber took
  the first chunk whose last line looked like a prompt, so a prompt split across reads
  (`[admin@MikroTik]` + ` >`) was recorded half-way and the real prompt never matched.
  The first prompt is now taken only after the output goes quiet; regression test added.

**Next:** M8 (audit and data). M7 CI green on both platforms (run 37).

**Test manually:** RDP to Windows 10/11 and Server 2019/2022 with NLA (local and domain
accounts, `DOMAIN\user`), a dynamic resize and the Retina sharpness on macOS, ⌘C/⌘V
into Windows apps, clipboard both ways, Ctrl+Alt+Del to the security screen, an SSH
tunnel through a bastion, the external client on Ubuntu (FreeRDP 3) and macOS (Windows
App), and a changed server certificate (regenerate it) showing the warning.
