# Project: Cairn — a modern SSH / Serial / Telnet / RDP client with a network infrastructure map

You are building a complete, production-quality desktop application for a single network engineer, on macOS (Apple Silicon only) and Ubuntu 24.04+. This is a large project that will span multiple sessions. Work milestone by milestone and keep the repository always buildable. Persist your plan and progress in the repo so any future session can resume.

## 0. First actions in this session

1. Create `docs/SPEC.md` containing this entire specification verbatim. It is the source of truth.
2. Create `ROADMAP.md` with the milestones from section 12 as checkbox lists, broken into concrete tasks.
3. Create `CLAUDE.md` with: the architecture summary, crate and folder layout, build/test/lint commands, coding conventions, the security rules from section 9, and the instruction "Before starting work, read CLAUDE.md, ROADMAP.md and docs/SPEC.md; work on the first unchecked milestone; update ROADMAP.md checkboxes and add a short entry to docs/PROGRESS.md at the end of every session."
4. Then start Milestone 0.

## 1. Product principles

- **Minimalistic but feature-rich.** The visual design takes heavy inspiration from Linear and the Claude desktop app: calm, dense but breathable, few borders, subtle depth, fast. Advanced features live behind the command palette, context menus and settings, not in toolbars.
- **Keyboard-first.** There is a global command palette (Cmd+K on macOS, Ctrl+K on Linux) that can open devices, start sessions, switch views and run any action. All common actions have shortcuts, and the shortcuts are listed in Settings.
- **Fast.** The app cold-starts in under 1.5 s. Typing latency is imperceptible. It must handle 30+ simultaneous sessions and an inventory of 300+ devices without jank.
- **Secure by default** (see section 9).
- **Fully local.** There is no telemetry and no network calls except the connections the user initiates.

## 2. Tech stack (required)

- **Tauri 2**, with a Rust backend and a React + TypeScript + Vite frontend.
- **UI:** Tailwind CSS, Radix UI primitives (or shadcn/ui built on Radix), Zustand for state, TanStack Table for lists, Framer Motion used sparingly.
- **Fonts:** Inter for the UI and JetBrains Mono as the default terminal font, both bundled. They are OFL-licensed; include the licenses.
- **Terminal:** xterm.js with the WebGL renderer plus the fit, search, unicode11, web-links, serialize and image (sixel) addons.
- **SSH:** `russh` and `russh-sftp`. **Serial:** `serialport` / `tokio-serial`. **Local shell:** `portable-pty`. **RDP:** `IronRDP`. **Telnet:** a small Rust implementation with proper IAC/option negotiation.
- **Map:** React Flow (`@xyflow/react`) with ELK.js for auto-layout.
- **Storage:** SQLite via `rusqlite` with SQLCipher. **KDF:** Argon2id. Use `zeroize` for in-memory secrets.
- **Async runtime:** Tokio. Stream terminal and RDP data with Tauri v2 Channels using binary payloads, never JSON-encoded byte arrays.
- **Workspace layout:** a Cargo workspace whose crates have no UI dependency: `crates/core` (models, database, vault, audit, settings), `crates/proto-ssh`, `crates/proto-serial`, `crates/proto-telnet`, `crates/proto-rdp`, `crates/tftp`, `crates/export`. `src-tauri` is a thin layer of commands and events; `ui/` holds the frontend.
- **Dependencies:** Prefer well-maintained crates with permissive licenses. Run `cargo deny` and `cargo audit` in CI.

If a required library cannot do something essential (for example, legacy SSH algorithms in russh), document it in `docs/DECISIONS.md`, evaluate alternatives, and pick the most robust one. Do not silently drop the feature.

## 3. App shell and design system

- **Layout:** a collapsible left sidebar with the sections Sessions, Inventory, Map, Audit and Settings, plus the list of open sessions. The main area holds the active view. Session tabs sit along the top; each tab has a colored dot for its protocol and a small state indicator (connected, connecting, disconnected or error).
- **App themes:** at least 3 dark and 3 light themes, for example Midnight, Graphite and Obsidian (dark) and Paper, Porcelain and Sand (light). There is also a "follow system" option. Themes are implemented with CSS variables (design tokens for color, radius, spacing and shadow) on an 8 px spacing grid.
- **Interaction details:** subtle 120–200 ms transitions, skeleton states instead of spinners, and empty states that explain the next step with a single button.
- **Notifications and errors:** toast notifications and a non-blocking notification center. Error messages must be human-readable and actionable. For example: "Permission denied on /dev/ttyUSB0 — add your user to the dialout group: `sudo usermod -aG dialout $USER`, then log out and back in."

