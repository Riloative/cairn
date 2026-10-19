# Technical decisions

Non-obvious decisions, newest last. Each entry: context → decision → consequences.

## D-001 · Repository layout: npm project at the root, Vite root in `ui/` (M0)

The spec puts the frontend in `ui/` and the Tauri layer in `src-tauri/`. `package.json`,
`vite.config.ts`, `tsconfig*.json` and `eslint.config.js` live at the repo root with
Vite's `root: "ui"` and `outDir: "../dist"`, so `npm run tauri …` works from the root
and `src-tauri/tauri.conf.json` keeps the standard `../dist` layout. CI therefore runs
`npm run build` before `cargo clippy/test`, because `tauri::generate_context!` embeds
the built frontend.

## D-002 · TypeScript 6.0, not 7.x (M0)

TypeScript 7 (native port) is current, but `typescript-eslint` still requires
`typescript < 6.1`. Pinned `typescript@~6.0`. Revisit when typescript-eslint supports 7.
`baseUrl` is deprecated in TS 6, so path aliases use `paths` only.

## D-003 · Tailwind CSS v4 with tokens via `@theme inline` (M0)

Tailwind v4 is configured in CSS. All colors, radii, shadows and fonts are CSS variables
in `ui/src/styles/tokens.css` and are exposed to Tailwind through `@theme inline`, so a
theme switch is just a `data-theme` attribute change with no rebuild. Components use
semantic utilities (`bg-surface`, `text-fg-muted`, …) and never raw colors.

## D-004 · Fonts via `@fontsource-variable` (M0)

Inter and JetBrains Mono are bundled as variable WOFF2 from `@fontsource-variable/*`.
Vite copies the font files into `dist/`, so they ship inside the app and are served
from the app origin (allowed by `font-src 'self'`); nothing is fetched at runtime. OFL
license texts are copied to `ui/public/licenses/`.

## D-005 · Strict CSP and minimal capabilities (M0)

`tauri.conf.json` sets a CSP with `default-src 'self'`, no remote origins,
`object-src/frame-src 'none'`. (`freezePrototype` was on in M0 and turned off in M2, see D-017.) `style-src` allows
`'unsafe-inline'` because Radix and xterm.js set inline styles; scripts remain
`'self'` only. The only capability grants are the `core:app/event/window` defaults for
the `main` window. Plugin permissions are added per feature, never wholesale.

## D-006 · Release flow (M0)

Tag `v*` → a draft GitHub Release is created → `tauri-action` builds and uploads the
`.deb` (ubuntu-24.04) and `.dmg` (macos-14, `aarch64-apple-darwin`) → the release is
published. Builds are unsigned; install notes for macOS quarantine and the Linux
`dialout` group are in the release body and README.

## D-007 · Provisional MIT license metadata (M0)

Cargo and bundle metadata need a license field; `MIT` is set provisionally in the
workspace. The project owner should confirm or change it (and add a `LICENSE` file).

## D-008 · Crate seeds in M0 (M0)

M0 asks for the workspace layout only. Rather than empty crates, each crate starts
with a small, fully tested domain type that later milestones build on: error→user
message mapping and `Protocol` (core), legacy algorithm policy (ssh), line settings
(serial), IAC/option codes (telnet), display profile (rdp), RFC 1350 packet codec
(tftp) and diagram export options (export). None of these are placeholders; they are
complete for what they cover.

## D-009 · No separate password verifier; SQLCipher raw key (M1)

Argon2id(master password, salt) produces a 256-bit key passed to SQLCipher in raw-key
form (`PRAGMA key = "x'…'"`), so SQLCipher skips its own PBKDF2. A wrong key is detected
by SQLCipher's per-page HMAC on the first read (`SQLITE_NOTADB` → `WrongPassword`), so we
store no verifier hash. `vault.json` holds only the format version, salt and Argon2
costs (64 MiB, 1 lane, iterations calibrated at setup to ~0.7 s, minimum 3).

