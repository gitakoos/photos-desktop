#!/usr/bin/env bash
# Builds the ffmpeg and ffprobe the app compresses videos with, for Windows, Linux and macOS, from
# the same pinned sources and with the same parts, so all of them give the same result.
#
# Only what a video upload and the video editor need goes in: reading MP4, MOV, MKV, AVI and
# MPEG-TS and the common music files; decoding the codecs phones and cameras write; scaling, the
# HDR to SDR tone map (zimg), the editor's crop, turn, colour, speed and audio filters; writing MP4,
# GIF and JPEG.
# Encoding runs on the graphics card (NVIDIA NVENC on both; Intel and AMD through Quick Sync and
# AMF on Windows, VA-API on Linux) or on the processor with x264. With x264 the result is under
# the GPL 2 or later; zimg is WTFPL, libvpl and the NVENC and AMF headers MIT.
#
# The macOS build leaves x264 and NVENC out and encodes with VideoToolbox, the encoder macOS
# carries for the Mac's own graphics hardware, so it is under the LGPL 2.1 or later. It also
# draws the picture a video or a HEIC still is uploaded with, so it has the JPEG encoder and the
# filters that turn a picture upright and put a HEIC's tiles together. It is one universal file
# for Apple silicon and Intel, built for macOS 13.5 and newer.
#
#   bash ffmpeg/build.sh fetch                 the sources only (the one step that needs network)
#   bash ffmpeg/build.sh windows [output dir]  ffmpeg.exe and ffprobe.exe, cross-compiled with
#                                              mingw-w64 (x86_64-w64-mingw32-gcc-posix)
#   bash ffmpeg/build.sh linux [output dir]    ffmpeg and ffprobe for this machine; needs libva
#   bash ffmpeg/build.sh macos [output dir]    ffmpeg and ffprobe for macOS, on a Mac with the
#                                              Xcode command line tools
#
# Needs git, make, cmake, nasm, pkg-config, autoconf, automake and libtool; Windows also ninja.
# The output dir defaults to app/src-tauri/binaries/ffmpeg-<target>.
set -euo pipefail

target="${1:?usage: $0 fetch | windows [output dir] | linux [output dir] | macos [output dir]}"
root="$(cd "$(dirname "$0")/.." && pwd)"
work="${PFP_FFMPEG_WORK:-$HOME/.cache/photosforproton-ffmpeg}"
src="$work/src"
jobs="$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

# name, repository, tag or branch, the commit it must point at.
sources=(
  "ffmpeg https://git.ffmpeg.org/ffmpeg.git n9.0.2 946fcce07b6dcd0331c8cc609192aeff5e1924f8"
  "x264 https://code.videolan.org/videolan/x264.git stable b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
  "zimg https://github.com/sekrit-twc/zimg.git release-3.0.6 f819b14e8f39d1282400b0d9543e8ef73c1b2bbd"
  "nv-codec-headers https://git.videolan.org/git/ffmpeg/nv-codec-headers.git n13.0.19.0 e844e5b26f46bb77479f063029595293aa8f812d"
  "amf https://github.com/GPUOpen-LibrariesAndSDKs/AMF.git v1.5.3 57ee0cfb0e1a08d9041f77435653794c1b012be0"
  "libvpl https://github.com/intel/libvpl.git v2.17.0 d77f9195cf495b937631607333288fd917ae8939"
)

# Each source, once checked, carries its commit in .pfp-commit: a copy made without its .git
# folder (the Flatpak build gets one) is checked against that instead.
fetch() {
  echo "==> The pinned sources in $src"
  mkdir -p "$src"
  for entry in "${sources[@]}"; do
    read -r name url ref commit <<<"$entry"
    dir="$src/$name"
    if [ ! -d "$dir/.git" ] && [ -f "$dir/.pfp-commit" ]; then
      got="$(cat "$dir/.pfp-commit")"
      [ "$got" = "$commit" ] || { echo "$name is $got, expected $commit" >&2; exit 1; }
      echo "    $name $ref $commit"
      continue
    fi
    need git
    if [ ! -d "$dir/.git" ]; then
      if [ "$name" = amf ]; then
        # The AMF repository carries gigabytes of samples and binaries; only its headers are used.
        git clone -q --depth 1 --filter=blob:none --sparse --branch "$ref" "$url" "$dir"
        git -C "$dir" sparse-checkout set amf/public/include
      else
        git -c advice.detachedHead=false clone -q --depth 1 --branch "$ref" "$url" "$dir"
      fi
    fi
    got="$(git -C "$dir" rev-parse HEAD)"
    [ "$got" = "$commit" ] || { echo "$name $ref is $got, expected $commit" >&2; exit 1; }
    echo "$commit" >"$dir/.pfp-commit"
    echo "    $name $ref $commit"
  done
}

