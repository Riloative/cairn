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