## 4. Terminal (Ptyxis-inspired)

- **Tabs and overview:** Tabs, plus a tab overview grid showing live thumbnails of every session, opened with a shortcut. There are no split panes.
- **Profiles:** each profile sets the font, size, line height, cursor style, scrollback (default 10,000 lines, configurable), palette, opacity, bell behavior, and copy-on-select.
- **Context-colored header bar:** the bar above the terminal is tinted by context, like Ptyxis. It is purple-ish for remote SSH/Telnet sessions, amber for serial, and red when a root or privileged prompt is detected. Privilege detection uses configurable prompt regexes, with defaults for Cisco/Juniper/Aruba/HP privileged prompts (`#`) and Linux root.
- **Notifications:** a desktop notification when a session disconnects unexpectedly. In local shells with OSC 133 shell integration, also notify when a long-running command finishes while the tab is unfocused.
- **Local shell tabs:** Local shell tabs with profiles. On Linux, offer quick-launch entries for detected Podman, Toolbox or Distrobox containers.
- **Terminal palettes:** bundle at least 15 popular MIT/permissively licensed palettes, such as Catppuccin variants, Dracula, Nord, Gruvbox, Solarized, Tokyo Night, One Dark, Rosé Pine and GitHub light/dark, with attribution. Users can import iTerm2 `.itermcolors`, Ghostty theme files, Windows Terminal JSON schemes and Alacritty TOML. Each import shows a live preview first.
- **Keyword highlighting engine:** highlighting is rule-based (regex → foreground/background/bold/underline) and implemented as an overlay. It must never modify the raw byte stream, and logs and recordings stay raw. Ship vendor rule sets for Cisco IOS/IOS-XE/NX-OS, Junos, FortiOS, ArubaOS-CX, HP/Aruba ProCurve, HP Comware and UniFi/EdgeOS. The rules highlight interface names, IPv4/IPv6 addresses and prefixes, MAC addresses, VLAN IDs, up/down/administratively down, err-disabled, errors and warnings, and shutdown/no shutdown. A device's vendor field selects its rule set automatically, and users can edit and add rules.
- **Search:** in-scrollback search with regex, case and whole-word options and match highlighting.
- **Paste safety:** a confirmation dialog for multi-line pastes that shows the line count. An optional per-line paste delay helps slow network gear.
- **Snippets:** a snippet library of saved commands, organized by folder and vendor and insertable from the command palette or a minimal snippet bar. Snippets can contain variables that prompt the user when inserted.
- **Broadcast:** a broadcast input that sends typed text to all selected sessions. Sessions are selected from tabs or from a multi-selection on the map. A visible banner is shown while broadcast is active.

## 5. Protocols

### SSH

- **Authentication:** password, public key (ed25519, ECDSA, RSA, including encrypted keys), keyboard-interactive (for RADIUS/TACACS+ OTP prompts), and ssh-agent via `SSH_AUTH_SOCK`. Agent forwarding is a per-device toggle and off by default.
- **Host keys:** strict host key verification, trust on first use with the fingerprint shown. A changed host key produces a full-screen warning that requires typing the word "accept" to proceed. Cairn keeps its own known-hosts store and can optionally read `~/.ssh/known_hosts`.
- **Legacy algorithms:** these can be enabled per device, with a visible warning badge on the device. The list includes diffie-hellman-group1/14-sha1, ssh-rsa (SHA-1) and aes-cbc ciphers. Old Cisco, HP and Aruba gear needs this, so it is essential.
- **Routing:** jump host chains (ProxyJump, multiple hops) and SOCKS5/HTTP proxies.
- **Reliability:** keepalives and auto-reconnect with backoff, with a "reconnect" overlay on dropped sessions.
- **Port forwarding:** a manager for local, remote and dynamic SOCKS forwards with per-device presets and live status.
- **SFTP side panel** (MobaXterm-style): it opens next to an SSH session, can be toggled, and shows a remote file tree. It supports upload/download with drag and drop from the OS file manager, rename, delete, mkdir, chmod, and a transfer queue with progress. Also support SCP download/upload for network devices that lack SFTP.
- **Session logging:** optional, with timestamps.

