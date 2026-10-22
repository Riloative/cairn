# Cairn

A calm, keyboard-first SSH / Serial / Telnet / RDP client with a network
infrastructure inventory and map, for one network engineer on macOS (Apple Silicon)
and Ubuntu 24.04+. Fully local: no telemetry, no account, no network calls except the
connections you start.

- **Sessions:** SSH (jump hosts, agent, legacy algorithms, SFTP/SCP panel, port
  forwards), Telnet and reverse Telnet to console servers, serial consoles with
  Xmodem/Ymodem, RDP with NLA, and local shells. Vendor-aware highlighting, snippets,
  broadcast input to many tabs, auto-reconnect.
- **Inventory and map:** devices, interfaces, locations down to rack units, VLANs,
  credential profiles. Campus, building, floor and rack views with links, floor plans,
  and PNG/SVG/PDF export.
- **Tools:** config grab with snapshot history and diffs, a TFTP server.
- **Audit and data:** a tamper-evident audit log, session recordings with replay,
  encrypted backups, JSON/CSV export.

See [ROADMAP.md](ROADMAP.md) for what is done and [docs/SPEC.md](docs/SPEC.md) for the
design.

## Install

Download the latest `.dmg` or `.deb` from GitHub Releases (or from the artifacts of a
CI run). The builds are not signed.

### macOS (Apple Silicon)

1. Open the `.dmg` and drag Cairn to Applications.
2. The first time, macOS refuses to open an unsigned app downloaded from the internet.
   Either right-click Cairn in Applications → **Open** → **Open**, or run:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Cairn.app
   ```

   If macOS says the app "is damaged and can't be opened", it is the same quarantine
   flag; the command above removes it.

USB serial adapters: FTDI and Prolific chips work with the drivers built into macOS;
for CH340/CH341 adapters install the vendor's driver.

### Ubuntu 24.04+

```sh
sudo apt install ./Cairn_*.deb
```

For serial consoles, your user must be in the `dialout` group (once):

```sh
sudo usermod -aG dialout $USER
```

then log out and back in. Without it, opening `/dev/ttyUSB0` fails with "permission
denied". The external RDP client option uses FreeRDP 3 (`sudo apt install freerdp3-x11`).

## First run

Cairn asks for a **master password**. It encrypts everything Cairn stores (inventory,
credentials, keys, recordings, the audit log) with SQLCipher; the key is derived with
Argon2id. **There is no recovery:** a lost master password means lost data. Right
after setup Cairn offers an encrypted backup with its own password; make one, and
again from time to time (Settings → Backup, or `Ctrl/⌘ K` → "Create backup").

Coming from another computer? Choose **Restore from a backup** on the setup screen.

Press `Ctrl/⌘ K` for the command palette and `Ctrl/⌘ /` for all keyboard shortcuts.

## Where your data lives

| | |
|---|---|
| Linux | `~/.local/share/app.cairn.desktop/` |
| macOS | `~/Library/Application Support/app.cairn.desktop/` |

`cairn.db` is the encrypted database; `vault.json` holds the key-derivation parameters
(not secret). Optional plain-text session logs (Settings → Security) go to `logs/`
there. To start over, quit Cairn and delete the folder (make a backup first).

## Security in short

- Secrets (passwords, keys, enable secrets) stay in the Rust backend and the encrypted
  database; the interface only sees masked values. Revealing or copying one is
  audited, and copied passwords are cleared from the clipboard after 30 seconds.
- Cairn locks after 15 minutes idle (configurable) and when the computer sleeps.
- SSH host keys and RDP certificates are trusted on first use and pinned; a change
  shows a full-screen warning that needs typing `accept`.
- The audit log is a hash chain; Audit → Verify integrity checks it.

## Troubleshooting

- **Serial port "permission denied" (Linux):** join `dialout` (see above) and log in
  again.
- **"The host key has changed":** the device was replaced or re-keyed, or someone is in
  the middle. Compare the fingerprint with the device before accepting.
- **RDP refuses to sign in:** for domain accounts enter `DOMAIN\user`. Servers without
  NLA (some xrdp setups) need Security set to "TLS only" in the connection settings.
- **Old network gear rejects SSH:** enable the legacy algorithms the device needs in
  the connection's SSH settings (for example `diffie-hellman-group14-sha1`, `ssh-rsa`).

## Develop

Prerequisites: Rust (the version pinned in `rust-toolchain.toml`; rustup installs it), Node 22, and on Linux the packages in
`scripts/install-linux-deps.sh`.

```sh
npm ci
npm run tauri dev       # run the app
scripts/check.sh        # everything CI checks
```

`cargo run --release -p cairn-core --example seed_scale -- <vault dir>` (password on
stdin) fills a vault with 300 devices and 500 links and times the reads the UI makes.
See [CLAUDE.md](CLAUDE.md) for all build, lint and test commands.

## Licenses

Bundled fonts: Inter and JetBrains Mono, both under the SIL Open Font License 1.1
(`ui/public/licenses/`).
