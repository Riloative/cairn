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

## D-039 · IronRDP's connector is vendored with a newer `sspi` (M7)

IronRDP 0.17's `ironrdp-connector` 0.10 pins `picky =7.0.0-rc.25`, which pins
`curve25519-dalek =5.0.0-rc.1`. russh needs `curve25519-dalek ^5` (stable 5.0.0), and
Cargo allows only one version in that range, so the two cannot resolve together. The
connector is copied to `vendor/ironrdp-connector` and used through
`[patch.crates-io]`, with `sspi` raised to 0.23 (which uses `picky` rc.26 and stable
dalek) and two marked edits: `TsRequest::buffer_len()` now returns a `Result`, and an
unfulfilled lint expectation is removed so `-D warnings` stays clean. Nothing else
changes. Drop the patch once IronRDP releases a connector on `sspi` ≥ 0.22. IronRDP and
`sspi` need Rust 1.93, so the workspace `rust-version` is now 1.93 (the pinned toolchain
is 1.99).

## D-040 · RDP engine: thread per session, pinned certificates, dirty-rect frames (M7)

- **Thread per session.** IronRDP's connection future is not `Send` (its
  `NetworkClient` trait returns an unbounded `impl Future`), so each RDP session runs on
  its own thread with a current-thread Tokio runtime. Sessions are few, so the cost is
  negligible, and no `Send` workarounds are needed in the protocol code.
- **Certificates are pinned, not CA-validated.** RDP servers almost always use
  self-signed certificates. After the TLS handshake and before CredSSP (or the Client
  Info PDU) sends any credential, the SHA-256 fingerprint of the server's DER
  certificate is checked against Cairn's known-hosts store (key type `x509`). Unknown
  certificates prompt; changed ones get the same full warning as a changed SSH host key.
- **NLA with fallback.** Cairn requests NLA (CredSSP) and accepts TLS when the server
  only offers that (xrdp). Credentials are then sent in the Client Info PDU with
  autologon so the server does not show its own logon screen. A "TLS" profile setting
  skips CredSSP for servers that reject it. Kerberos is not supported (it would need
  network calls to a KDC); NTLM works for local and domain accounts.
- **Frames.** Updates are collected as dirty rectangles, merged when the union wastes
  little area, and flushed at most every 16 ms as one binary message of RGBA crops
  (format in `proto-rdp/src/frame.rs`). Each message carries the desktop size, so the
  canvas follows a server-side resize without ordering against the JSON events. The
  server's cursor is sent as its own bitmap message and shown as a CSS cursor, so it
  moves without lag.
- **Input** arrives as DOM `KeyboardEvent.code` values mapped to set 1 scancodes, so the
  server's keyboard layout applies and shortcuts work regardless of the local layout.
- **Resize** uses Display Control when the server offers it (Windows 8.1/2012 R2 and
  later); otherwise the view scales the fixed desktop. No reconnect-on-resize.
- **Clipboard** is plain Unicode text in both directions, per profile.

## D-041 · RDP view: device pixels, key capture, external clients (M7)

- **Device pixels.** The desktop is requested at the view's size × the device pixel
  ratio, with that ratio as the desktop scale factor, so text is sharp on Retina and
  HiDPI screens and Windows scales its UI to match. "Fit" scales the canvas into the
  tab; "1:1" maps one desktop pixel to one device pixel and scrolls. When the profile
  has no fixed resolution, the desktop follows the tab size (Display Control, 400 ms
  after resizing stops).
- **Keys belong to the remote desktop.** While the canvas has focus, every key is sent
  to the server (Tab, F5, Ctrl+W, Alt+F4…). Only the command palette, tab switching and
  Lock Cairn stay app shortcuts, so the user can always leave the session. F11 toggles
  full screen. Keys held when focus leaves are released on the server.
- **macOS.** Keys travel as physical codes, so the server's layout applies. ⌘ is sent as
  Ctrl by default (⌘C/⌘V/⌘Z behave as on the Mac); a header toggle sends it as the
  Windows key instead.