### Serial

- **Port discovery:** list ports with hotplug detection and friendly names using USB VID/PID (FTDI, Prolific, CP210x, CH340). On macOS, prefer `/dev/cu.*`.
- **Line settings:** full parameters with baud presets (9600 is the default, for Cisco consoles), data bits, parity, stop bits, and flow control (none, RTS/CTS, XON/XOFF). DTR and RTS can be toggled live.
- **Console controls:** send BREAK (important for password recovery), local echo, and newline mapping (CR, LF or CRLF in both directions).
- **File transfer:** Xmodem, Xmodem-1K and Ymodem send/receive with progress, for firmware recovery.
- **Permission handling:** detect permission problems and show the exact fix for each OS.

### Telnet

Full option negotiation and NAWS (window size). Also reverse Telnet to console servers: a device can have a "console via console server X, port Y" connection method (Opengear/Cisco-style port mapping).

### RDP

- **Engine:** an in-app session using IronRDP. Frames are decoded in Rust and sent as dirty rectangles over a binary Tauri Channel to a canvas. Keyboard and mouse input go back the same way, with correct key mapping on macOS.
- **Features:** NLA/CredSSP, TLS certificate verification with a trust prompt, dynamic resolution resize, fit-to-window or scaled modes, text clipboard sync in both directions, fullscreen, and Ctrl+Alt+Del.
- **Profiles:** resolution, color depth, gateway (if feasible) and optional SSH tunnel.
- **Fallback:** an optional per-device setting, "Open in external RDP client", launches FreeRDP (`xfreerdp`/`sdl-freerdp`) on Linux or an `.rdp` file on macOS.

### Built-in TFTP server

A toggleable TFTP server with a chosen root folder, interface/IP binding, read/write permissions and a live transfer log. Port 69 is privileged on Linux, so allow a custom port and explain the setcap/authbind option. It is used for firmware and config pushes.

### Other connection methods

A device can have a Web UI URL, which opens in the system browser.

## 6. Inventory

- **Location hierarchy:** Site (one campus; the site layer may stay implicit but should exist in the model) → Buildings → Floors → Rooms (optional) → Racks, with height in U.
- **Devices:** hostname, management IP (IPv4/IPv6, validated, with duplicate warnings), device type (switch, router, firewall, server, access point, wireless controller, storage, hypervisor host, PDU, UPS, patch panel, camera, IP phone, generic), vendor (Cisco, Juniper, Fortinet, Aruba, HP, Ubiquiti, MikroTik, Dell, generic, and user-addable), model, serial number, firmware version, location (building, floor, room, rack, U position and U height), VLANs, interfaces, credential profile, connection methods (SSH, Telnet, serial or console server, RDP, Web UI, each with its own settings), tags, notes (Markdown), and **custom fields**. Custom fields are user-defined with the types text, number, select, multi-select, date, URL, IP and boolean, and appear in tables, filters and detail views.
- **Interfaces** per device: name (for example Gi1/0/1, xe-0/0/1, port1, eth0), type (copper, SFP/SFP+/QSFP, fiber, wireless, virtual or LAG), speed, mode (access, trunk or routed), access VLAN, allowed/native VLANs, LAG membership, description, and enabled/disabled. Bulk-create interfaces from patterns, for example `Gi1/0/1-48`.
- **VLAN registry:** ID, name, subnet, gateway, description and color. The color is reused on the map.
- **Credential profiles:** username, password or private key reference, optional enable secret with an "auto-enter enable on connect" toggle, and optional SNMP-free notes. Secrets are stored only in the vault, and the UI references profiles by ID.
- **List views:** a Linear-style inventory table with fast filtering, grouping (by building, type or vendor), sorting, column chooser, saved views and full-text search. A side sheet shows the detail view. All create/edit flows are clean, minimal forms with smart defaults, inline validation and keyboard navigation.
- **Duplication:** duplicate a device with its interfaces, then edit.

## 7. Network map

- **Views with breadcrumbs:** Campus → Building → Floor → Rack.
  - **Campus view:** buildings are containers or nodes, with inter-building links (for example fiber uplinks between distribution switches) drawn between them.
  - **Building view:** floors and their devices.
  - **Floor view:** devices, and optionally a floor-plan background image (PNG/JPG/SVG/PDF page) uploaded by the user, with scale and opacity controls.
  - **Rack elevation view:** front view by U position. Devices are drawn with their height. Drag to re-position, and collisions are prevented.