## D-010 · Failed unlock attempts while locked (M1)

The audit log lives in the encrypted database, which is unreadable while locked. Failed
attempts are appended (timestamp only) to a plaintext `unlock-failures.json` sidecar and
moved into the hash-chained log, with their original times, on the next successful
unlock. Brute-force cost is bounded by Argon2id (~0.7 s per guess).

## D-011 · Crash-safe master password change (M1)

The new KDF parameters are written to `vault.json.next` before `PRAGMA rekey`, then
renamed over `vault.json`. If the app dies between the rekey and the rename, unlock
falls back to the pending parameters and finishes the rename, so the database is
never left with a key nobody can derive.

## D-012 · Post-setup backup offer moved to M8 (M1)

SPEC §9 asks to offer an encrypted backup right after setup, but the `.cairn-backup`
format is an M8 deliverable. Building a throwaway backup format in M1 would mean a
second format to support later. M1 instead requires an explicit "there is no recovery"
acknowledgment on setup; M8 adds the backup offer to the end of the setup flow.

## D-013 · System sleep detection by clock drift (M1)

Tauri has no cross-platform suspend event. A 5 s background tick compares wall-clock
(`SystemTime`) and monotonic (`Instant`) elapsed time; `Instant` stops during suspend
on Linux (CLOCK_MONOTONIC) and macOS (mach_absolute_time) while wall time keeps going,
so a gap over 20 s means the machine slept and the vault locks. Idle time is measured
from the last user input reported by the frontend (throttled to one ping per 30 s).

## D-014 · Master password policy (M1)

Backend minimum: 10 characters. The UI additionally requires a zxcvbn score ≥ 2
("Fair") and shows the estimate. zxcvbn dictionaries (~1.5 MB) are lazy-loaded only on
the setup/change-password screens to keep cold start fast.

## D-015 · Audit append-only enforcement and future retention (M1)

`audit_log` has BEFORE UPDATE/DELETE triggers that abort, and every entry hashes the
previous entry, so edits outside the app are detectable via `verify`. Configurable
retention (M8) will need pruning with a signed/hashed checkpoint entry that anchors the
remaining chain; the triggers will be relaxed only for that migration-controlled path.

## D-016 · Theme cached outside the vault (M1)

Settings are encrypted, but the lock screen should already use the user's theme. The
resolved theme preference (not sensitive) is cached in the webview's localStorage and
applied before unlock.

## D-017 · `freezePrototype` disabled (M2)

Tauri's `freezePrototype` freezes `Object.prototype`. xterm.js 6 bundles VS Code's
`KeyCodeUtils` namespace, which assigns `toString` on a plain object; with a frozen
prototype that assignment throws at module load and the whole UI fails to start (the
"override mistake"). xterm.js is a hard requirement, so the option is off. Prototype
pollution is still mitigated by the strict CSP (`script-src 'self'`, no remote content,
no inline scripts), and nothing from the network is ever evaluated or rendered as HTML.
`scripts/ui-smoke.sh` in CI catches a regression like this (blank window).

## D-018 · CSP allows `'wasm-unsafe-eval'` (M2)

The xterm.js image addon (sixel/iTerm inline images, required by SPEC §2) decodes images
with WebAssembly. `script-src 'self' 'wasm-unsafe-eval'` permits compiling the bundled
WASM module only; JavaScript `eval`/`new Function` remain blocked and scripts still load
only from the app origin.

## D-019 · Accepting RUSTSEC-2023-0071 (rsa "Marvin" timing attack) (M2)

`russh` and `ssh-key` depend on the RustCrypto `rsa` crate, whose PKCS#1 v1.5 operations
are not constant-time (RUSTSEC-2023-0071); there is no fixed release. Cairn uses RSA only
on the client side to sign user-authentication challenges with RSA keys: one signature
per login, timed only by the server being logged into. The attack needs a large number
of precise timing measurements of private-key operations, which this usage does not
provide. The advisory is ignored in `deny.toml` and `.cargo/audit.toml` with this
justification; revisit when `rsa` ships a constant-time release. ed25519/ECDSA keys are
recommended in the UI.