- **Clipboard.** Text from the server is written to the local clipboard; the local
  clipboard is offered to the server when the desktop gains focus and has changed (not
  echoing what came from the server). Off per device when not wanted.
- **Quick-connect passwords** are sent once; a reconnect asks again rather than keeping
  the password in the frontend. Device passwords come from the vault in Rust.
- **External clients.** FreeRDP gets the password on stdin (`/from-stdin`), never on the
  command line where other users could see it in the process list. On macOS an `.rdp`
  file (without password, the format cannot hold one safely) opens in the system RDP
  app. SSH tunnels are only available in the built-in client.
- **No reconnect-on-resize.** Servers without Display Control (older Windows, xrdp
  0.9) keep their size and the view scales; reconnecting to resize would drop the
  user's session state on servers that do not reattach.
- **No RD Gateway yet.** IronRDP's gateway client (`ironrdp-mstsgu` 0.0.1) is
  experimental and there is no gateway to test against here. An SSH tunnel through a
  bastion covers the common "server behind a jump host" case; a gateway profile option
  can be added when the crate matures.

## D-042 · Audit retention without breaking the hash chain; filtered queries (M8)

- **Retention keeps the chain verifiable.** The log is append-only (triggers) and each
  entry hashes the previous one, so deleting old entries would break verification from
  entry 1. Pruning instead writes an `audit_pruned` entry into the chain (keep-from
  position, count, cutoff), then moves a one-row anchor (`audit_anchor`: first kept seq
  and the hash it continues from) and deletes only below it. The delete trigger now
  allows deletes strictly below the anchor; the anchor can only move forward and cannot
  be removed. `verify` starts at the anchor and requires the latest `audit_pruned`
  entry to name the same position, so moving the anchor to hide entries means editing
  a hashed entry, which is detected.
- **When it runs:** on unlock and when the setting is shortened (after a confirmation
  that says removed entries are gone for good). Default 0 = keep everything (SPEC §10).
  Entries are kept from the first one newer than the cutoff, so a late-copied
  `unlock_failed` with an old timestamp never punches a hole in the chain.
- **Filters query the JSON payload** (`json_extract`) instead of new columns: rows
  cannot be updated to backfill columns, and a single-user log stays small. A device
  filter also matches everything that happened in that device's sessions (end,
  transfers, forwards) by joining on `sessionId`, so `session_ended` needed no new
  field. Device and protocol match ignore case. Search text is matched literally (`%`
  and `_` escaped).
- **CSV exports neutralize formulas** (`=`, `+`, `-`, `@`, tab, CR get a `'` prefix).
  Hostnames, banners and file names come from devices, so opening an export in a
  spreadsheet must not run anything. JSON exports keep entries whole, with hashes.

## D-043 · Session recordings: output only, inside the encrypted database (M8)

- **Stored in SQLCipher, not as files.** Recordings contain whatever devices print
  (configurations, `show` output, sometimes secrets in banners), so they get the same
  protection as the vault: chunks of asciicast event lines in `recording_chunks`,
  encrypted with the vault key, deleted with their row, included in full backups. The
  existing "session logging" option still writes plain text files and now says so.
- **Output and resizes only.** asciicast can hold input (`i` events), but typed input
  is where passwords are. Recording only what the device prints keeps commands (as
  echo) and leaves passwords out (prompts do not echo), with no prompt detection.
- **Buffered writes.** Events are stored every 2 s or 64 KB. While Cairn is locked
  they stay in memory (up to 32 MB, then the recording is marked cut) and are stored
  on unlock; a recording is capped at 256 MB.
- **Header at read time.** The asciicast header (size, start time, title) is built
  from the row when replaying or exporting, so exported `.cast` files play in
  asciinema. Transcripts are the output with escape sequences removed and carriage
  returns/backspaces applied.
- **Who is recorded:** every terminal session when "Record sessions" is on, plus
  sessions to devices with "Record terminal sessions" set. RDP is not recorded (SPEC
  §10). A REC mark in the session header shows it. Deleting a recording is audited.
- **Replay** writes events into a read-only xterm; seeking back resets the terminal
  and replays up to the new time. "Shorten pauses" caps idle gaps at 2 s.