- **Canvas:** a freeform canvas with snap-to-grid, alignment guides, multi-select, grouping into zones (for example "DMZ", "Server Farm", "Core"), lock/unlock positions, and undo/redo.
- **Auto-layout:** a button runs ELK hierarchical or layered layout (core → distribution → access) and can be applied to a selection.
- **Icons:** an original, consistent, minimalist SVG icon set for every device type. Icons work on dark and light themes, and vendor appears as a small text badge.
- **Links are interface-to-interface.** To create one, drag from a device, then pick the source interface and target interface from searchable dropdowns, for example switch Gi1/0/1 → server eno1. A link records media (copper, SM fiber, MM fiber, DAC, wireless), speed, VLANs, LAG grouping and a description.
- **Link labels:** port names, speed and VLAN labels can each be toggled per link and globally. Links can be colored by media, speed or VLAN.
- **Link routing:** orthogonal edges with clean bundling of parallel links. The pathfinding should avoid overlapping nodes where reasonable.
- **Device interactions:** double-click a device to open its default connection in a new tab. The right-click menu offers SSH, Telnet, serial, RDP, Web UI, ping, traceroute, Grab config, copy IP, edit and show in inventory. Hovering shows a minimal card with hostname, IP, model and location.
- **Broadcast from the map:** multi-select devices, then choose "Open sessions to all" or "Broadcast command".
- **Search and focus:** search on the map to jump to and focus a device, and a mini-map.
- **Static diagram:** there is no live monitoring in this version. Design the data model so live status could be added later.
- **Export:** the current view or a selection can be exported to PNG (with a 1x/2x/4x scale option), SVG and PDF (vector, generated in Rust with `svg2pdf` or equivalent). Exports have optional titles, a legend and date, and follow the theme or a forced light theme for printing.

## 8. Config grab and diff (manual only, no scheduling)

A "Grab config" action runs the vendor-appropriate command (for example `show running-config`, `show configuration | display set`, `show full-configuration`) over the device's SSH connection. It handles paging automatically by sending the vendor's terminal-length command first. The result is stored as a timestamped snapshot on the device. Snapshot history has a side-by-side diff viewer with syntax highlighting and export to file.

## 9. Security (non-negotiable)

- **Master password:** required on first launch and to unlock the app. Argon2id (tuned to ~0.5–1 s) derives the SQLCipher key. The app auto-locks after configurable idle time and on system sleep (default 15 min). Show a password strength indicator on setup. Warn clearly that a lost master password means lost data, and offer an encrypted backup immediately after setup.
- **Secrets stay in Rust:** credentials, keys and passphrases live only in the encrypted vault and in Rust memory, using `zeroize`. They never reach the frontend. Rust uses credential IDs, and the frontend only shows masked values unless the user explicitly reveals one, which is audited. Copying a password to the clipboard clears it after 30 s.
- **Tauri hardening:** a strict CSP, no remote content, and minimal capabilities/permissions per window. All IPC commands are typed and validated. Nothing from the network is ever rendered as HTML, so web links in the terminal open only via an explicit click.
- **Logs:** they never contain secrets. Password prompts typed in terminals are masked in the audit log where detectable. The transcript keeps raw output, but input typed after a password prompt is redacted.
- **Supply chain:** `cargo audit`, `cargo deny` and `npm audit` all run in CI.

## 10. Audit and session recording

- **Audit log:** append-only and tamper-evident. Each entry includes a SHA-256 hash of the previous entry, and a "Verify integrity" action re-checks the chain.
- **Events logged:** app unlock and lock, failed unlock attempts, session start and end (device, protocol, target, username, duration, host key or cert fingerprint), host key accept or change, credential reveal and copy, inventory create/update/delete with a field-level diff, config grabs, broadcast usage, TFTP transfers, file transfers (SFTP/SCP/Xmodem), exports and imports, and settings changes.
- **Session recordings:** optionally on per device or globally. Terminal sessions are recorded in asciicast v2 format with timestamps. An in-app replay player supports seek and speed control, and text transcripts can also be exported. RDP recording is not required.
- **Audit view:** a Linear-style table with filters for time range, device, event type and protocol. It exports to CSV and JSON. Retention is configurable, and the default is to keep everything.

