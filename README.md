# Cairn

A calm, keyboard-first SSH / Serial / Telnet / RDP client with a network
infrastructure inventory and map, for macOS (Apple Silicon) and Ubuntu 24.04+.
Fully local: no telemetry, no network calls except the connections you start.

> Status: early development. See [ROADMAP.md](ROADMAP.md) and [docs/SPEC.md](docs/SPEC.md).

## Install (unsigned builds)

Download the latest `.dmg` or `.deb` from GitHub Releases (or from the artifacts of a CI run).

- **macOS:** open the `.dmg` and drag Cairn to Applications. The build is not signed, so
  run `xattr -dr com.apple.quarantine /Applications/Cairn.app` or right-click → Open the
  first time.
- **Ubuntu:** `sudo apt install ./Cairn_*.deb`. For serial consoles, add yourself to the
  `dialout` group: `sudo usermod -aG dialout $USER`, then log out and back in.

## Develop

Prerequisites: Rust (stable), Node 22, and on Linux the packages in
`scripts/install-linux-deps.sh`.

```sh
npm ci
npm run tauri dev       # run the app
cargo test --workspace  # Rust tests (run `npm run build` once first)
npm test                # frontend tests
```

See [CLAUDE.md](CLAUDE.md) for the full list of build, lint and test commands.

## Licenses

Bundled fonts: Inter and JetBrains Mono, both under the SIL Open Font License 1.1
(`ui/public/licenses/`).