## D-044 · `.cairn-backup`: an encrypted database copy with its own password (M8)

- **Format:** `CAIRNBK\x01`, a length-prefixed JSON header (created, app version,
  schema version, recordings included, Argon2id parameters and salt), then the whole
  database as a SQLCipher file keyed with Argon2id of the backup password. Everything
  Cairn keeps is in the database (floor plan images, snapshots, recordings, settings,
  themes, snippets), so this is the full backup SPEC §11 asks for.
- **No plaintext on disk at any point.** The copy is `ATTACH … KEY` +
  `sqlcipher_export` into a database encrypted from its first page, in the data
  directory, removed on every path. Leaving recordings out deletes them from the copy
  and VACUUMs it so their pages are gone. The header is not secret; a wrong password
  or a modified file fails SQLCipher's per-page HMAC (first page = "wrong password",
  later pages = "damaged").
- **Own password, master-password costs.** The backup password is chosen at export
  (same length and strength rules as the master password) so a backup can be restored
  on another machine or after the master password is lost. Argon2id costs are the
  vault's calibrated ones, with a fresh salt.
- **Restore** decrypts into a temporary file, checks integrity, re-keys it to the
  master key, migrates older schemas (newer ones are refused), and swaps it in; the
  previous database is kept until the restored one opens and is put back on failure.
  When unlocked it replaces everything, so it needs the current master password and no
  open sessions (terminal or RDP); the app reloads afterwards. On first launch the
  restore sets a new master password instead of creating an empty vault. The restored
  audit chain continues with a `backup_restored` entry.
- **Post-setup offer** (D-012): after creating the vault, Cairn offers a backup once,
  explaining that a lost master password cannot be recovered but a backup can be
  restored. Settings → Backup offers backup and restore any time.

## D-045 · Polish at scale: lazy views, a WebGL pool, indexed audit filters, worker layout (M9)

- **Scale fixture.** `crates/core/examples/seed_scale.rs` builds the SPEC's target
  inventory (300 devices in 5 buildings, ~7,000 interfaces, 500 links) and times the
  reads the UI makes, so regressions show up as numbers rather than impressions.
- **Cold start.** Inventory, Map, Audit, Tools and Settings are `React.lazy` chunks
  behind a skeleton; the first paint loads only the shell, the lock screen and the
  Sessions view. Measured under Xvfb: ~1.25 s to an interactive lock screen warm,
  ~1.7 s with cold disk caches.
- **Many terminals.** WebKit allows ~16 WebGL contexts per page and drops the oldest
  beyond that, so each terminal gets WebGL only while it is among the 8 most recently
  shown (`terminal/gpuPool.ts`, LRU); the rest fall back to xterm's DOM renderer and
  are promoted again when shown. 30 local shells stay responsive; a switch costs
  ~0.1 s under software GL.
- **Audit filters at scale.** Migration 0008 adds expression indexes for the session
  id inside `details`, device, protocol and inventory entity names, each with the same
  `COLLATE NOCASE` the queries use. The device and protocol filters are a `UNION` of
  indexed lookups instead of an `OR` across columns, which SQLite would answer with a
  full scan; a test asserts the query plan has no `SCAN audit_log`.
- **Map layout off the main thread.** ELK runs in a worker (`elk-api` +
  `elk-worker.min.js?url`; CSP needs nothing new since workers fall back to
  `script-src 'self'`). Views with more than 80 nodes use Brandes–Köpf node placement
  instead of network simplex (300 nodes: 4.8 s → 1.4 s), and layers wider than 12
  nodes wrap into rows so a floor of 60 access switches stays readable. A status pill
  says "Arranging N devices…" while the first layout of a view runs; saved positions
  skip layout entirely.
- **Contrast as a test.** Each theme gains `--accent-text` (accent usable as text) and
  `--danger-solid` (a fill that white text reads on); `tokens.test.ts` checks WCAG AA
  for every text token on every background it sits on (4.5:1), the focus ring (3:1)
  and the text on accent/danger fills, in all six themes. Several light-theme colors
  were darkened to pass.