need() {
  for tool in "$@"; do
    command -v "$tool" >/dev/null || { echo "missing on PATH: $tool" >&2; exit 1; }
  done
}

# The oldest macOS the app runs on, which every macOS object here is built for.
macos_min=13.5

case "$target" in
  fetch) fetch; exit 0 ;;
  windows) need make cmake ninja nasm pkg-config autoreconf x86_64-w64-mingw32-gcc-posix ;;
  linux) need make nasm pkg-config autoreconf cc ;;
  macos)
    # One build per architecture, each by this script, then one file of the two.
    need lipo codesign
    out="${2:-$root/app/src-tauri/binaries/ffmpeg-macos}"
    for arch in arm64 x86_64; do
      bash "$0" "macos-$arch" "$work/out-macos-$arch"
    done
    mkdir -p "$out"
    for name in ffmpeg ffprobe; do
      lipo -create -output "$out/$name" "$work/out-macos-arm64/$name" "$work/out-macos-x86_64/$name"
      # Apple silicon runs only signed code; this is the ad-hoc signature the linker gives, made
      # again over the joined file.
      codesign --force --sign - "$out/$name"
    done
    cp "$work/out-macos-arm64/FFMPEG-LICENSE.txt" "$out/FFMPEG-LICENSE.txt"
    echo "==> Wrote $out"
    ls -l "$out"
    lipo -info "$out/ffmpeg"
    exit 0
    ;;
  macos-arm64 | macos-x86_64) need make nasm pkg-config autoreconf clang ;;
  *) echo "unknown target: $target" >&2; exit 2 ;;
esac

out="${2:-$root/app/src-tauri/binaries/ffmpeg-$target}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
prefix="$work/prefix-$target"
fetch
rm -rf "$prefix"
mkdir -p "$prefix/include" "$prefix/lib/pkgconfig"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

mac_arch=""
case "$target" in macos-*) mac_arch="${target#macos-}" ;; esac

if [ "$target" = windows ]; then
  host=x86_64-w64-mingw32
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
  export CC="$host-gcc-posix" CXX="$host-g++-posix"
  host_args=(--host="$host")
  x264_args=(--host="$host" --cross-prefix="$host-")
elif [ -n "$mac_arch" ]; then
  # Only what is built here is looked for, never a library Homebrew put on the machine.
  export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
  export MACOSX_DEPLOYMENT_TARGET="$macos_min"
  export CC="clang -arch $mac_arch -mmacosx-version-min=$macos_min"
  export CXX="clang++ -arch $mac_arch -mmacosx-version-min=$macos_min"
  # zimg links against libc++ here, not the libstdc++ its pkg-config file names by default.
  export STL_LIBS=-lc++
  # Homebrew's libtool names its tool glibtoolize, which zimg's autogen.sh has to be told.
  if command -v glibtoolize >/dev/null; then export LIBTOOLIZE=glibtoolize; fi
  host_args=(--host="${mac_arch/arm64/aarch64}-apple-darwin")
  x264_args=()
else
  export CC="${CC:-cc}" CXX="${CXX:-c++}"
  host_args=()
  x264_args=()
fi

echo "==> zimg"
(
  cd "$src/zimg"
  [ ! -d .git ] || git clean -qfdx -e .pfp-commit
  ./autogen.sh >/dev/null
  ./configure -q "${host_args[@]}" --prefix="$prefix" --enable-static --disable-shared --with-pic
  make -s -j"$jobs"
  make -s install
)

# x264 and the NVENC headers: not in the macOS build.
if [ -z "$mac_arch" ]; then
  echo "==> x264"
  (
    cd "$src/x264"
    [ ! -d .git ] || git clean -qfdx -e .pfp-commit
    ./configure "${x264_args[@]}" --prefix="$prefix" --enable-static --enable-pic --disable-cli --disable-opencl >/dev/null
    make -s -j"$jobs"
    make -s install
  )

  echo "==> NVENC headers"
  make -s -C "$src/nv-codec-headers" PREFIX="$prefix" install
fi

if [ "$target" = windows ]; then
  echo "==> AMF headers and libvpl"
  cp -r "$src/amf/amf/public/include" "$prefix/include/AMF"
  rm -rf "$work/build-libvpl"
  cmake -S "$src/libvpl" -B "$work/build-libvpl" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_SYSTEM_NAME=Windows -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
    -DCMAKE_RC_COMPILER="$host-windres" -DCMAKE_INSTALL_PREFIX="$prefix" \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF -DINSTALL_EXAMPLES=OFF \
    -DBUILD_EXPERIMENTAL=OFF >/dev/null
  cmake --build "$work/build-libvpl" >/dev/null
  cmake --install "$work/build-libvpl" >/dev/null