## D-020 · Pinned Rust toolchain (M2)

`rust-toolchain.toml` pins the compiler (currently 1.99.1) so local builds and CI run the
same clippy lints; a newer stable in CI introduced a lint the local toolchain did not
know. Bump deliberately.

## D-021 · Serial hotplug by polling, only while someone is looking (M3)

Port hotplug is detected by re-listing ports once a second (`serialport` enumeration via
udev on Linux, IOKit on macOS) and diffing, rather than subscribing to udev/IOKit
notifications. One portable code path, no extra native dependencies, and a 1 s delay is
not noticeable when plugging a cable. The poll runs only while the connect dialog's
Serial tab is open (`serial_ports_watch` / `serial_ports_unwatch`), so an idle Cairn does
no background scanning.

## D-022 · Dropped serial and Telnet sessions reconnect like SSH (M3)

Every remote tab keeps a "reopen" closure in the frontend (SSH: the Rust-side connection
handle; Telnet: host/port; serial: port and line settings; no secrets). An unexpected
close uses the same overlay and backoff as SSH. For serial this means an unplugged USB
adapter is retried until it comes back, so re-plugging the cable resumes the console
without any clicks.

## D-023 · X/Ymodem files go through native dialogs and never overwrite (M3)

Files to send and the folder to receive into are chosen with the native dialog; the
frontend passes the paths to Rust, which reads/writes them (64 MiB send limit, regular
files only). Names announced by a Ymodem sender are reduced to a bare file name, and a
received file never replaces an existing one (`name (2).ext`, opened with `create_new`).
Every transfer, successful or not, is audited as `file_transferred`.

## D-024 · Inventory schema: relational core, JSON for flexible parts (M4)

Locations, devices, interfaces, VLANs, credential profiles and custom field definitions
are relational tables (foreign keys with `ON DELETE CASCADE / SET NULL`, UNIQUE
constraints mapped to friendly messages). Per-device data whose shape varies or grows
(connection methods, tags, VLAN ids, custom field values) is JSON text validated in Rust
on every save. A device stores every location level (building, floor, room, rack);
`core` fills parents from the most specific one, so they cannot disagree, and rejects
overlapping rack positions. Rooms and racks cannot move to another floor (move devices
instead), which keeps those invariants simple.

## D-025 · Inventory search and filtering run on the client snapshot (M4)

`inventory_snapshot` returns the whole inventory (without interfaces, loaded per device)
in one call; search, facet filters, grouping and sorting run in the frontend over that
snapshot. At the target size (300+ devices) this is a few hundred kB and filters in well
under a frame, avoids an FTS index inside SQLCipher, and lets search cover derived text
(location labels, credential names, custom field values) exactly as displayed. The table
is virtualized (TanStack Virtual). Revisit with SQLite FTS5 if inventories grow by
orders of magnitude.

## D-026 · Credential secrets are write-only over IPC (M4)

Secrets live in `credential_secrets` (inside the encrypted database), separate from the
profile metadata the UI lists. Saves send `{action: keep | clear | set}` per secret, so
an unchanged form never re-sends a secret. Audit diffs record `set` / `changed`
markers, never values. Reveal returns the value once (audited `credential_revealed`);
the UI hides it again after 30 s. Copy never sends the value to the webview: Rust writes
it to the clipboard with the plugin's `write_secret` (excluded from clipboard-manager
history), keeps only its SHA-256, and clears the clipboard after 30 s if it still holds
that value (audited `credential_copied`).

## D-027 · Connecting to devices is resolved in Rust, with one-shot auto-login (M4)

