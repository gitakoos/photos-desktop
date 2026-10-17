/*
 * Photos for Proton
 * Copyright (C) 2026 Akoos <https://akoos.eu>
 *
 * Source:  https://github.com/gitakoos/photos-desktop
 * Website: https://www.photosforproton.eu
 *
 * This file is part of Photos for Proton.
 *
 * Photos for Proton is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

// A picture of a file the sidecar's own thumbnailer cannot open.
//
// The upload makes its two thumbnails with sharp, which is a still-image library: handed
// a video it can do nothing, so every video reached Proton with no thumbnail at all and
// showed as a blank tile in every client that reads the stored one. The web client looks
// fine because it decodes the video itself, which is why this went unnoticed.
//
// The frame is asked of Windows rather than decoded here, the same trade `local_file`
// already makes for HEIC: whatever the machine can open, this can use, and whatever it
// cannot is reported as nothing rather than answered by a decoder shipped in this app.
// `IShellItemImageFactory` is the way in, so what gets uploaded is the picture Explorer
// itself shows for that file, which also makes the result predictable to the person who
// dragged it in.
//
// Media Foundation was the alternative and was not taken. It would allow seeking past a
// black opening frame, which the shell cannot do, but it reaches only its own registered
// decoders, where the shell also honours whatever thumbnail providers the machine has, so
// it covers strictly less. It is several hundred lines of unsafe against forty, and it
// would answer differently from Explorer for the same file. If black opening frames turn
// out to be a real problem in practice, that is the moment to reach for it, and this
// module is where it would go.
//
// Why the host and not the sidecar: the RPC channel runs one way, host to sidecar, one
// request at a time. Rather than reverse it, the frontend asks for the frames before it
// asks for the upload and passes them along with it, so Windows-specific code stays in
// Rust, Proton-specific code stays in the sidecar, and no new channel exists.
//
// Off Windows the same two answers come from GStreamer, the framework a Linux desktop
// already plays these files with; inside the Flatpak that is the runtime's copy and the
// decoders it and its codecs extension carry. The trade is the same one: nothing is
// decoded by code shipped here, and a file the machine cannot play gets no frame. Unlike
// the shell, GStreamer can seek, so the picture is taken a moment in rather than from an
// opening frame that is often black. The three stills come from the runtime too: HEIC and
// HEIF from its libheif, whose FFmpeg plugin decodes the HEVC in them once the codecs
// extension is present, and DNG from the JPEG preview every DNG embeds for exactly this.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::local_file;

/// The staging folder, a sibling of the viewer's own rather than the same one: `pfp-view`
/// is the single folder the webview's asset protocol is scoped to, and a frame has no
/// business being reachable from there. Swept at startup by `reap_temp_leftovers`.
pub(crate) const FRAME_DIR: &str = "pfp-frame";

/// What Windows knows about one file that this app cannot work out for itself.
///
/// A duration exists only once something has opened the container, and no decoder ships
/// here, so this is the same trade the frame above makes: ask the shell, and report
/// nothing rather than guess when the machine cannot answer.
///
/// Every field is optional and absence is the honest answer. A zero is never written in
/// place of a missing value, because a zero reads downstream as a real measurement: a
/// video would claim to be no time long rather than of unknown length.
#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    width: Option<u32>,
    height: Option<u32>,
    /// SECONDS, fractional. Drive stores this unit and the readers here scale it by a
    /// thousand, so anything else is a 1000x error in whatever displays it.
    duration_sec: Option<f64>,
}

impl MediaInfo {
    fn is_empty(&self) -> bool {
        self.width.is_none() && self.height.is_none() && self.duration_sec.is_none()
    }
}

/// What one call yields: the pictures, and what the shell knew about the same files.
///
/// Both come off a single shell item per file, so the metadata costs no extra pass and
/// no second round of shell extensions.
#[derive(Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FramePrep {
    frames: HashMap<String, String>,
    media: HashMap<String, MediaInfo>,
}

/// `System.Media.Duration` counts 100-nanosecond units. Drive's `Media.Duration` is in
/// SECONDS, so this is the one conversion that matters: taking the raw value for
/// milliseconds renders a clip a ten-thousandth of its length, and this project has
/// already paid for a 1000x mistake in this exact field once.
///
/// A zero means the shell had no answer, which is not a duration of nothing.
/// Rounded to the millisecond, which is every bit of precision anything here displays.
fn duration_seconds(hundred_ns: u64) -> Option<f64> {
    if hundred_ns == 0 {
        return None;
    }
    Some((hundred_ns as f64 / 10_000.0).round() / 1_000.0)
}

/// The extensions worth asking Windows about.
///
/// The sidecar's own tables are the authority here, not this list: these are exactly the
/// types it accepts for upload and cannot open itself, which is every video it takes
/// plus the three stills sharp has no decoder for. That makes it the right list for the
/// metadata too: the files sharp can decode have their dimensions read off the decode
/// the sidecar already does, and only these need asking about. Drift is not dangerous in
/// either direction, which is why one list can be kept here rather than plumbed across
/// the channel: a type named here that the sidecar will not upload costs one wasted frame
/// that the sweep collects, and one missing from here uploads with no thumbnail.
const NEEDS_WINDOWS_FRAME: &[&str] = &[
    // Video, all of it: sharp decodes stills only.
    "mp4", "mov", "m4v", "webm", "mkv", "3gp",
    // Stills sharp cannot decode either, which had the same blank tile for the same
    // reason and are fixed by the same call.
    "heic", "heif", "dng",
];

/// The longest edge asked of Windows.
///
/// The larger of the two thumbnails the upload makes is 1920, so carrying more pixels
/// than this to the resize buys nothing. It is a ceiling and never a stretch: the flag
/// that would scale a small picture up is deliberately not passed, so a file whose only
/// stored thumbnail is smaller comes back at its own size rather than blurred up to this.
const FRAME_EDGE: i32 = 1920;

/// How many frames are pulled at once.
///
/// Also the memory ceiling, and that is the reason for a bound rather than a thread per
/// file: each worker holds one decoded bitmap while it encodes, so a drop of two hundred
/// videos costs four of those at a time and not two hundred. Extraction is mostly waiting
/// on a decoder, so a handful of threads shortens a large drop considerably and more would
/// only contend.
const FRAME_WORKERS: usize = 4;

/// Whether Windows should be asked for a picture of this one.
fn needs_windows_frame(ext: &str) -> bool {
    NEEDS_WINDOWS_FRAME.contains(&ext)
}

/// One file to fetch a frame for.
struct FrameJob {
    /// The path the sidecar will know this file by, which is the dropped spelling rather
    /// than the resolved one. The two can differ in case, and the map is looked up by
    /// what the sidecar has in hand.
    key: String,
    /// The same file, resolved and vetted, which is what actually gets read.
    src: PathBuf,
    /// Where the JPEG goes.
    dest: PathBuf,
}

fn frame_dir() -> PathBuf {
    std::env::temp_dir().join(FRAME_DIR)
}

/// A name no other staged frame can collide with, from the same source of randomness the
/// store's keys come from.
fn frame_name() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut raw = [0u8; 16];
    aes_gcm::aead::OsRng.fill_bytes(&mut raw);
    let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    format!("frame-{hex}.jpg")
}

/// How deep into a dropped folder the walk goes: the sidecar's own bound in `walkMedia`.
const MAX_FOLDER_DEPTH: usize = 24;

/// Every dropped path that wants a frame, the files anywhere inside a dropped folder
/// included.
///
/// A folder becomes one album and everything under it uploads into that album, so a mixed
/// folder has to yield its videos here while its photos are left to sharp. The walk is the
/// sidecar's own (`walkMedia`): into sub-folders, never along a symbolic link, at most
/// `MAX_FOLDER_DEPTH` levels down. Walking less than the sidecar uploads is how a video in
/// a sub-folder went up without a thumbnail.
///
/// The spelling is what matters as much as the set. A folder's files are joined the way
/// the sidecar joins them, onto the dropped path exactly as it was given, so that the key
/// this produces is the path the sidecar will be holding when it looks one up.
fn frame_candidates(paths: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for path in paths {
        let Ok(info) = std::fs::metadata(path) else {
            continue;
        };
        if info.is_dir() {
            collect_folder_candidates(Path::new(path), 0, &mut out);
        } else if needs_windows_frame(&local_file::extension_of(path)) {
            out.push(path.clone());
        }
    }
    out
}

/// One folder's share of `frame_candidates`. The entry's own type is read rather than the
/// file's metadata, which neither follows a link nor opens anything.
fn collect_folder_candidates(dir: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_FOLDER_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name();
        let full = dir.join(&name);
        if kind.is_dir() {
            collect_folder_candidates(&full, depth + 1, out);
        } else if kind.is_file() && needs_windows_frame(&local_file::extension_of(&name.to_string_lossy())) {
            out.push(full.to_string_lossy().into_owned());
        }
    }
}

/// The candidates that survive the same vetting every other caller-named path here gets,
/// each with the staged file it will be written to.
fn plan_frames(app: &AppHandle, paths: &[String]) -> Vec<FrameJob> {
    let dir = frame_dir();
    frame_candidates(paths)
        .into_iter()
        .filter_map(|key| {
            let src = local_file::checked_media_path(app, &key).ok()?;
            Some(FrameJob {
                key,
                // The shell parses a path rather than opening one, and it does not
                // understand the verbatim prefix canonicalising leaves behind.
                src: crate::strip_verbatim(src),
                dest: dir.join(frame_name()),
            })
        })
        .collect()
}

/// The shell's handle on one file, which both the picture and the properties come off.
///
/// `IShellItem2` rather than `IShellItemImageFactory` because it is the one that answers
/// properties; the imaging interface is cast from it below. The same underlying item
/// serves both, so a file is parsed and bound once however much is asked of it.
#[cfg(windows)]
fn shell_item(src: &Path) -> Result<windows::Win32::UI::Shell::IShellItem2, String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::SHCreateItemFromParsingName;

    unsafe {
        SHCreateItemFromParsingName(&HSTRING::from(src), None)
            .map_err(|_| "the shell does not recognise this file".to_string())
    }
}

/// The property keys read below, which the `windows` crate does not generate: `propkey.h`
/// defines them as macros, so they are written out here. The formats are Windows' own
/// long-standing ones (Media, Video and Image), and the pids are the documented members.
#[cfg(windows)]
mod pkey {
    use windows::core::GUID;
    use windows::Win32::Foundation::PROPERTYKEY;

    const FMTID_MEDIA: GUID = GUID::from_u128(0x64440490_4C8B_11D1_8B70_080036B11A03);
    const FMTID_VIDEO: GUID = GUID::from_u128(0x64440491_4C8B_11D1_8B70_080036B11A03);
    const FMTID_IMAGE: GUID = GUID::from_u128(0x6444048F_4C8B_11D1_8B70_080036B11A03);

    /// System.Media.Duration, in 100-nanosecond units.
    pub const MEDIA_DURATION: PROPERTYKEY = PROPERTYKEY { fmtid: FMTID_MEDIA, pid: 3 };
    /// System.Video.FrameWidth / FrameHeight, in pixels.
    pub const VIDEO_WIDTH: PROPERTYKEY = PROPERTYKEY { fmtid: FMTID_VIDEO, pid: 3 };
    pub const VIDEO_HEIGHT: PROPERTYKEY = PROPERTYKEY { fmtid: FMTID_VIDEO, pid: 4 };
    /// System.Image.HorizontalSize / VerticalSize, in pixels.
    pub const IMAGE_WIDTH: PROPERTYKEY = PROPERTYKEY { fmtid: FMTID_IMAGE, pid: 3 };
    pub const IMAGE_HEIGHT: PROPERTYKEY = PROPERTYKEY { fmtid: FMTID_IMAGE, pid: 4 };
}

/// What the shell can say about one file's media, as far as it knows anything.
///
/// Every read is allowed to fail on its own: a machine with no decoder for this container
/// answers nothing, an audio file has no frame size, and a still has no duration. None of
/// those is an error, and none of them stops the others being asked.
///
/// The video frame size is asked for first and the image size second, because a file here
/// is either a video or one of the three stills sharp cannot decode, and the two property
/// sets do not overlap. The shell reports both as already-oriented display dimensions,
/// which is what has to be stored: a photo turned by its EXIF tag must report the turned
/// size or it will not match what the viewer draws.
#[cfg(windows)]
fn probe_media(item: &windows::Win32::UI::Shell::IShellItem2) -> MediaInfo {
    let mut info = MediaInfo::default();
    unsafe {
        info.duration_sec = item
            .GetUInt64(&pkey::MEDIA_DURATION)
            .ok()
            .and_then(duration_seconds);

        let dimension = |key| item.GetUInt32(key).ok().filter(|px| *px > 0);
        info.width = dimension(&pkey::VIDEO_WIDTH).or_else(|| dimension(&pkey::IMAGE_WIDTH));
        info.height = dimension(&pkey::VIDEO_HEIGHT).or_else(|| dimension(&pkey::IMAGE_HEIGHT));
    }
    // A pair is worth nothing by halves: whatever writes these needs both edges, and one
    // alone would be recorded as a dimension the file does not have.
    if info.width.is_none() || info.height.is_none() {
        info.width = None;
        info.height = None;
    }
    info
}

/// Ask the shell for one file's picture and write it out as a JPEG.
#[cfg(windows)]
fn grab_one(
    factory: &windows::Win32::Graphics::Imaging::IWICImagingFactory,
    item: &windows::Win32::UI::Shell::IShellItem2,
    dest: &Path,
) -> Result<(), String> {
    use windows::core::Interface;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HPALETTE};
    use windows::Win32::Graphics::Imaging::{IWICBitmapSource, WICBitmapIgnoreAlpha};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SIIGBF_THUMBNAILONLY};

    unsafe {
        let item: IShellItemImageFactory = item
            .cast()
            .map_err(|_| "the shell offers no picture of this file".to_string())?;

        // THUMBNAILONLY is the whole guard against the thing that would otherwise make
        // this worse than useless: without it a file the machine cannot decode comes back
        // as the generic icon for its type, and that icon would upload as the photo's
        // thumbnail and look deliberate. With it, no real picture is an error, and an
        // error is a file that uploads exactly as it does today.
        //
        // A cached picture is welcome and is usually what arrives, because the folder was
        // just been browsed to find these files. It is not a lesser answer: the cache
        // holds what the same extractor produced for the same unchanged bytes.
        let bitmap = item
            .GetImage(SIZE { cx: FRAME_EDGE, cy: FRAME_EDGE }, SIIGBF_THUMBNAILONLY)
            .map_err(|_| "windows has no picture for this file".to_string())?;

        let encoded = (|| {
            // Alpha ignored rather than used: a shell thumbnail is opaque, but some
            // providers hand back a zeroed alpha channel they never meant as
            // transparency, and honouring that would composite the whole frame away to
            // black. The encoder drops the channel a line later regardless.
            let source: IWICBitmapSource = factory
                .CreateBitmapFromHBITMAP(bitmap, HPALETTE(std::ptr::null_mut()), WICBitmapIgnoreAlpha)
                .map_err(|_| "that picture could not be read".to_string())?
                .cast()
                .map_err(|_| "that picture could not be read".to_string())?;
            // Not turned upright on the way through, unlike the viewer's decode: the
            // shell applies orientation itself, so the picture arrives the right way up
            // and rotating it again would lay it on its side.
            local_file::encode_jpeg(factory, &source, dest)
        })();

        let _ = DeleteObject(bitmap.into());
        encoded
    }
}

/// One worker's share. COM is set up once for the thread rather than once per file, and
/// so is the imaging factory.
///
/// The thread is this module's own rather than one borrowed from the runtime's blocking
/// pool, and that is deliberate: a fresh thread has no apartment yet, so it can be put in
/// the single-threaded one that shell extensions expect. A pooled thread may already have
/// been placed in the multi-threaded apartment by an earlier decode, which never undoes
/// its own initialisation, and every thumbnail provider on the machine would then be
/// marshalled across apartments for no reason.
#[cfg(windows)]
fn grab_chunk(jobs: &[FrameJob], out: &mut [(bool, MediaInfo)]) {
    use windows::Win32::Foundation::RPC_E_CHANGED_MODE;
    use windows::Win32::Graphics::Imaging::{CLSID_WICImagingFactory, IWICImagingFactory};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
    if hr.is_err() && hr != RPC_E_CHANGED_MODE {
        return;
    }

    let factory: Result<IWICImagingFactory, _> =
        unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) };
    if let Ok(factory) = factory {
        for (job, (made, info)) in jobs.iter().zip(out.iter_mut()) {
            let Ok(item) = shell_item(&job.src) else {
                continue;
            };
            // Asked for first and kept whatever the picture does: the two answers are
            // independent, and a container the machine can describe but not draw still
            // knows how long it is.
            *info = probe_media(&item);
            *made = grab_one(&factory, &item, &job.dest).is_ok();
            if !*made {
                // A half-written file would otherwise sit in the folder until the next
                // start, and the sidecar would hand sharp a truncated JPEG.
                let _ = std::fs::remove_file(&job.dest);
            }
        }
    }

    // Owned here, unlike the viewer's decode, because this thread is about to end and
    // nothing else will ever run on it.
    if hr.is_ok() {
        unsafe { CoUninitialize() };
    }
}

/// Which jobs produced a file and what the shell said about each, in the order given.
#[cfg(windows)]
fn run_jobs(jobs: &[FrameJob]) -> Vec<(bool, MediaInfo)> {
    // `chunks` panics on a zero size, which is what an empty job list would compute.
    if jobs.is_empty() {
        return Vec::new();
    }
    let mut out = vec![(false, MediaInfo::default()); jobs.len()];
    let chunk = jobs.len().div_ceil(FRAME_WORKERS.min(jobs.len()).max(1));
    std::thread::scope(|scope| {
        for (jobs, out) in jobs.chunks(chunk).zip(out.chunks_mut(chunk)) {
            scope.spawn(move || grab_chunk(jobs, out));
        }
    });
    out
}

/// The same workers off Windows, under the same bound on how many files are decoded at
/// once: a video asked of GStreamer, and each of the three stills of its own decoder.
#[cfg(not(windows))]
fn run_jobs(jobs: &[FrameJob]) -> Vec<(bool, MediaInfo)> {
    let mut out = vec![(false, MediaInfo::default()); jobs.len()];
    if jobs.is_empty() {
        return out;
    }
    // No GStreamer at all is the machine with no video decoder: its videos upload as they
    // always have, and the stills do not need it.
    let videos = gstreamer::init().is_ok();
    let chunk = jobs.len().div_ceil(FRAME_WORKERS.min(jobs.len()).max(1));
    std::thread::scope(|scope| {
        for (jobs, out) in jobs.chunks(chunk).zip(out.chunks_mut(chunk)) {
            scope.spawn(move || {
                for (job, slot) in jobs.iter().zip(out.iter_mut()) {
                    *slot = match local_file::extension_of(&job.src.to_string_lossy()).as_str() {
                        "heic" | "heif" => still_media::heif(&job.src, &job.dest),
                        "dng" => still_media::dng(&job.src, &job.dest),
                        _ if videos => gst_media::frame(&job.src, &job.dest),
                        _ => (false, MediaInfo::default()),
                    };
                    if !slot.0 {
                        let _ = std::fs::remove_file(&job.dest);
                    }
                }
            });
        }
    });
    out
}

/// What GStreamer can say about one file, and the picture it can draw of it.
#[cfg(not(windows))]
mod gst_media {
    use std::path::Path;

    use gstreamer as gst;
    use gstreamer::prelude::*;
    use gstreamer_app::AppSink;
    use gstreamer_pbutils::prelude::*;
    use gstreamer_pbutils::{Discoverer, DiscovererResult};

    use super::{duration_seconds, quarter_turned, MediaInfo};

    /// The longest any one step on one file may take. A file that stalls its decoder is
    /// given up on like one with no decoder, so one bad clip cannot hold up a whole drop.
    const STEP: gst::ClockTime = gst::ClockTime::from_seconds(15);

    /// Where the picture is taken: a tenth of the way in, never later than a second. Past
    /// the black of a fade-in, and still the opening shot.
    const PICTURE_AT_MOST: gst::ClockTime = gst::ClockTime::from_seconds(1);

    /// A video's picture and description. Described first and kept whatever the picture
    /// does, as on Windows: a container the machine cannot draw still knows how long it is.
    pub fn frame(src: &Path, dest: &Path) -> (bool, MediaInfo) {
        let Ok(uri) = gst::glib::filename_to_uri(src, None) else {
            return (false, MediaInfo::default());
        };
        let (info, drawable) = probe(&uri);
        (drawable && grab(&uri, dest).is_ok(), info)
    }

    /// The file's length and display size, and whether it has a video stream this machine
    /// can decode, which decides whether a picture is worth asking for at all.
    pub fn probe(uri: &str) -> (MediaInfo, bool) {
        let mut info = MediaInfo::default();
        let Ok(discoverer) = Discoverer::new(STEP) else {
            return (info, false);
        };
        let Ok(found) = discoverer.discover_uri(uri) else {
            return (info, false);
        };
        // GStreamer counts nanoseconds, a hundred to the shell's unit, so the one
        // conversion and its rounding are shared rather than written twice.
        info.duration_sec = found
            .duration()
            .and_then(|d| duration_seconds(d.nseconds() / 100));
        let Some(video) = found.video_streams().into_iter().next() else {
            return (info, false);
        };
        let (width, height) = (video.width(), video.height());
        if width > 0 && height > 0 {
            let tags = video.tags().or_else(|| found.tags());
            let turned = tags
                .as_ref()
                .and_then(|t| t.get::<gst::tags::ImageOrientation>())
                .is_some_and(|o| quarter_turned(o.get()));
            let (width, height) = if turned { (height, width) } else { (width, height) };
            info.width = Some(width);
            info.height = Some(height);
        }
        (info, found.result() == DiscovererResult::Ok)
    }

    /// Decode one picture and write it to `dest` as a JPEG, turned upright.
    pub fn grab(uri: &str, dest: &Path) -> Result<(), String> {
        // The sound is left unlinked on purpose: decodebin fails only when no stream at
        // all is linked, and decoding audio would cost time for nothing.
        let pipeline = gst::parse_launch(
            "uridecodebin name=src ! videoconvert ! videoflip video-direction=auto ! \
             videoconvert ! jpegenc ! appsink name=sink sync=false max-buffers=1",
        )
        .map_err(|e| e.to_string())?
        .downcast::<gst::Pipeline>()
        .map_err(|_| "not a pipeline".to_string())?;
        let _stop = Stopped(&pipeline);
        pipeline.by_name("src").ok_or("no source")?.set_property("uri", uri);
        let sink = pipeline
            .by_name("sink")
            .and_then(|e| e.downcast::<AppSink>().ok())
            .ok_or("no sink")?;
        let bus = pipeline.bus().ok_or("no bus")?;

        pipeline.set_state(gst::State::Paused).map_err(|e| e.to_string())?;
        settle(&bus)?;
        if let Some(length) = pipeline.query_duration::<gst::ClockTime>() {
            let at = gst::ClockTime::from_nseconds(length.nseconds() / 10).min(PICTURE_AT_MOST);
            // A seek that is refused leaves the opening frame, which is still a picture.
            if at > gst::ClockTime::ZERO
                && pipeline
                    .seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::KEY_UNIT, at)
                    .is_ok()
            {
                settle(&bus)?;
            }
        }
        let sample = sink.try_pull_preroll(STEP).ok_or("no picture")?;
        let buffer = sample.buffer().ok_or("no picture")?;
        let bytes = buffer.map_readable().map_err(|e| e.to_string())?;
        std::fs::write(dest, bytes.as_slice()).map_err(|e| e.to_string())
    }

    /// Wait for the pipeline to finish prerolling, or for it to fail.
    fn settle(bus: &gst::Bus) -> Result<(), String> {
        let message = bus
            .timed_pop_filtered(STEP, &[gst::MessageType::AsyncDone, gst::MessageType::Error])
            .ok_or("timed out")?;
        match message.view() {
            gst::MessageView::Error(e) => Err(e.error().to_string()),
            _ => Ok(()),
        }
    }

    /// Takes the pipeline down on every way out, so a failed file releases its decoder.
    struct Stopped<'a>(&'a gst::Pipeline);

    impl Drop for Stopped<'_> {
        fn drop(&mut self) {
            let _ = self.0.set_state(gst::State::Null);
        }
    }
}

/// The three stills sharp cannot open, each answered from what the runtime carries.
#[cfg(not(windows))]
mod still_media {
    use std::path::Path;

    use super::{dng, fit, MediaInfo};

    /// A HEIC or HEIF still: the primary image, decoded upright (libheif applies the
    /// container's rotation and mirroring), fitted to `FRAME_EDGE` and written as a JPEG.
    /// Its size is the one after those transformations, the size every viewer draws.
    pub fn heif(src: &Path, dest: &Path) -> (bool, MediaInfo) {
        use libheif_rs::{ColorSpace, HeifContext, LibHeif, RgbChroma};

        let mut info = MediaInfo::default();
        // First, so the decoder plugins are loaded before anything is read.
        let lib = LibHeif::new();
        let Some(ctx) = src.to_str().and_then(|p| HeifContext::read_from_file(p).ok()) else {
            return (false, info);
        };
        let Ok(handle) = ctx.primary_image_handle() else {
            return (false, info);
        };
        if handle.width() > 0 && handle.height() > 0 {
            info.width = Some(handle.width());
            info.height = Some(handle.height());
        }
        let made = (|| {
            let image = lib.decode(&handle, ColorSpace::Rgb(RgbChroma::Rgb), None).ok()?;
            // The decoded picture has the transformations applied by definition, so once
            // there is one its size is the one to report.
            info.width = Some(image.width());
            info.height = Some(image.height());
            let (width, height) = fit(image.width(), image.height());
            let image = if (width, height) == (image.width(), image.height()) {
                image
            } else {
                image.scale(width, height, None).ok()?
            };
            let plane = image.planes().interleaved?;
            write_jpeg(dest, plane.data, plane.stride, plane.width, plane.height)
        })()
        .is_some();
        (made, info)
    }

    /// A DNG still: the largest JPEG preview it embeds, handed over as it is. The DNG's
    /// own orientation goes into that JPEG as an EXIF tag, which the sidecar's sharp
    /// applies the way it does for any photo.
    pub fn dng(src: &Path, dest: &Path) -> (bool, MediaInfo) {
        let Some(found) = dng::read(src) else {
            return (false, MediaInfo::default());
        };
        let mut info = MediaInfo::default();
        if let Some((width, height)) = found.size {
            info.width = Some(width);
            info.height = Some(height);
        }
        let made = found
            .preview
            .is_some_and(|jpeg| std::fs::write(dest, dng::with_orientation(&jpeg, found.orientation)).is_ok());
        (made, info)
    }

    /// Tightly packed RGB rows out of a plane whose rows may be padded, as a JPEG.
    fn write_jpeg(dest: &Path, data: &[u8], stride: usize, width: u32, height: u32) -> Option<()> {
        let (w, h) = (u16::try_from(width).ok()?, u16::try_from(height).ok()?);
        let row = width as usize * 3;
        let mut rgb = Vec::with_capacity(row * height as usize);
        for y in 0..height as usize {
            rgb.extend_from_slice(data.get(y * stride..y * stride + row)?);
        }
        let encoder = jpeg_encoder::Encoder::new_file(dest, 90).ok()?;
        encoder.encode(&rgb, w, h, jpeg_encoder::ColorType::Rgb).ok()
    }
}

/// A size scaled down, never up, so its longer edge is at most `FRAME_EDGE`: the same
/// ceiling the shell is asked for, since the larger upload thumbnail is that size.
#[cfg(not(windows))]
fn fit(width: u32, height: u32) -> (u32, u32) {
    let edge = FRAME_EDGE as u64;
    let long = width.max(height) as u64;
    if long <= edge {
        return (width, height);
    }
    let scale = |v: u32| ((v as u64 * edge + long / 2) / long).max(1) as u32;
    (scale(width), scale(height))
}

/// What a DNG carries besides its raw data: the preview JPEG every DNG writer embeds, and
/// the size of the image itself.
///
/// A DNG is a TIFF. Its first directory usually holds a small thumbnail and points, through
/// SubIFDs, at the raw data and at larger previews; which one is which is told by the
/// NewSubfileType bit and the photometric interpretation. Only directories and their
/// entries are read, never the raw data, so a 60 MB file costs a few kilobytes of reads.
#[cfg(not(windows))]
mod dng {
    use std::collections::HashSet;
    use std::fs::File;
    use std::io::{Read, Seek, SeekFrom};
    use std::path::Path;

    const NEW_SUBFILE_TYPE: u16 = 0x00FE;
    const IMAGE_WIDTH: u16 = 0x0100;
    const IMAGE_LENGTH: u16 = 0x0101;
    const COMPRESSION: u16 = 0x0103;
    const PHOTOMETRIC: u16 = 0x0106;
    const STRIP_OFFSETS: u16 = 0x0111;
    const ORIENTATION: u16 = 0x0112;
    const STRIP_BYTE_COUNTS: u16 = 0x0117;
    const SUB_IFDS: u16 = 0x014A;
    const JPEG_OFFSET: u16 = 0x0201;
    const JPEG_LENGTH: u16 = 0x0202;
    const DEFAULT_CROP_SIZE: u16 = 0xC620;

    /// Colour-filter-array and linear raw data. A DNG stores these JPEG-compressed too
    /// (lossless JPEG), and that is the one JPEG here that must never be taken as a picture.
    const RAW_PHOTOMETRICS: [u32; 2] = [32803, 34892];

    /// How many directories are read at most. A real DNG has a handful, and a loop or a
    /// hostile file must not keep this reading.
    const MAX_IFDS: usize = 32;
    /// The largest preview taken: far above any real one, far below memory trouble.
    const MAX_PREVIEW: u32 = 64 << 20;

    pub struct Dng {
        pub preview: Option<Vec<u8>>,
        /// The image's size as it is displayed, its orientation applied.
        pub size: Option<(u32, u32)>,
        pub orientation: u16,
    }

    #[derive(Default)]
    struct Ifd {
        subfile: u32,
        width: u32,
        height: u32,
        compression: u32,
        photometric: u32,
        strips: Vec<u32>,
        strip_counts: Vec<u32>,
        jpeg_offset: u32,
        jpeg_length: u32,
        crop: Option<(u32, u32)>,
        orientation: u32,
        sub_ifds: Vec<u32>,
    }

    struct Tiff {
        file: File,
        len: u64,
        big_endian: bool,
    }

    impl Tiff {
        fn bytes(&mut self, at: u64, n: usize) -> Option<Vec<u8>> {
            if at.checked_add(n as u64)? > self.len {
                return None;
            }
            self.file.seek(SeekFrom::Start(at)).ok()?;
            let mut out = vec![0; n];
            self.file.read_exact(&mut out).ok()?;
            Some(out)
        }

        fn u16_from(&self, b: &[u8]) -> u16 {
            let b = [b[0], b[1]];
            if self.big_endian { u16::from_be_bytes(b) } else { u16::from_le_bytes(b) }
        }

        fn u32_from(&self, b: &[u8]) -> u32 {
            let b = [b[0], b[1], b[2], b[3]];
            if self.big_endian { u32::from_be_bytes(b) } else { u32::from_le_bytes(b) }
        }

        fn u16_at(&mut self, at: u64) -> Option<u16> {
            let b = self.bytes(at, 2)?;
            Some(self.u16_from(&b))
        }

        fn u32_at(&mut self, at: u64) -> Option<u32> {
            let b = self.bytes(at, 4)?;
            Some(self.u32_from(&b))
        }

        /// One entry's tag and its values as whole numbers: SHORT, LONG, IFD and RATIONAL
        /// (as numerator over denominator), which covers every tag read here. Anything else
        /// comes back empty and is ignored.
        fn entry(&mut self, at: u64) -> Option<(u16, Vec<u32>)> {
            let head = self.bytes(at, 8)?;
            let tag = self.u16_from(&head[0..2]);
            let size = match self.u16_from(&head[2..4]) {
                3 => 2,
                4 | 13 => 4,
                5 => 8,
                _ => return Some((tag, Vec::new())),
            };
            let count = self.u32_from(&head[4..8]) as usize;
            if count == 0 || count > 1024 {
                return Some((tag, Vec::new()));
            }
            let total = size * count;
            let from = if total <= 4 { at + 8 } else { self.u32_at(at + 8)? as u64 };
            let raw = self.bytes(from, total)?;
            let values = raw
                .chunks(size)
                .map(|c| match size {
                    2 => self.u16_from(c) as u32,
                    4 => self.u32_from(c),
                    _ => self.u32_from(&c[0..4]) / self.u32_from(&c[4..8]).max(1),
                })
                .collect();
            Some((tag, values))
        }

        /// One directory, and the offset of the next one in its chain.
        fn ifd(&mut self, at: u64) -> Option<(Ifd, u32)> {
            let count = self.u16_at(at)? as u64;
            if count > 512 {
                return None;
            }
            let mut ifd = Ifd::default();
            for i in 0..count {
                let Some((tag, values)) = self.entry(at + 2 + i * 12) else {
                    continue;
                };
                let first = values.first().copied().unwrap_or(0);
                match tag {
                    NEW_SUBFILE_TYPE => ifd.subfile = first,
                    IMAGE_WIDTH => ifd.width = first,
                    IMAGE_LENGTH => ifd.height = first,
                    COMPRESSION => ifd.compression = first,
                    PHOTOMETRIC => ifd.photometric = first,
                    STRIP_OFFSETS => ifd.strips = values,
                    STRIP_BYTE_COUNTS => ifd.strip_counts = values,
                    ORIENTATION => ifd.orientation = first,
                    SUB_IFDS => ifd.sub_ifds = values,
                    JPEG_OFFSET => ifd.jpeg_offset = first,
                    JPEG_LENGTH => ifd.jpeg_length = first,
                    DEFAULT_CROP_SIZE if values.len() == 2 => ifd.crop = Some((values[0], values[1])),
                    _ => {}
                }
            }
            let next = self.u32_at(at + 2 + count * 12).unwrap_or(0);
            Some((ifd, next))
        }
    }

    impl Ifd {
        /// Where this directory's picture sits, if it is a JPEG preview rather than raw data:
        /// the old-style JPEGInterchangeFormat pair, or a single JPEG-compressed strip.
        fn jpeg(&self) -> Option<(u32, u32)> {
            if RAW_PHOTOMETRICS.contains(&self.photometric) {
                return None;
            }
            if self.jpeg_offset > 0 && self.jpeg_length > 0 {
                return Some((self.jpeg_offset, self.jpeg_length));
            }
            let single = self.strips.len() == 1 && self.strip_counts.len() == 1;
            (matches!(self.compression, 6 | 7) && single).then(|| (self.strips[0], self.strip_counts[0]))
        }
    }

    pub fn read(path: &Path) -> Option<Dng> {
        let file = File::open(path).ok()?;
        let len = file.metadata().ok()?.len();
        let mut tiff = Tiff { file, len, big_endian: false };
        tiff.big_endian = match tiff.bytes(0, 4)?.as_slice() {
            b"II*\0" => false,
            b"MM\0*" => true,
            _ => return None,
        };
        let first = tiff.u32_at(4)?;

        // The first directory's chain and every SubIFD under it, none of them twice.
        let mut pending = vec![first];
        let mut seen = HashSet::new();
        let mut ifds = Vec::new();
        while let Some(at) = pending.pop() {
            if at == 0 || ifds.len() >= MAX_IFDS || !seen.insert(at) {
                continue;
            }
            let Some((ifd, next)) = tiff.ifd(at as u64) else {
                continue;
            };
            pending.push(next);
            pending.extend(ifd.sub_ifds.iter().rev().copied());
            ifds.push(ifd);
        }
        let first = ifds.first()?;
        let orientation = Some(first.orientation).filter(|o| (1..=8).contains(o)).unwrap_or(1) as u16;

        // The image itself is the directory not marked as a reduced-resolution copy.
        let size = ifds
            .iter()
            .filter(|i| i.subfile & 1 == 0 && i.width > 0 && i.height > 0)
            .max_by_key(|i| i.width as u64 * i.height as u64)
            .map(|i| i.crop.filter(|&(w, h)| w > 0 && h > 0).unwrap_or((i.width, i.height)))
            // Orientations 5 to 8 all turn the picture a quarter, which swaps its edges.
            .map(|(w, h)| if orientation >= 5 { (h, w) } else { (w, h) });

        let preview = ifds
            .iter()
            .filter_map(|i| i.jpeg().map(|(at, n)| (i.width as u64 * i.height as u64, n, at)))
            .filter(|&(_, n, _)| n <= MAX_PREVIEW)
            .max()
            .and_then(|(_, n, at)| tiff.bytes(at as u64, n as usize))
            .filter(|jpeg| jpeg.starts_with(&[0xFF, 0xD8]));

        Some(Dng { preview, size, orientation })
    }

    /// The JPEG with an EXIF segment carrying `orientation` put first, so whatever opens it
    /// turns it the way the DNG says. Upright (1) or out of range leaves it untouched.
    pub fn with_orientation(jpeg: &[u8], orientation: u16) -> Vec<u8> {
        if !(2..=8).contains(&orientation) || !jpeg.starts_with(&[0xFF, 0xD8]) {
            return jpeg.to_vec();
        }
        let mut out = Vec::with_capacity(jpeg.len() + 36);
        out.extend_from_slice(&[0xFF, 0xD8]);
        // APP1, 34 bytes: its own length, "Exif\0\0", a big-endian TIFF header, and one
        // directory holding the single Orientation entry.
        out.extend_from_slice(&[0xFF, 0xE1, 0x00, 0x22]);
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(&[b'M', b'M', 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08]);
        out.extend_from_slice(&[0x00, 0x01]);
        out.extend_from_slice(&[0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01]);
        out.extend_from_slice(&orientation.to_be_bytes());
        out.extend_from_slice(&[0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        out.extend_from_slice(&jpeg[2..]);
        out
    }
}

/// Whether an `image-orientation` tag turns the picture a quarter, which swaps its edges.
/// A phone held upright records a landscape frame and a rotate-90 tag, and the size stored
/// has to be the one every viewer draws, as the shell's already-turned size is.
#[cfg(not(windows))]
fn quarter_turned(orientation: &str) -> bool {
    matches!(orientation, "rotate-90" | "rotate-270" | "flip-rotate-90" | "flip-rotate-270")
}

/// A JPEG of every dropped video, keyed by the path it was made from, and whatever the
/// shell knew about the same files.
///
/// Called by the frontend just before it starts an upload, and both maps are passed along
/// with it. A file that produced nothing is simply absent from either, and the sidecar
/// uploads it the way it always has: neither a thumbnail nor a duration is ever worth
/// failing an upload over.
///
/// The wait is the honest cost of having no reverse channel. It falls only on drops that
/// contain video, since nothing else is asked for, and it is usually short because
/// Explorer has generally cached these already while the files were being found.
#[tauri::command]
pub async fn upload_frames(app: AppHandle, paths: Vec<String>) -> Result<FramePrep, String> {
    tauri::async_runtime::spawn_blocking(move || prepare(&app, &paths))
        .await
        .map_err(|e| format!("preparing those frames failed: {e}"))
}

/// The work behind `upload_frames`, for the file-manager drive too, whose drops upload
/// through the same path an in-app drop does. Blocking.
pub(crate) fn prepare(app: &AppHandle, paths: &[String]) -> FramePrep {
    let jobs = plan_frames(app, paths);
    if jobs.is_empty() {
        return FramePrep::default();
    }
    if std::fs::create_dir_all(frame_dir()).is_err() {
        return FramePrep::default();
    }

    let outcomes = run_jobs(&jobs);
    let mut prep = FramePrep::default();
    for (job, (made, info)) in jobs.iter().zip(outcomes) {
        if made {
            prep.frames
                .insert(job.key.clone(), job.dest.to_string_lossy().into_owned());
        }
        // An empty entry would only be a key the other side has to test for.
        if !info.is_empty() {
            prep.media.insert(job.key.clone(), info);
        }
    }

    // Counts only. A path or a file name here would be the user's own photo library
    // written to a log that gets pasted into bug reports.
    crate::note(
        app,
        &format!(
            "[frames] wanted {} made {} described {}",
            jobs.len(),
            prep.frames.len(),
            prep.media.len()
        ),
    );
    prep
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory holding the named empty files, removed when the guard drops.
    struct TempTree(PathBuf);

    impl TempTree {
        fn new(tag: &str, names: &[&str]) -> Self {
            let dir = std::env::temp_dir().join(format!("pfp-frame-test-{tag}-{}", frame_name()));
            std::fs::create_dir_all(&dir).unwrap();
            for name in names {
                std::fs::write(dir.join(name), b"not really a video").unwrap();
            }
            TempTree(dir)
        }
        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn only_what_the_sidecar_cannot_thumbnail_itself_is_asked_of_windows() {
        // Every video the sidecar accepts for upload.
        for ext in ["mp4", "mov", "m4v", "webm", "mkv", "3gp"] {
            assert!(needs_windows_frame(ext), "{ext} uploads with no thumbnail");
        }
        // And the three stills sharp has no decoder for.
        for ext in ["heic", "heif", "dng"] {
            assert!(needs_windows_frame(ext), "{ext} uploads with no thumbnail");
        }
        // What sharp handles itself must never come here: that path already produces
        // correct thumbnails and a frame would only displace one.
        for ext in ["jpg", "jpeg", "png", "webp", "gif", "avif", "tif", "tiff"] {
            assert!(!needs_windows_frame(ext), "{ext} belongs to sharp");
        }
        // The caller lowercases, as everywhere else here.
        assert!(!needs_windows_frame("MP4"));
        assert!(!needs_windows_frame(""));
        assert!(!needs_windows_frame("exe"));
    }

    #[test]
    fn a_dropped_file_is_a_candidate_only_when_it_needs_one() {
        let tree = TempTree::new("loose", &["clip.mp4", "photo.jpg"]);
        let video = Path::new(&tree.path()).join("clip.mp4").to_string_lossy().into_owned();
        let photo = Path::new(&tree.path()).join("photo.jpg").to_string_lossy().into_owned();

        assert_eq!(frame_candidates(&[video.clone()]), vec![video.clone()]);
        assert!(frame_candidates(&[photo.clone()]).is_empty(), "sharp handles this one");
        // Mixed, and the photo is left behind rather than the whole drop refused.
        assert_eq!(frame_candidates(&[photo, video.clone()]), vec![video]);
    }

    #[test]
    fn a_mixed_folder_yields_its_videos_and_leaves_its_photos_to_sharp() {
        // The album case: a folder becomes one, and its contents upload individually.
        let tree = TempTree::new("album", &["a.jpg", "b.mp4", "c.png", "d.mov", "e.heic"]);
        let mut found = frame_candidates(&[tree.path()]);
        found.sort();

        let expect = |name: &str| Path::new(&tree.path()).join(name).to_string_lossy().into_owned();
        assert_eq!(found, vec![expect("b.mp4"), expect("d.mov"), expect("e.heic")]);
    }

    #[test]
    fn a_folder_candidate_is_spelled_the_way_the_sidecar_will_spell_it() {
        // The key is looked up by a path the sidecar built by joining the dropped folder
        // to the file's own name. A key that does not match is a thumbnail thrown away.
        let tree = TempTree::new("spelling", &["clip.mp4"]);
        let found = frame_candidates(&[tree.path()]);
        assert_eq!(found.len(), 1);
        assert!(found[0].starts_with(&tree.path()), "the dropped path is kept as given");
        assert!(found[0].ends_with("clip.mp4"));
    }

    #[test]
    fn a_drop_with_nothing_to_do_asks_for_nothing() {
        let tree = TempTree::new("photos", &["a.jpg", "b.png"]);
        assert!(frame_candidates(&[tree.path()]).is_empty(), "a photo drop does no extra work");
        assert!(frame_candidates(&[]).is_empty());
        // A path that is not there at all is skipped rather than failing the drop.
        assert!(frame_candidates(&["C:\\nowhere-at-all\\clip.mp4".to_string()]).is_empty());
    }

    #[test]
    fn a_duration_is_converted_from_the_shell_unit_to_the_one_drive_stores() {
        // The shell counts 100-nanosecond units and Drive stores seconds. Ten million of
        // the former make one of the latter, and getting that factor wrong is the 1000x
        // error this project has already paid for once.
        assert_eq!(duration_seconds(10_000_000), Some(1.0));
        assert_eq!(duration_seconds(75_000_000), Some(7.5));
        assert_eq!(duration_seconds(600_000_000), Some(60.0));
        // A two hour film, which must not come back as anything like two.
        assert_eq!(duration_seconds(72_000_000_000), Some(7200.0));

        // Sub-second clips survive rather than rounding away to nothing.
        assert_eq!(duration_seconds(5_000_000), Some(0.5));
        assert_eq!(duration_seconds(10_000), Some(0.001));

        // Rounded to the millisecond, which is all anything displays: the tail below a
        // thousandth of a second goes, and the seconds themselves never move.
        assert_eq!(duration_seconds(75_500_000), Some(7.55));
        assert_eq!(duration_seconds(75_004_999), Some(7.5));
        assert_eq!(duration_seconds(1_234_567), Some(0.123));
        // Half a millisecond goes up, never down to a shorter clip.
        assert_eq!(duration_seconds(75_005_000), Some(7.501));
    }

    #[test]
    fn a_file_the_shell_cannot_describe_reports_nothing_rather_than_zero() {
        // The honest answer for a machine with no decoder. A zero would read downstream
        // as a real measurement: a video claiming to be no time long.
        assert_eq!(duration_seconds(0), None);

        let empty = MediaInfo::default();
        assert!(empty.is_empty(), "nothing known means nothing sent");
        assert!(empty.duration_sec.is_none());

        let described = MediaInfo {
            width: Some(1920),
            height: Some(1080),
            duration_sec: None,
        };
        // A still has no duration and is still worth sending.
        assert!(!described.is_empty());
    }

    #[test]
    fn a_staged_frame_lands_in_its_own_folder_under_a_name_of_its_own() {
        // Never `pfp-view`: that folder is the one the webview can read.
        assert!(frame_dir().ends_with(FRAME_DIR));
        assert_ne!(FRAME_DIR, "pfp-view");

        let one = frame_name();
        assert!(one.starts_with("frame-") && one.ends_with(".jpg"));
        assert_ne!(one, frame_name(), "two frames would overwrite each other");
    }

    #[test]
    fn a_folder_is_walked_into_its_sub_folders_the_way_the_sidecar_walks_it() {
        // Everything under a dropped folder uploads into its one album, so a video two
        // levels down needs its frame as much as one at the top.
        let tree = TempTree::new("nested", &["top.mp4", "top.jpg"]);
        let root = tree.0.clone();
        std::fs::create_dir_all(root.join("2023").join("summer")).unwrap();
        std::fs::write(root.join("2023").join("clip.mov"), b"x").unwrap();
        std::fs::write(root.join("2023").join("summer").join("deep.webm"), b"x").unwrap();
        std::fs::write(root.join("2023").join("summer").join("still.png"), b"x").unwrap();

        let at = |parts: &[&str]| {
            parts.iter().fold(root.clone(), |p, part| p.join(part)).to_string_lossy().into_owned()
        };
        let mut expect = vec![
            at(&["top.mp4"]),
            at(&["2023", "clip.mov"]),
            at(&["2023", "summer", "deep.webm"]),
        ];
        expect.sort();
        let mut found = frame_candidates(&[tree.path()]);
        found.sort();
        assert_eq!(found, expect);
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_inside_a_folder_is_never_followed() {
        // Nor does the sidecar follow one: a link's target is not part of the upload, and a
        // link back up the tree cannot loop.
        let outside = TempTree::new("outside", &["elsewhere.mp4"]);
        let tree = TempTree::new("links", &["own.mp4"]);
        let link = |name: &str| tree.0.join(name);
        std::os::unix::fs::symlink(&outside.0, link("linked-dir")).unwrap();
        std::os::unix::fs::symlink(outside.0.join("elsewhere.mp4"), link("linked.mp4")).unwrap();
        std::os::unix::fs::symlink(&tree.0, link("loop")).unwrap();

        assert_eq!(
            frame_candidates(&[tree.path()]),
            vec![tree.0.join("own.mp4").to_string_lossy().into_owned()]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn a_quarter_turn_swaps_the_edges_and_nothing_else_does() {
        for tag in ["rotate-90", "rotate-270", "flip-rotate-90", "flip-rotate-270"] {
            assert!(quarter_turned(tag), "{tag}");
        }
        for tag in ["rotate-0", "rotate-180", "flip-rotate-0", "flip-rotate-180", ""] {
            assert!(!quarter_turned(tag), "{tag}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn a_still_is_fitted_down_to_the_frame_edge_and_never_up() {
        assert_eq!(fit(4032, 3024), (1920, 1440));
        assert_eq!(fit(3024, 4032), (1440, 1920));
        assert_eq!(fit(1920, 1080), (1920, 1080));
        assert_eq!(fit(800, 600), (800, 600), "a small picture is never stretched");
        assert_eq!(fit(100_000, 10), (1920, 1), "a sliver keeps at least a pixel");
    }

    /// A little-endian TIFF directory entry whose value fits its own four bytes.
    #[cfg(not(windows))]
    fn le_entry(tag: u16, kind: u16, count: u32, value: u32) -> Vec<u8> {
        [tag.to_le_bytes().as_slice(), &kind.to_le_bytes(), &count.to_le_bytes(), &value.to_le_bytes()].concat()
    }

    #[cfg(not(windows))]
    fn le_ifd(entries: &[Vec<u8>], next: u32) -> Vec<u8> {
        let mut out = (entries.len() as u16).to_le_bytes().to_vec();
        entries.iter().for_each(|e| out.extend_from_slice(e));
        out.extend_from_slice(&next.to_le_bytes());
        out
    }

    /// A DNG laid out the way real ones are: a small uncompressed thumbnail first, turned a
    /// quarter, pointing at the raw data (itself JPEG-compressed, as lossless DNGs are) and
    /// at a larger JPEG preview.
    #[cfg(not(windows))]
    fn synthetic_dng(raw: &[u8], preview: &[u8]) -> Vec<u8> {
        const SHORT: u16 = 3;
        const LONG: u16 = 4;
        let size = |entries: usize| (2 + entries * 12 + 4) as u32;
        let ifd0 = 8u32;
        let subs = ifd0 + size(7);
        let raw_ifd = subs + 8;
        let preview_ifd = raw_ifd + size(8);
        let raw_at = preview_ifd + size(7);
        let preview_at = raw_at + raw.len() as u32;

        let mut out = b"II*\0".to_vec();
        out.extend_from_slice(&ifd0.to_le_bytes());
        out.extend(le_ifd(
            &[
                le_entry(0x00FE, LONG, 1, 1),
                le_entry(0x0100, SHORT, 1, 256),
                le_entry(0x0101, SHORT, 1, 171),
                le_entry(0x0103, SHORT, 1, 1),
                le_entry(0x0106, SHORT, 1, 2),
                le_entry(0x0112, SHORT, 1, 6),
                le_entry(0x014A, LONG, 2, subs),
            ],
            0,
        ));
        out.extend_from_slice(&raw_ifd.to_le_bytes());
        out.extend_from_slice(&preview_ifd.to_le_bytes());
        out.extend(le_ifd(
            &[
                le_entry(0x00FE, LONG, 1, 0),
                le_entry(0x0100, LONG, 1, 4032),
                le_entry(0x0101, LONG, 1, 3024),
                le_entry(0x0103, SHORT, 1, 7),
                le_entry(0x0106, SHORT, 1, 32803),
                le_entry(0x0111, LONG, 1, raw_at),
                le_entry(0x0117, LONG, 1, raw.len() as u32),
                le_entry(0xC620, SHORT, 2, 4000 | (3000 << 16)),
            ],
            0,
        ));
        out.extend(le_ifd(
            &[
                le_entry(0x00FE, LONG, 1, 1),
                le_entry(0x0100, LONG, 1, 1024),
                le_entry(0x0101, LONG, 1, 768),
                le_entry(0x0103, SHORT, 1, 7),
                le_entry(0x0106, SHORT, 1, 6),
                le_entry(0x0111, LONG, 1, preview_at),
                le_entry(0x0117, LONG, 1, preview.len() as u32),
            ],
            0,
        ));
        assert_eq!(out.len() as u32, raw_at, "the fixture's own layout");
        out.extend_from_slice(raw);
        out.extend_from_slice(preview);
        out
    }

    #[cfg(not(windows))]
    #[test]
    fn a_dng_yields_its_largest_preview_never_its_raw_data() {
        // The raw data starts like a JPEG too (lossless JPEG), which is the trap.
        let raw = [&[0xFFu8, 0xD8][..], b"RAW SENSOR DATA", &[0xFF, 0xD9]].concat();
        let preview = [&[0xFFu8, 0xD8, 0xFF, 0xE0][..], b"THE PREVIEW", &[0xFF, 0xD9]].concat();
        let tree = TempTree::new("dng", &[]);
        let src = tree.0.join("shot.dng");
        std::fs::write(&src, synthetic_dng(&raw, &preview)).unwrap();

        let found = dng::read(&src).expect("a DNG");
        assert_eq!(found.preview.as_deref(), Some(preview.as_slice()));
        assert_eq!(found.orientation, 6);
        // The crop size, turned upright by the quarter turn.
        assert_eq!(found.size, Some((3000, 4000)));

        let dest = tree.0.join("frame.jpg");
        let (made, info) = still_media::dng(&src, &dest);
        assert!(made);
        assert_eq!((info.width, info.height), (Some(3000), Some(4000)));
        assert!(info.duration_sec.is_none());
        assert_eq!(std::fs::read(&dest).unwrap(), dng::with_orientation(&preview, 6));
    }

    #[cfg(not(windows))]
    #[test]
    fn a_file_that_is_not_a_tiff_is_no_dng() {
        let tree = TempTree::new("notdng", &["fake.dng"]);
        assert!(dng::read(&tree.0.join("fake.dng")).is_none());
        let (made, info) = still_media::dng(&tree.0.join("fake.dng"), &tree.0.join("out.jpg"));
        assert!(!made && info.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn the_orientation_is_written_as_the_first_exif_segment() {
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x04, 0x00, 0x00, 0xFF, 0xD9];
        let out = dng::with_orientation(&jpeg, 6);
        assert_eq!(&out[..4], &[0xFF, 0xD8, 0xFF, 0xE1]);
        assert_eq!(u16::from_be_bytes([out[4], out[5]]), 34, "the segment's own length");
        assert_eq!(&out[6..12], b"Exif\0\0");
        assert_eq!(&out[12..16], b"MM\0*");
        assert_eq!(&out[22..24], &[0x01, 0x12], "the Orientation tag");
        assert_eq!(u16::from_be_bytes([out[30], out[31]]), 6);
        assert_eq!(&out[38..], &jpeg[2..], "the picture follows untouched");
        // Upright or nonsense leaves the JPEG as it was.
        assert_eq!(dng::with_orientation(&jpeg, 1), jpeg.to_vec());
        assert_eq!(dng::with_orientation(&jpeg, 9), jpeg.to_vec());
    }

    /// The real libheif of this machine. The fixture is HEVC, what an iPhone writes, where
    /// an HEVC encoder is present (the Flatpak runtime's codecs extension carries one),
    /// and AV1 otherwise, which goes through the same container and decode. Where libheif
    /// writes the requested quarter turn into the file, the size must come back turned.
    #[cfg(not(windows))]
    #[test]
    fn libheif_decodes_a_heif_still_upright_to_a_jpeg() {
        use libheif_rs::{
            Channel, ColorSpace, CompressionFormat, EncoderQuality, EncodingOptions, HeifContext,
            Image, ImageOrientation, LibHeif, RgbChroma,
        };

        let lib = LibHeif::new();
        let Some((format, mut encoder)) = [CompressionFormat::Hevc, CompressionFormat::Av1]
            .into_iter()
            .find_map(|f| lib.encoder_for_format(f).ok().map(|e| (f, e)))
        else {
            eprintln!("skipped: no HEVC or AV1 encoder to build the fixture with");
            return;
        };
        eprintln!("fixture encoded as {format:?}");
        encoder.set_quality(EncoderQuality::Lossy(60)).unwrap();
        let (w, h) = (64u32, 32u32);
        let mut image = Image::new(w, h, ColorSpace::Rgb(RgbChroma::Rgb)).unwrap();
        image.create_plane(Channel::Interleaved, w, h, 8).unwrap();
        {
            let plane = image.planes_mut().interleaved.unwrap();
            for y in 0..h as usize {
                for x in 0..w as usize {
                    let i = y * plane.stride + x * 3;
                    plane.data[i..i + 3].copy_from_slice(&[200, (x * 4) as u8, (y * 8) as u8]);
                }
            }
        }
        // Stored landscape and tagged a quarter turn, as a phone held upright writes it.
        let mut options = EncodingOptions::new().unwrap();
        options.set_image_orientation(ImageOrientation::Rotate90Cw);
        let mut ctx = HeifContext::new().unwrap();
        ctx.encode_image(&image, &mut encoder, Some(options)).unwrap();
        let tree = TempTree::new("heif", &[]);
        let still = tree.0.join("still.heic");
        ctx.write_to_file(still.to_str().unwrap()).unwrap();
        let turned = std::fs::read(&still).unwrap().windows(4).any(|w| w == b"irot");
        eprintln!("the fixture carries a rotation: {turned}");

        let frame = tree.0.join("frame.jpg");
        let (made, info) = still_media::heif(&still, &frame);
        assert!(made, "a picture");
        let expect = if turned { (Some(32), Some(64)) } else { (Some(64), Some(32)) };
        assert_eq!((info.width, info.height), expect, "the size a viewer draws");
        assert!(info.duration_sec.is_none());
        assert!(std::fs::read(&frame).unwrap().starts_with(&[0xFF, 0xD8]), "a JPEG");

        // Something libheif cannot read is no picture and no size, not a failed upload.
        let junk = tree.0.join("junk.heic");
        std::fs::write(&junk, b"not a heif at all").unwrap();
        let (made, info) = still_media::heif(&junk, &tree.0.join("junk.jpg"));
        assert!(!made && info.is_empty());
    }

    /// End to end on this machine's GStreamer: a short clip is encoded, then described and
    /// pictured by the same code the upload runs.
    #[cfg(not(windows))]
    #[test]
    fn gstreamer_describes_and_pictures_a_real_clip() {
        use gstreamer as gst;
        use gstreamer::prelude::*;

        gst::init().unwrap();
        // Making the clip needs an encoder the upload never uses. A machine without one
        // cannot build the fixture, which says nothing about the code under test.
        if gst::ElementFactory::find("vp8enc").is_none() || gst::ElementFactory::find("webmmux").is_none() {
            eprintln!("skipped: no vp8enc or webmmux to build the fixture with");
            return;
        }
        let tree = TempTree::new("gst", &[]);
        let clip = tree.0.join("clip.webm");
        let encode = gst::parse_launch(&format!(
            "videotestsrc num-buffers=60 ! video/x-raw,width=320,height=240,framerate=30/1 ! \
             vp8enc ! webmmux ! filesink location=\"{}\"",
            clip.display()
        ))
        .unwrap();
        encode.set_state(gst::State::Playing).unwrap();
        let done = encode.bus().unwrap().timed_pop_filtered(
            gst::ClockTime::from_seconds(60),
            &[gst::MessageType::Eos, gst::MessageType::Error],
        );
        encode.set_state(gst::State::Null).unwrap();
        assert!(
            matches!(done.as_ref().map(|m| m.view()), Some(gst::MessageView::Eos(_))),
            "the fixture clip was not written"
        );

        let uri = gst::glib::filename_to_uri(&clip, None).unwrap();
        let (info, drawable) = gst_media::probe(&uri);
        assert!(drawable, "a VP8 clip is decodable here");
        assert_eq!((info.width, info.height), (Some(320), Some(240)));
        let seconds = info.duration_sec.expect("a length");
        assert!((seconds - 2.0).abs() < 0.1, "two seconds at 30 fps, got {seconds}");

        let picture = tree.0.join("frame.jpg");
        gst_media::grab(&uri, &picture).expect("a picture");
        let bytes = std::fs::read(&picture).unwrap();
        assert!(bytes.starts_with(&[0xFF, 0xD8]), "a JPEG");
    }
}