fi

# The same parts on every system: only the way to the graphics card differs, and macOS has no
# x264 and no NVENC.
filters=scale,zscale,tonemap,format,hwupload,null,anull,aresample,aformat,testsrc2,setsar,fps,crop,transpose,hflip,vflip,eq,hue,colorbalance,colorchannelmixer,setpts,asetpts,atrim,atempo,volume,afade,amix,apad,split,hstack,palettegen,paletteuse
if [ -n "$mac_arch" ]; then
  libraries=(--enable-libzimg)
else
  libraries=(--enable-gpl --enable-libx264 --enable-libzimg --enable-ffnvcodec --enable-nvenc)
fi
common=(
  "${libraries[@]}"
  --enable-static --disable-shared --disable-debug --disable-doc --disable-network
  --disable-autodetect --disable-everything --disable-programs --enable-ffmpeg --enable-ffprobe
  --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,avi,mpegts,mp3,aac,wav,flac,ogg,asf
  --enable-muxer=mp4,mov,null,gif,mjpeg
  --enable-indev=lavfi
  --enable-decoder=wrapped_avframe,rawvideo,h264,hevc,av1,mpeg4,h263,vp8,vp9,mjpeg,prores,aac,aac_latm,alac,mp3,mp3float,ac3,eac3,flac,amrnb,amrwb,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_f32le,pcm_u8,vorbis,opus,wmav1,wmav2
  --enable-parser=h264,hevc,av1,vp8,vp9,mpeg4video,aac,ac3,flac,mjpeg,mpegaudio,opus,vorbis
  --enable-bsf=aac_adtstoasc,extract_extradata,h264_mp4toannexb,hevc_mp4toannexb
  --enable-filter="$filters"
)
encoders=aac,wrapped_avframe,libx264,h264_nvenc,hevc_nvenc,av1_nvenc,gif,mjpeg
if [ "$target" = windows ]; then
  platform=(
    --target-os=mingw32 --arch=x86_64 --enable-cross-compile --cross-prefix="$host-"
    --cc="$CC" --cxx="$CXX" --pkg-config=pkg-config --pkg-config-flags=--static
    --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib -static -static-libgcc -static-libstdc++"
    --extra-libs="-lstdc++" --enable-w32threads --enable-amf --enable-libvpl --enable-d3d11va --enable-dxva2
    --enable-encoder="$encoders,h264_amf,hevc_amf,av1_amf,h264_qsv,hevc_qsv,av1_qsv"
  )
  exe=.exe
elif [ -n "$mac_arch" ]; then
  platform=(
    --target-os=darwin --arch="$mac_arch" --enable-cross-compile
    --cc="$CC" --cxx="$CXX" --pkg-config=pkg-config --pkg-config-flags=--static
    --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" --extra-libs="-lc++"
    --enable-pthreads --enable-videotoolbox
    --enable-encoder=aac,wrapped_avframe,h264_videotoolbox,hevc_videotoolbox,gif,mjpeg
    --enable-filter="$filters,rotate,xstack"
  )
  exe=
else
  platform=(
    --cc="$CC" --cxx="$CXX" --pkg-config-flags=--static
    --extra-cflags="-I$prefix/include" --extra-ldflags="-L$prefix/lib" --extra-libs="-lstdc++ -lm"
    --enable-pthreads --enable-vaapi --enable-libdrm
    --enable-encoder="$encoders,h264_vaapi,hevc_vaapi,av1_vaapi"
  )
  exe=
fi

echo "==> ffmpeg ($target)"
build="$work/build-ffmpeg-$target"
rm -rf "$build"
mkdir -p "$build"
(
  cd "$build"
  "$src/ffmpeg/configure" --prefix="$build/install" "${common[@]}" "${platform[@]}" >/dev/null
  make -s -j"$jobs"
)

mkdir -p "$out"
strip=strip
[ "$target" = windows ] && strip="$host-strip"
for name in ffmpeg ffprobe; do
  "$strip" -o "$out/$name$exe" "$build/$name$exe"
done
if [ -n "$mac_arch" ]; then
  cp "$src/ffmpeg/COPYING.LGPLv2.1" "$out/FFMPEG-LICENSE.txt"
else
  cp "$src/ffmpeg/COPYING.GPLv2" "$out/FFMPEG-LICENSE.txt"
fi
echo "==> Wrote $out"
ls -l "$out"
