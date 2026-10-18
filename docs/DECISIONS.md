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
`object-src/frame-src 'none'`, and `freezePrototype: true`. `style-src` allows
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