`device_connect(deviceId, method)` builds SSH / Telnet / console-server / serial options
from the device and its credential profile in Rust, so stored secrets never reach the
frontend. SSH uses the profile's key (vault or file), password, then interactive
fallbacks. For Telnet, console and serial logins, and for "enter enable mode on
connect", `core::login::LoginAutomator` watches the first 64 kB of output and answers
`Username:` / `Password:` / `>`-then-enable prompts. Each secret is typed at most once
and it stops on a failure message or a repeated prompt, so a wrong stored password can
never cause repeated attempts and lockouts.

## D-028 · Map layout is stored per view, separate from the inventory (M5)

The map adds four tables: `links` (one interface at each end, each interface in at most
one link, never two ends on one device), `map_positions` keyed by view (`campus:N`,
`building:N`, `floor:N`) and node (`d:N` device, `b:N` building), `map_zones` per view,
and `floor_plans` (image bytes as a BLOB inside the encrypted database, max 25 MB, MIME
sniffed from the content). A device therefore has independent positions on the campus,
building and floor views, and deleting a device or building forgets its positions.
Links are inventory data (audited like other inventory changes); positions and zones
are layout, saved without audit entries. Global map preferences (label toggles, color
by, grid, mini-map) are a settings document. Views and edges are derived on the client
from the inventory and map snapshots: campus edges aggregate every cable between two
buildings into one edge with a count; building and floor views draw each link and show
linked devices outside the view as dimmed peers. Undo/redo covers layout only
(positions, zones); link and inventory edits go through the audit log instead.

## D-029 · Diagram export builds its own SVG; Rust renders PNG and PDF (M5)

The exporter does not serialize the React Flow DOM (HTML nodes, CSS variables, no
fonts inline). `map/exportSvg.ts` draws a standalone SVG from the same model and routes the
canvas uses (`map/routing.ts`, D-033), with colors resolved from the current or
a forced light theme and floor plans embedded as `data:` URLs. SVG is written as is;
PNG (1×/2×/4×, capped at 16384 px per side) and PDF are rendered in
`cairn-export` with resvg and svg2pdf from that SVG, so all three formats match.
Text uses system fonts (Inter where installed, then common sans fonts): bundling
font files into the renderer would add megabytes for a small gain. Only `data:` image
hrefs are resolved, so an export can never read local files or the network. Exports
are audited as `data_exported` with the format and path.

## D-030 · Floor plan PDFs become PNG on import (M5)

A PDF floor plan is rendered once in the webview with pdf.js (page chosen by the user,
about 2400 px wide) and stored as a PNG. The canvas and exporter then only deal with
raster or SVG images, and the Rust side never parses PDFs. pdf.js 5+ never evaluates
document code; its WASM decoders stay off because they would be fetched at runtime.
Plan bytes travel as raw IPC bodies both ways; because `connect-src` only allows IPC,
the exporter re-reads the bytes over IPC and converts them with `FileReader` rather
than fetching the `blob:` URL the canvas displays.

## D-031 · Rack drag and the map canvas use pointer events, not HTML5 drag and drop (M5)

HTML5 drag and drop is unreliable in the Linux WebKitGTK webview when Tauri's file
drop handling is active, and gives no control over the drag image. The rack elevation
uses pointer capture with a live drop preview (green fits, red collides) and arrow keys
move a racked device by 1U; collisions are checked in the UI and again in Rust. The
map canvas is React Flow 12 (pointer based) with ELK's layered algorithm for
auto-layout: ranks come from device role (firewall → router → core → distribution →
access → servers → endpoints, from type and `core`/`distribution`/`access` tags), or
from the floor in a building view.

## D-032 · The map is static; live status comes later (M5)

Nodes show inventory data only. Reachability or interface status would need polling
(ICMP/SNMP) that the spec does not require and that conflicts with "no network calls
except user-initiated connections". The node model has room for a status field if a
user-triggered check is added later.

## D-033 · Link routing is computed for the whole view at once (M5)