- **E2E via tauri-driver with a dependency-free client.** `e2e/webdriver.mjs` speaks
  W3C WebDriver with `fetch` (~110 lines) instead of pulling WebdriverIO's large
  dependency tree into the supply-chain audit. WebKitWebDriver reports empty text for
  some nested elements, so text lookups read `textContent` in the page. CI runs the
  smoke scenario against the release binary under `xvfb-run` (Linux only: there is no
  WKWebView WebDriver for Tauri on macOS) and uploads a screenshot per step.

## D-046 · Saved connections, per-tab colour schemes, rack and overview drawings (M10)

- **Saved connections are not devices.** A Quick Connect target can be saved under a
  name without entering the inventory: `saved_connections` stores the protocol's form
  as JSON (so new form fields need no migration; missing ones take their defaults) and
  an optional credential profile. Secrets are never part of it: the frontend drops the
  typed password and `core::saved` refuses settings with a password, passphrase or
  secret key (defence in depth). Deleting the profile keeps the connection
  (`ON DELETE SET NULL`).
- **Credentials resolved in Rust, as for devices.** `ssh_open`, `telnet_open`,
  `serial_open` and `rdp_open` take an optional `credential_id`. For SSH the profile's
  username fills an empty one, its key and password are tried first, then the form's
  own methods of other kinds (a key file is always kept), and its enable secret drives
  the login; Telnet and serial get the profile's full login; RDP gets its username and
  password. Without a profile the session prompts, exactly like Quick Connect.
- **Colour scheme per tab.** The tab stores an optional palette id that overrides its
  profile's on every restyle; "Use for new tabs" writes it to the profile. Settings →
  Terminal palette previews apply to the profile being edited (shared state with the
  profile editor; an unsaved draft is updated, not discarded).
- **The terminal fills its panel.** The pane around xterm keeps a few pixels of
  padding (so text never touches the rounded edge) but is painted with the terminal's
  own background. Before, the padding showed the app surface, so a dark scheme in a
  light app looked like a box inset in the window ("not aligned"). A colour change also
  repaints on the next frame, as the first repaint can still use the old colours.
- **Dialogs scroll.** `DialogContent` is capped at the window height with its own
  scroll, so long forms (Quick Connect with advanced SSH options) stay usable.
- **One rack drawing.** `RackElevation` (read-only, in Inventory → Locations) and the
  map's draggable rack view share units, rails and device faces.
- **Own minimap.** React Flow's minimap draws grey node boxes and no edges, which
  told nothing about a network. The overview draws links in their link colours,
  devices, buildings, zones and the visible area, from the same store, and pans the
  view on click or drag. Building names in it are drawing labels; tests ignore them
  for text queries.
- **Icons kept, polished.** The device icons keep their designs (a trial of
  network-diagram shapes was dropped at the user's request) but share one 3–21 grid
  and corner radius; the IP phone and access point were redrawn to read clearly.

## D-047 · Tabs that sit on the card, a menu behind "+", asset numbers (M11)

- **Tab and card are one shape.** The tab bar has no left inset, so the first tab
  starts at the card's edge, and the card's top-left corner is square while the first
  tab is active in Sessions. The active tab takes the colour of the session header
  below it. Header tints are translucent, so the tab draws the tint over the card
  surface (`tintOverSurface`) instead of over the darker bar; otherwise the two
  lavenders differ. Outside Sessions the card holds another view, so the active tab
  is drawn selected but detached.
- **"+" is for starting things.** It used to open the command palette, which was a
  surprise with the mouse. It now opens a New session menu (local shell, container
  shells from the action registry, each protocol's Quick Connect tab, the first saved
  connections); the palette has its own Search button with the shortcut in its tooltip.
- **Mouse paths for tab housekeeping:** context menu, drag to reorder (a
  `sessions.move` action; the drop side follows the pointer's half of the tab),
  middle-click and an always-visible close button on the active tab, double-click on
  the empty bar for a local shell.
- **Asset number** is a plain device column (migration 0010) rather than a custom field:
  it is common enough to deserve search, a table column and a place in the export.
