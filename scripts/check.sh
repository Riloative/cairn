#!/usr/bin/env bash
# Run every check CI runs: frontend lint/format/typecheck/tests/build, Rust
# fmt/clippy/tests and the supply-chain audits. Fails on the first problem.
#
# Not included: bundling, the protocol integration tests that need local servers
# (scripts/test-sshd.sh, test-telnetd.sh, test-xrdp.sh), the Xvfb UI smoke test
# (scripts/ui-smoke.sh) and the WebDriver e2e smoke (e2e/smoke.mjs).
set -euo pipefail
cd "$(dirname "$0")/.."

# Supply-chain tools are optional locally (CI always has them): skip with a notice.
supply_chain() {
  if command -v cargo-deny >/dev/null 2>&1; then
    cargo deny check
  else
    echo "skipping cargo deny: not installed (cargo install cargo-deny)"
  fi
  if command -v cargo-audit >/dev/null 2>&1; then
    cargo audit
  else
    echo "skipping cargo audit: not installed (cargo install cargo-audit)"
  fi
}

npm audit --audit-level=high
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
supply_chain
echo "All checks passed."