`map/routing.ts` routes every link of a view in one pass, shared by the canvas and the
exporter, so exports match the screen. Each link is an orthogonal route between its
two boxes. Sideways exits use a device's icon tile, vertical exits the whole node so
lines never cross the hostname. Between rows a link leaves from the top or bottom
unless the gap is clearly wider than tall. When the straight route crosses another
node, the bend moves, the route switches axis, or it detours below or above the row,
whichever crosses the fewest nodes. Parallel links of one pair are offset 12 px and
nest. Links to different peers on the same side of a node get separate attachment
slots, ordered by where they go, and their port labels fan out. This is a heuristic,
not a full obstacle-avoiding router: ELK's own edge routes would be better but go
stale as soon as a node is dragged, and dragging must stay at 60 fps with a few
hundred links.

## D-034 · Tools reuse the open SSH connection (M6)

SFTP, SCP, port forwards and Grab config open extra channels on the connection of
an already open SSH tab (`SshSession::connection()`, looked up by session id in
`AppState.ssh_sessions`) rather than logging in again. A second login would repeat
OTP or keyboard-interactive prompts, double the session count on devices with a low
vty limit, and need the secret to leave the session that already used it. The
session holds only a `Weak` in the map, so closing the tab ends the connection and
every tool on it: forwards notice on a 2 s tick and close their listeners; transfers
fail with "the session has ended". Remote forwards register a route on the
connection, and the client handler matches incoming `forwarded-tcpip` channels
against those routes.

## D-035 · Grab config is a transport-independent state machine (M6)

`core::tools::grab::Grabber` is fed terminal output and returns what to send next
(enter enable, turn paging off, run the show command), or done or failed. Prompt
detection, `--More--` handling, output cleanup and CLI error detection live there,
unit-tested per vendor without a device. The SSH side runs it on its own wide pty
channel (511×200, so lines are not wrapped) and calls `idle()` after 900 ms of
silence; a 300 s deadline stops a hung device. Running the grab on a separate
channel keeps the user's terminal untouched. A session-less exec channel was
rejected because many network OSes do not accept exec, or ignore paging settings
there. Snapshots are deduplicated by SHA-256 (an identical grab is marked
unchanged), and diffs come from the `similar` crate, with changed lines paired up for
the side-by-side view.

## D-036 · TFTP server: one socket per transfer, root jail, atomic uploads (M6)

The `cairn-tftp` server follows RFC 1350 with the blksize, tsize and timeout options
(RFC 2347–2349). Each transfer gets its own ephemeral socket, block numbers roll over
past 65535 for large images, and lost packets are retransmitted. Paths are resolved
inside the chosen root. `..`, absolute paths and symlinks that point outside the
root are refused. Uploads are written to `.name.cairn-part` and renamed when they
complete, so a failed push never leaves a truncated config behind. Overwriting
existing files is a separate switch. The default port is 6969 on Linux (69 needs
`cap_net_bind_service`, explained in the UI and the bind error with setcap and
authbind commands) and 69 on macOS. The server only runs while the user has it
switched on and stops when the app exits. Like open sessions, it keeps running while
the app is locked, so a firmware push is not cut off by auto-lock. Transfers in that
time are queued for the audit log and written on unlock.

## D-037 · Broadcast mirrors input in the frontend and never logs it (M6)

Broadcast mirrors at the point where a tab's typed input, pastes and snippets are
delivered (`controller.deliver`), so every protocol behaves the same and no backend
fan-out is needed. The audit records who was in the group and for how long, never
the keystrokes: they may include passwords typed at a prompt, and the per-session
transcripts already handle redaction. A banner in every member tab and a marker in
the tab bar show that typing goes to more than one device.

## D-038 · Snippets are rendered in the frontend (M6)

Snippets hold no secrets (credentials stay referenced by ID), so `{{variable}}`
substitution runs in the UI, where the variables dialog lives. The backend stores
and validates them. A snippet goes through the same delivery path as typing, so it
also reaches broadcast groups.
