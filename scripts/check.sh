#!/usr/bin/env bash
# Run every check CI runs (except bundling). Fails on the first problem.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
echo "All checks passed."
