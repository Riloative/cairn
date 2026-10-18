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