## 11. Data export and backup

- **Full backup:** a single encrypted archive (`.cairn-backup`) containing the database, settings, themes, snippets, floor plans, config snapshots, and recordings (optional). It is encrypted with a password chosen at export time and can be restored via import.
- **Readable export:** inventory, locations, interfaces, links and VLANs as JSON and CSV. Credentials are excluded unless the user explicitly opts in, after a strong warning.
- **Diagram export:** see section 7.

## 12. Milestones

Each milestone must end with: all tests passing, CI green on both platforms, ROADMAP.md updated, and a commit/PR. Do not leave stubs or TODOs inside a milestone marked complete.

- **M0 – Scaffolding:** Cargo workspace, Tauri 2 app, React/Vite/Tailwind/Radix, lint and format setup (clippy, rustfmt, eslint, prettier), CI building an unsigned `.dmg` (macos-14 arm64 runner, `aarch64-apple-darwin`) and `.deb` (ubuntu-24.04) as downloadable artifacts, plus a release workflow on git tags.
- **M1 – Core and shell:** vault and master password with lock/unlock, the SQLCipher database with migrations, audit log core (hash chain), settings, the design system with all app themes, sidebar, tabs, command palette and notification center.
- **M2 – Terminal and SSH:** xterm.js integration over binary channels, local shell tabs, terminal profiles and palettes with theme import, full SSH (all auth methods, host keys, legacy algorithms, jump hosts, proxies, keepalive and reconnect), keyword highlighting with vendor rule sets, search, paste safety, tab overview and header coloring.
- **M3 – Serial and Telnet:** serial with hotplug, all parameters, BREAK and Xmodem/Ymodem, plus Telnet with reverse Telnet to console servers.
- **M4 – Inventory:** locations hierarchy, devices, interfaces (with bulk create), VLANs, credential profiles, custom fields, table views, side sheets and forms.
- **M5 – Map:** campus, building, floor and rack views, interface-to-interface links with labels and toggles, zones, auto-layout, context menus, connect-from-map, floor plans, and PNG/SVG/PDF export.
- **M6 – Power tools:** SFTP side panel and SCP, port forwarding manager, TFTP server, snippets, broadcast (from tabs and map), Grab config with diff, and audit integration for all of them.
- **M7 – RDP:** IronRDP session view, NLA, certificate trust, resize, clipboard, fullscreen and the external client fallback.
- **M8 – Audit and data:** the audit view with filters, integrity verification and export, asciicast recording and replay, encrypted full backup/restore, and JSON/CSV export.
- **M9 – Polish:** performance pass (300 devices, 30 sessions, map with 500 links), accessibility (focus rings, contrast in all themes), empty states, onboarding, a keyboard shortcuts sheet, and a README with install notes. The README must explain that macOS users of the unsigned build need to run `xattr -dr com.apple.quarantine /Applications/Cairn.app` or right-click → Open, and that Ubuntu users installing the .deb need to join the `dialout` group for serial.

## 13. Testing in the cloud sandbox (you cannot see the GUI)

- Write unit tests for everything in `crates/*`. Write integration tests against real local servers: install and run `openssh-server` with test users and keys, including a config with legacy algorithms; use `socat` virtual PTY pairs to test serial, including Xmodem; run a local Telnet server; and, if feasible, run `xrdp` to test RDP connection and frame decoding.
- Frontend: Vitest with React Testing Library for components and stores. End-to-end smoke tests use `tauri-driver` (WebDriver) on Linux under `xvfb` in CI.
- Since you cannot visually inspect the UI, be rigorous about the design tokens, consistent component primitives and Storybook-free but well-structured components. In CI, render key screens to screenshots under xvfb and upload them as artifacts so the user can review them.
- macOS-specific code (key mapping, serial device names, notifications) must compile and be tested in the macOS CI job.

## 14. Working style

- Read the existing code before changing it. Keep functions small and modules focused, and use typed errors (`thiserror`) mapped to user-friendly messages.
- Record every non-obvious technical decision in `docs/DECISIONS.md`.
- If something in this spec is technically impossible or unwise, say so in DECISIONS.md, implement the closest robust alternative, and flag it in the session summary.
- End every session with a concise summary: what was done, what's next, and anything the user should test manually on their Mac or Ubuntu machine.
