#!/usr/bin/env bash
# Builds the Flatpak from the working tree and installs it for the current user.
#
# Everything that needs the network happens here, on the host: a clean copy of the
# tree gets its npm dependencies installed and its Rust crates vendored. flatpak-builder
# then compiles that copy with no network at all, so nothing inside its sandbox can
# stall on a download.
#
# Needs flatpak, flatpak-builder, git, node + npm and cargo on the host.
# Run it with: bash flatpak/build-local.sh   (then: flatpak run eu.akoos.photos)
#
# --bundle <file> writes a single-file bundle instead of installing: the file a release
# ships, which `flatpak install --user <file>` installs on any machine, fetching the
# runtime from Flathub.
#
# --devtools builds a diagnostic copy with WebKit's Web Inspector, opened at start with:
#   flatpak run --env=PFP_DEVTOOLS=1 eu.akoos.photos
# Never ship one: build again without the flag to go back.
#
# PFP_BUILD_JOBS=<n> caps the Rust compiler's parallel jobs, for a machine that runs out of
# memory compiling with one job per CPU thread (the build is then killed, exit code 137).
set -euo pipefail

bundle=""
devtools=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bundle) bundle="$(realpath -m "${2:?usage: $0 [--bundle <file.flatpak>] [--devtools]}")"; shift ;;
    --devtools) devtools=1 ;;
    *) echo "usage: $0 [--bundle <file.flatpak>] [--devtools]" >&2; exit 2 ;;
  esac
  shift
done
case "${PFP_BUILD_JOBS:-}" in
  "") ;;
  *[!0-9]* | 0*) echo "PFP_BUILD_JOBS must be a whole number above 0, not '${PFP_BUILD_JOBS}'" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
work="${PFP_FLATPAK_WORK:-$HOME/.cache/photosforproton-flatpak}"
src="$work/src"
manifest="$src/flatpak/eu.akoos.photos.yml"

for tool in flatpak flatpak-builder git node npm cargo; do
  command -v "$tool" >/dev/null || { echo "missing on PATH: $tool" >&2; exit 1; }
done

echo "==> Copying the working tree to $src"
rm -rf "$src"
mkdir -p "$src"
# Tracked files and new, not-ignored ones, as they are on disk: no build output and no
# node_modules, so nothing built for another platform comes along.
git -C "$root" ls-files -z --cached --others --exclude-standard \
  | tar -C "$root" --null --ignore-failed-read -T - -cf - \
  | tar -C "$src" -xf -

if [ -n "$devtools" ]; then
  echo "==> Diagnostic build: with the Web Inspector"
  sed -i 's#--features tauri/custom-protocol#--features tauri/custom-protocol --features devtools#' "$manifest"
fi
if [ -n "${PFP_BUILD_JOBS:-}" ]; then
  echo "==> Rust compiler capped at ${PFP_BUILD_JOBS} parallel jobs"
  sed -i "s#^    CARGO_NET_OFFLINE: 'true'\$#&\n    CARGO_BUILD_JOBS: '${PFP_BUILD_JOBS}'#" "$manifest"
fi

echo "==> Fetching the pinned ffmpeg sources"
# The app's own ffmpeg (ffmpeg/build.sh) is compiled inside the build, which has no network.
PFP_FFMPEG_WORK="$src/.ffmpeg-work" bash "$root/ffmpeg/build.sh" fetch

echo "==> Installing npm dependencies"
npm --prefix "$src/app" ci --no-audit --no-fund
npm --prefix "$src/sidecar" ci --no-audit --no-fund

echo "==> Vendoring Rust crates"
mkdir -p "$src/.cargo"
(cd "$src" && cargo vendor --locked --manifest-path app/src-tauri/Cargo.toml vendor) \
  > "$src/.cargo/config.toml"

if [ -n "$bundle" ]; then
  echo "==> Building the Flatpak (offline) into a bundle"
  rm -rf "$work/repo"
  flatpak-builder --user --force-clean --disable-rofiles-fuse \
    --install-deps-from=flathub \
    --state-dir="$work/state" --repo="$work/repo" \
    "$work/build" "$manifest"
  flatpak build-bundle --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
    "$work/repo" "$bundle" eu.akoos.photos
  echo "==> Wrote $bundle. Install it with: flatpak install --user $(basename "$bundle")"
  exit 0
fi

echo "==> Building and installing the Flatpak (offline)"
flatpak-builder --user --install --force-clean --disable-rofiles-fuse \
  --install-deps-from=flathub \
  --state-dir="$work/state" \
  "$work/build" "$manifest"


echo "==> Done. Start it with: flatpak run eu.akoos.photos"
