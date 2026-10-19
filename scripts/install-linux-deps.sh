#!/usr/bin/env bash
# System packages needed to build Cairn on Ubuntu 24.04.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev \
  libudev-dev libssl-dev pkg-config build-essential patchelf file
