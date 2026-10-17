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

// Photos and videos that are already on this disk.
//
// Nothing here goes near the sidecar, and that is the whole point: double-clicking a
// file in Explorer must open it with no vault, no session and no password, so no step
// on this path may wait on the SDK process being up. The window already paints before
// the sidecar is ever contacted, so the only thing missing was a way in.
//
// Two surfaces reach the webview. An ordinary photo or video goes through Tauri's asset
// protocol, one admitted path at a time (`local_file_url`). A format the engine cannot
// draw is decoded by Windows itself and staged as a JPEG in the same folder the viewer's
// full-resolution originals already use (`decode_preview`), so the startup sweep that
// exists for those cleans these up too.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use windows::Win32::Graphics::Imaging::{IWICBitmapSource, IWICImagingFactory};

use crate::secure_store;

// ---- What a local file is allowed to be ----
//
// One table, read three ways: it names the media type, it decides whether the webview
// can draw the bytes itself, and it is the allowlist every command that touches a
// caller-named path is checked against. Keeping those three answers in one place is
// what stops them drifting apart.
//
// SVG is deliberately absent, for the same reason the sidecar leaves it out of the
// originals it will fetch: a photo library has no use for it, and it is the one image
// type that carries markup.

/// Extension (lowercase, no dot), media type, and whether WebView2 can render it
/// without help. The third column is what decides between `local_file_url` and
/// `decode_preview`.
const MEDIA_TYPES: &[(&str, &str, bool)] = &[
    // Stills the engine draws itself.
    ("jpg", "image/jpeg", true),
    ("jpeg", "image/jpeg", true),
    ("jpe", "image/jpeg", true),
    ("jfif", "image/jpeg", true),
    ("png", "image/png", true),
    ("apng", "image/apng", true),
    ("gif", "image/gif", true),
    ("webp", "image/webp", true),
    ("avif", "image/avif", true),
    ("bmp", "image/bmp", true),
    ("dib", "image/bmp", true),
    ("ico", "image/x-icon", true),
    // Stills that need the OS decoder first. HEIC leads the list because it is what a
    // recent iPhone writes; the rest are here because WIC reaches them through the same
    // call once the machine has the codec.
    ("heic", "image/heic", false),
    ("heif", "image/heif", false),
    ("hif", "image/heif", false),
    ("tif", "image/tiff", false),
    ("tiff", "image/tiff", false),
    ("jxl", "image/jxl", false),
    ("dng", "image/x-adobe-dng", false),
    ("cr2", "image/x-canon-cr2", false),
    ("cr3", "image/x-canon-cr3", false),
    ("nef", "image/x-nikon-nef", false),
    ("arw", "image/x-sony-arw", false),
    ("orf", "image/x-olympus-orf", false),
    ("rw2", "image/x-panasonic-rw2", false),
    ("raf", "image/x-fuji-raf", false),
    ("srw", "image/x-samsung-srw", false),
    ("pef", "image/x-pentax-pef", false),
    // Video. `drawable` is true throughout: whether a given container actually plays is
    // the engine's business, and nothing here can help it if not, because the decoder
    // below this comment is a still-image decoder.
    ("mp4", "video/mp4", true),
    ("m4v", "video/mp4", true),
    ("mov", "video/quicktime", true),
    ("webm", "video/webm", true),
    ("mkv", "video/x-matroska", true),
    ("avi", "video/x-msvideo", true),
    ("wmv", "video/x-ms-wmv", true),
    ("mpg", "video/mpeg", true),
    ("mpeg", "video/mpeg", true),
    ("3gp", "video/3gpp", true),
    ("3g2", "video/3gpp2", true),
    ("ts", "video/mp2t", true),
    ("mts", "video/mp2t", true),
    ("m2ts", "video/mp2t", true),
];

/// The extension, lowercased and without its dot. Empty when there is none, and for a
/// dotfile with no extension of its own.
pub(crate) fn extension_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// The row for one extension, or `None` for anything not in the table.
pub(crate) fn media_entry(ext: &str) -> Option<&'static (&'static str, &'static str, bool)> {
    MEDIA_TYPES.iter().find(|(e, _, _)| *e == ext)
}

/// Best effort from the extension alone, never from the bytes: the answer is wanted
/// before anything has been read, and for a video it is wanted without opening a
/// demuxer at all.
fn mime_for_extension(ext: &str) -> &'static str {
    media_entry(ext)
        .map(|(_, mime, _)| *mime)
        .unwrap_or("application/octet-stream")
}

/// Whether the webview can put these bytes on screen unaided.
fn is_webview_drawable(ext: &str) -> bool {
    media_entry(ext).map(|(_, _, ok)| *ok).unwrap_or(false)
}

/// Whether `decode_preview` is the route for this one. Only ever true for a still: a
/// container the engine will not play is not something a JPEG encoder can rescue.
fn needs_decode(ext: &str) -> bool {
    !is_webview_drawable(ext) && mime_for_extension(ext).starts_with("image/")
}

// ---- The launch argument ----
//
// Explorer hands the file over as a command-line argument, and which entry point sees
// it depends on whether the app was already running. A cold launch has to read it in
// `setup`, because the single-instance callback is never called for the first process;
// a warm launch has to take it from that callback, because the running process's own
// `std::env::args` is whatever it was started with hours ago. Both funnel into
// `deliver`, so the two paths cannot drift.

/// The event the frontend listens for. Carries `{ path }`.
const OPEN_FILE_EVENT: &str = "open-file";

/// The path a launch argument named, held until the viewer window asks for it.
///
/// The event alone is never enough. The window a file is shown in is built by the same
/// call that delivers the file, so at that moment nothing is listening yet, and a
/// second file arriving while the first window is still loading would fall down the
/// same gap. The viewer takes this on mount and taking it is what clears it.
#[derive(Default)]
pub struct PendingOpen(Mutex<Option<String>>);

/// Whether this process exists only to show a file.
///
/// Set by a cold launch that carried one, cleared the moment the app itself is asked
/// for. Two places read it, and both would otherwise do the wrong thing by a process
/// Explorer started over one photo: startup, which skips everything a picture does not
/// need, and the viewer's close, because a process with no app behind it and no window
/// left on screen is indistinguishable from one that has died.
#[derive(Default)]
pub struct ViewerOnlyLaunch(std::sync::atomic::AtomicBool);

/// Whether this launch is still only a viewer.
///
/// Read from a window-event handler, where a missing state would be a panic in the
/// middle of closing a window, so it answers rather than asserting.
pub fn viewer_only_launch(app: &AppHandle) -> bool {
    app.try_state::<ViewerOnlyLaunch>()
        .map(|f| f.0.load(std::sync::atomic::Ordering::Relaxed))
        .unwrap_or(false)
}

/// The app itself has been asked for, so this window is no longer only a viewer.
pub fn app_taken_over(app: &AppHandle) {
    if let Some(flag) = app.try_state::<ViewerOnlyLaunch>() {
        flag.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// The file argument out of one launch command line.
///
/// Index 0 is the executable in both shapes this is handed: `std::env::args` on a cold
/// start, and the second process's own argv on a warm one. A switch is never a file, and
/// a relative path would resolve against whichever process is asking, which on a warm
/// launch is the wrong one, so only an absolute plain argument counts.
fn launch_arg(argv: &[String]) -> Option<&str> {
    argv.iter()
        .skip(1)
        .map(String::as_str)
        .find(|a| !a.starts_with('-') && !a.starts_with('/') && Path::new(a).is_absolute())
}

/// Show the file a launch argument named, and say whether there was one.
///
/// `cold` marks the process as existing only for this file, which only a launch that
/// started it can claim. Everything else is the same either way: the path is left where
/// the viewer can collect it, the viewer window is opened or brought forward, and the
/// event goes out.
///
/// Both, not one or the other. The window may not be listening yet, either because this
/// call is what builds it or because a second file arrived while it was still loading,
/// and the held path is what covers that. The emit is what moves a viewer that IS
/// listening on to the new file, and it happens unconditionally so that opening the same
/// file twice is not read as nothing having happened.
fn deliver(app: &AppHandle, argv: &[String], cold: bool) -> bool {
    let Some(candidate) = launch_arg(argv) else {
        return false;
    };
    // A stale shortcut argument or the value of some future switch is not a request to
    // open anything. Only a file that is really there becomes one.
    if !Path::new(candidate).is_file() {
        return false;
    }
    let path = candidate.to_string();
    if cold {
        if let Some(flag) = app.try_state::<ViewerOnlyLaunch>() {
            flag.0.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
    // Before the window, never after: the viewer asks for this the moment it mounts,
    // and a path stored behind that question would arrive to nobody.
    *app.state::<PendingOpen>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.clone());
    crate::show_viewer_window(app);
    let _ = app.emit(OPEN_FILE_EVENT, serde_json::json!({ "path": path }));
    true
}

/// The file this process was started for, if it was started for one.
pub fn deliver_cold(app: &AppHandle, argv: &[String]) -> bool {
    deliver(app, argv, true)
}

/// The file a second launch is handing to this already-running app.
pub fn deliver_warm(app: &AppHandle, argv: &[String]) -> bool {
    deliver(app, argv, false)
}

/// The pending launch argument, once. Called by the viewer window on mount, which is
/// one of the two ways a file reaches it.
#[tauri::command]
pub fn take_pending_open(state: State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// Drop whatever the slot still holds, because the window that would have read it is
/// gone. Nothing should outlive the viewer that names a file the user has closed.
pub fn forget_pending_open(app: &AppHandle) {
    if let Some(slot) = app.try_state::<PendingOpen>() {
        *slot.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

// ---- Paths the renderer names ----

/// Whether `path` sits inside `dir`. Both sides are canonical, so the comparison is
/// component-wise against the casing the filesystem itself reports, and a `..` cannot
/// walk out of a directory this is meant to keep the caller out of.
fn is_inside(path: &Path, dir: &Path) -> bool {
    std::fs::canonicalize(dir).map(|d| path.starts_with(d)).unwrap_or(false)
}

/// Resolve and vet a path the renderer named, before a single byte behind it is read
/// or handed out.
///
/// Canonicalising first is what makes the rest mean anything: it settles `..`, follows
/// symlinks, and fails outright if the file is not there, so every check below is
/// against the real target rather than the spelling of it.
///
/// The extension allowlist is the substantive limit. The renderer is only ever supposed
/// to name a file the user picked in Explorer or a dialog, so in normal operation it
/// costs nothing; what it buys is that a renderer which has been taken over cannot name
/// this app's own key material, its log, an SSH key or a password vault, because none
/// of those are photos. Refusing the app's data directory outright closes the same door
/// against a secret that has been given a photo's extension.
pub(crate) fn checked_media_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let resolved =
        std::fs::canonicalize(path).map_err(|_| "that file could not be found".to_string())?;
    if !resolved.is_file() {
        return Err("that path is not a file".into());
    }
    let ext = extension_of(&resolved.to_string_lossy());
    if media_entry(&ext).is_none() {
        return Err("that file is not a photo or a video".into());
    }
    if let Ok(data) = secure_store::app_dir(app) {
        if is_inside(&resolved, &data) {
            return Err("that file belongs to the app".into());
        }
    }
    Ok(resolved)
}

// ---- What a local file says about itself ----

/// Everything the viewer needs about one file on disk, read without the sidecar and
/// without decoding a single pixel.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileInfo {
    /// Canonical, and the path every other command here should be given back.
    path: String,
    name: String,
    size: u64,
    /// Unix milliseconds.
    modified: i64,
    created: Option<i64>,
    mime: String,
    /// As displayed, not as stored: a photo whose EXIF orientation turns it on its side
    /// reports the turned dimensions, because that is what both display routes produce.
    width: Option<u32>,
    height: Option<u32>,
    capture_time: Option<i64>,
    camera: Option<String>,
    /// True when the engine cannot draw this one and `decode_preview` is the route.
    /// Never true for a video.
    needs_decode: bool,
    /// Whether `rename_local_file` would accept this one, so the control can be absent
    /// rather than present and failing.
    can_rename: bool,
}

/// Unix milliseconds from a filesystem timestamp. Dates before 1970 come back as the
/// error's own duration, so they are negated rather than lost.
fn unix_ms(t: std::time::SystemTime) -> i64 {
    match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// Days from 1970-01-01 to a civil date, by Howard Hinnant's algorithm. No calendar
/// table and no date dependency, and correct across leap years and centuries.
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146_097 + doe - 719_468
}

/// A civil date and time read as UTC, in unix milliseconds.
fn civil_to_unix_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, ms: u32) -> i64 {
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h as i64 * 3_600 + mi as i64 * 60 + s as i64;
    secs * 1_000 + ms as i64
}

/// Reject a timestamp whose fields cannot be a date. `DateTime::from_ascii`
/// deliberately does not range-check, so a corrupt tag can arrive as month 19, and
/// silently turning that into some other day is worse than reporting no capture time.
fn plausible_civil(y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8) -> bool {
    (1826..=9999).contains(&y)
        && (1..=12).contains(&mo)
        // Against the month's real length, not a flat 31. `days_from_civil` does no
        // validating of its own, so a February the 31st would come back as March the
        // 2nd: a date the file never claimed, reported as if the camera had.
        && (1..=days_in_month(y, mo)).contains(&d)
        && h <= 23
        && mi <= 59
        // A leap second is a real value in this field.
        && s <= 60
}

fn is_leap_year(y: u16) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: u16, mo: u8) -> u8 {
    match mo {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(y) => 29,
        2 => 28,
        _ => 0,
    }
}

/// An EXIF capture time as an instant.
///
/// The tag is a bare wall clock with no zone. When the file also carries
/// `OffsetTimeOriginal` that is exact and settles it. When it does not, the only
/// defensible reading is the machine's own zone on that date, which Windows resolves
/// below including whichever DST rule was in force, so a photo taken at home reports the
/// time it was taken. Elsewhere the wall clock is read as UTC, because there is nothing
/// better to hand.
fn exif_unix_ms(dt: &exif::DateTime) -> Option<i64> {
    if !plausible_civil(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second) {
        return None;
    }
    let ms = dt.nanosecond.unwrap_or(0) / 1_000_000;
    let wall = |y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8| {
        civil_to_unix_ms(y as i32, mo as u32, d as u32, h as u32, mi as u32, s as u32, ms)
    };
    if let Some(offset) = dt.offset {
        return Some(
            wall(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second)
                - offset as i64 * 60_000,
        );
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::SYSTEMTIME;
        use windows::Win32::System::Time::TzSpecificLocalTimeToSystemTime;

        let local = SYSTEMTIME {
            wYear: dt.year,
            wMonth: dt.month as u16,
            wDay: dt.day as u16,
            wHour: dt.hour as u16,
            wMinute: dt.minute as u16,
            wSecond: dt.second as u16,
            wDayOfWeek: 0,
            wMilliseconds: 0,
        };
        let mut utc = SYSTEMTIME::default();
        if unsafe { TzSpecificLocalTimeToSystemTime(None, &local, &mut utc) }.is_ok() {
            return Some(wall(
                utc.wYear,
                utc.wMonth as u8,
                utc.wDay as u8,
                utc.wHour as u8,
                utc.wMinute as u8,
                utc.wSecond as u8,
            ));
        }
    }
    Some(wall(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second))
}

/// One readable camera name out of the two tags that carry it. Most bodies repeat the
/// make inside the model ("Canon" plus "Canon EOS R5"), so the make is only prefixed
/// when the model does not already start with it.
fn camera_label(make: Option<&str>, model: Option<&str>) -> Option<String> {
    let make = make.map(str::trim).filter(|s| !s.is_empty());
    let model = model.map(str::trim).filter(|s| !s.is_empty());
    match (make, model) {
        (Some(make), Some(model)) => {
            // Against the first word of the make, not all of it. EXIF records a company
            // where the model records a brand ("NIKON CORPORATION" against "NIKON Z 6"),
            // so comparing the whole thing misses the repeat it is here to catch.
            let brand = make.split_whitespace().next().unwrap_or(make);
            if model.to_lowercase().starts_with(&brand.to_lowercase()) {
                Some(model.to_string())
            } else {
                Some(format!("{make} {model}"))
            }
        }
        (None, Some(model)) => Some(model.to_string()),
        (Some(make), None) => Some(make.to_string()),
        (None, None) => None,
    }
}

/// Whether an EXIF orientation turns the image onto its other edge, in which case the
/// stored dimensions are the wrong way round for display.
fn orientation_swaps_axes(orientation: u32) -> bool {
    (5..=8).contains(&orientation)
}

/// The image half of the answer: dimensions, capture time and camera. Every miss is
/// `None` rather than an error, because a video, a file with no EXIF block and a file
/// with a corrupt one all mean the same thing to the caller.
#[derive(Default)]
struct ImageDetails {
    width: Option<u32>,
    height: Option<u32>,
    capture_time: Option<i64>,
    camera: Option<String>,
}

/// The ASCII value of one EXIF tag, trimmed, or `None` when it is absent or blank.
fn ascii_field(meta: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let field = meta.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Ascii(ref parts) = field.value else {
        return None;
    };
    let text = String::from_utf8_lossy(parts.first()?).trim().to_string();
    (!text.is_empty()).then_some(text)
}

/// Read the header, not the image. Both readers stop within the first few kilobytes for
/// every format that matters, so a 100 megapixel file costs what a small one does and
/// nothing is ever held in memory that the caller did not ask for.
fn read_image_details(path: &Path) -> ImageDetails {
    let mut details = ImageDetails::default();
    let Ok(file) = std::fs::File::open(path) else {
        return details;
    };
    let mut reader = std::io::BufReader::new(file);

    if let Ok(size) = imagesize::reader_size(&mut reader) {
        details.width = Some(size.width as u32);
        details.height = Some(size.height as u32);
    }

    use std::io::Seek;
    if reader.rewind().is_err() {
        return details;
    }
    let Ok(meta) = exif::Reader::new().read_from_container(&mut reader) else {
        return details;
    };

    if let Some(field) = meta.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        if let exif::Value::Ascii(ref parts) = field.value {
            if let Some(raw) = parts.first() {
                if let Ok(mut dt) = exif::DateTime::from_ascii(raw) {
                    if let Some(offset) =
                        ascii_field(&meta, exif::Tag::OffsetTimeOriginal)
                    {
                        let _ = dt.parse_offset(offset.as_bytes());
                    }
                    details.capture_time = exif_unix_ms(&dt);
                }
            }
        }
    }

    details.camera = camera_label(
        ascii_field(&meta, exif::Tag::Make).as_deref(),
        ascii_field(&meta, exif::Tag::Model).as_deref(),
    );

    // The dimensions are reported as displayed, so a phone photo held sideways lays out
    // at the shape it will actually appear in. Both display routes end upright: the
    // engine applies this tag itself for an ordinary image, and `decode_preview` bakes
    // the rotation in because the JPEG it writes carries no metadata to apply.
    let swap = meta
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map(orientation_swaps_axes)
        .unwrap_or(false);
    if swap {
        std::mem::swap(&mut details.width, &mut details.height);
    }
    details
}

/// Everything about one local file, with no vault and no sign-in.
///
/// Asynchronous because the reads are blocking, and one of them can be slow for a reason
/// worth naming: a file inside the Explorer mount is a placeholder, and opening it is
/// what pulls it down. That is the right outcome for a file the user just asked to open,
/// but it must not happen on the thread that paints the window.
#[tauri::command]
pub async fn local_file_info(app: AppHandle, path: String) -> Result<LocalFileInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = checked_media_path(&app, &path)?;
        let meta = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
        let shown = crate::strip_verbatim(resolved.clone());
        let name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let ext = extension_of(&name);
        let details = read_image_details(&resolved);

        // A rename would either be refused outright or fail at the filesystem, and the
        // frontend would rather not offer it than show an error afterwards.
        let can_rename = !meta.permissions().readonly()
            && !is_inside(&resolved, &crate::cloud_mount::sync_root_path());

        Ok(LocalFileInfo {
            path: shown.to_string_lossy().into_owned(),
            name,
            size: meta.len(),
            modified: meta.modified().map(unix_ms).unwrap_or(0),
            created: meta.created().ok().map(unix_ms),
            mime: mime_for_extension(&ext).to_string(),
            width: details.width,
            height: details.height,
            capture_time: details.capture_time,
            camera: details.camera,
            needs_decode: needs_decode(&ext),
            can_rename,
        })
    })
    .await
    .map_err(|e| format!("reading that file failed: {e}"))?
}

// ---- Handing one file to the webview ----

/// Percent-encode exactly as JavaScript's `encodeURIComponent` does, which is what
/// Tauri's own `convertFileSrc` uses and what the asset protocol decodes on the other
/// side. Any disagreement here surfaces as a 403 rather than as a wrong character.
fn encode_uri_component(s: &str) -> String {
    const KEEP: &[u8] = b"-_.!~*'()";
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || KEEP.contains(b) {
            out.push(*b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

/// The asset protocol's URL for one path. The Windows form is the one named in the CSP
/// in tauri.conf.json, and the two have to keep saying the same thing.
fn asset_url(path: &Path) -> String {
    let encoded = encode_uri_component(&path.to_string_lossy());
    if cfg!(windows) {
        format!("http://asset.localhost/{encoded}")
    } else {
        format!("asset://localhost/{encoded}")
    }
}

/// Admit one file to the asset protocol and return the URL for it.
///
/// What this widens, stated plainly: after this call the renderer can read that file's
/// bytes, and it chose the file by naming it. The scope's configured glob is untouched,
/// so nothing else in it changes, but the renderer can call this again for another path
/// and be admitted to that one too. A renderer under someone else's control could
/// therefore read any photo or video on the disk that this Windows user can read.
///
/// It cannot reach anything else. `checked_media_path` resolves the path first, so `..`
/// buys nothing, and then refuses everything outside the media table and everything
/// inside the app's own data directory, which is where the sealed keys and the log live.
/// That is the trade: a photo viewer's renderer may reach photos, and may not reach
/// secrets.
#[tauri::command]
pub fn local_file_url(app: AppHandle, path: String) -> Result<String, String> {
    let resolved = checked_media_path(&app, &path)?;
    app.asset_protocol_scope()
        .allow_file(&resolved)
        .map_err(|e| format!("that file could not be opened for viewing: {e}"))?;
    // Admitted verbatim, handed back stripped: Tauri registers both spellings for a
    // verbatim path, and the stripped one is what belongs in a URL.
    Ok(asset_url(&crate::strip_verbatim(resolved)))
}

// ---- Formats the engine cannot draw ----
//
// HEIC above all, and TIFF and the raw formats behind it. The decoding is Windows' own
// through WIC, never a codec bundled here, which is what keeps the app out of the
// business of shipping and patching image decoders. The cost of that choice is that a
// machine without the HEIF and HEVC media extensions cannot open a HEIC at all, and
// `ERR_NO_CODEC` exists so the frontend can say precisely that instead of "failed".

/// Windows has no decoder registered for this format. For a HEIC that means the HEIF or
/// HEVC media extensions are not installed, which is the one failure here with a real
/// answer for the user. Matched exactly by the frontend, so it must never be reworded.
pub const ERR_NO_CODEC: &str = "decode_preview/no-codec";

/// The longest edge a decoded preview is given. Above this the picture is scaled down on
/// the way through, which no display can show the difference of and which keeps a very
/// large raw file from costing minutes and gigabytes. An ordinary phone photo is well
/// under it and is never touched.
const PREVIEW_MAX_EDGE: u32 = 4096;

/// The one decoded preview that exists at a time. Replacing it deletes the previous
/// file, so a session of stepping through HEICs does not leave a pile of decoded
/// pictures in the temp folder.
#[derive(Default)]
pub struct StagedPreview(Mutex<Option<PathBuf>>);

/// The target size for the scaler, or `None` when the picture already fits. The aspect
/// ratio is preserved and neither edge is ever allowed to reach zero.
fn scaled_to_fit(width: u32, height: u32, max_edge: u32) -> Option<(u32, u32)> {
    let longest = width.max(height);
    if longest <= max_edge || longest == 0 {
        return None;
    }
    let scale = max_edge as f64 / longest as f64;
    Some((
        ((width as f64 * scale).round() as u32).max(1),
        ((height as f64 * scale).round() as u32).max(1),
    ))
}

/// EXIF orientation as the WIC transform that undoes it, as the raw bits so the mapping
/// can be checked without a Windows type in the way. `None` for an upright image, and
/// for any value outside the eight the tag defines.
fn wic_transform_for(orientation: u32) -> Option<i32> {
    // WIC's own values: rotate 90/180/270 are 1/2/3, flip horizontal is 8, flip
    // vertical is 16, and a rotation may be combined with a flip.
    const ROTATE_90: i32 = 1;
    const ROTATE_180: i32 = 2;
    const ROTATE_270: i32 = 3;
    const FLIP_H: i32 = 8;
    const FLIP_V: i32 = 16;
    match orientation {
        2 => Some(FLIP_H),
        3 => Some(ROTATE_180),
        4 => Some(FLIP_V),
        5 => Some(ROTATE_90 | FLIP_H),
        6 => Some(ROTATE_90),
        7 => Some(ROTATE_270 | FLIP_H),
        8 => Some(ROTATE_270),
        _ => None,
    }
}

/// The EXIF orientation of one file, for baking into a decoded preview. Read separately
/// from `read_image_details` because the decode path needs it on its own and re-reading
/// a header costs nothing.
fn orientation_of(path: &Path) -> u32 {
    let Ok(file) = std::fs::File::open(path) else {
        return 1;
    };
    let mut reader = std::io::BufReader::new(file);
    exif::Reader::new()
        .read_from_container(&mut reader)
        .ok()
        .and_then(|m| {
            m.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
                .and_then(|f| f.value.get_uint(0))
        })
        .unwrap_or(1)
}

/// Decode `src` with the OS and write it out as a JPEG at `dest`.
///
/// Scaled down if it is enormous, and turned upright if its EXIF says so, because the
/// JPEG written here carries no metadata for the engine to apply afterwards.
#[cfg(windows)]
fn decode_with_wic(src: &Path, dest: &Path, orientation: u32) -> Result<(), String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Foundation::{
        GENERIC_READ, RPC_E_CHANGED_MODE, WINCODEC_ERR_COMPONENTNOTFOUND,
    };
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, WICBitmapInterpolationModeFant, WICBitmapTransformOptions,
        WICDecodeMetadataCacheOnDemand,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    unsafe {
        // Deliberately never uninitialised. This runs on a pooled blocking thread, and
        // tearing COM down under a later user of that same thread would be worse than
        // leaving one apartment reference behind. A thread already in a single-threaded
        // apartment reports RPC_E_CHANGED_MODE and is just as usable for WIC.
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return Err("the imaging component could not be started".into());
        }

        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|_| "the imaging component is unavailable".to_string())?;

        let decoder = factory
            .CreateDecoderFromFilename(
                &HSTRING::from(src),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .map_err(|e| {
                if e.code() == WINCODEC_ERR_COMPONENTNOTFOUND {
                    ERR_NO_CODEC.to_string()
                } else {
                    "this file could not be decoded".to_string()
                }
            })?;

        let frame = decoder
            .GetFrame(0)
            .map_err(|_| "this file holds no readable image".to_string())?;

        let mut width = 0u32;
        let mut height = 0u32;
        frame
            .GetSize(&mut width, &mut height)
            .map_err(|_| "this image reports no size".to_string())?;

        let mut source: IWICBitmapSource = frame.cast().map_err(|_| "unreadable image".to_string())?;

        if let Some((target_w, target_h)) = scaled_to_fit(width, height, PREVIEW_MAX_EDGE) {
            let scaler = factory
                .CreateBitmapScaler()
                .map_err(|_| "this image could not be resized".to_string())?;
            scaler
                .Initialize(&source, target_w, target_h, WICBitmapInterpolationModeFant)
                .map_err(|_| "this image could not be resized".to_string())?;
            source = scaler.cast().map_err(|_| "unreadable image".to_string())?;
        }

        if let Some(transform) = wic_transform_for(orientation) {
            let rotator = factory
                .CreateBitmapFlipRotator()
                .map_err(|_| "this image could not be turned upright".to_string())?;
            rotator
                .Initialize(&source, WICBitmapTransformOptions(transform))
                .map_err(|_| "this image could not be turned upright".to_string())?;
            source = rotator.cast().map_err(|_| "unreadable image".to_string())?;
        }

        encode_jpeg(&factory, &source, dest)?;
    }
    Ok(())
}

/// Write one WIC image out as a JPEG file.
///
/// The tail of every decode here, shared rather than repeated: this path and the upload
/// frame grabber both end with a WIC source that has to become a JPEG on disk, and a
/// second copy of the encoder chain would be a second place for the pixel format and the
/// committed size to drift out of agreement.
///
/// Whatever is handed in is written as it stands. Scaling and turning upright belong to
/// the caller, because only the caller knows whether its source has already had them
/// applied.
#[cfg(windows)]
pub(crate) fn encode_jpeg(
    factory: &IWICImagingFactory,
    source: &IWICBitmapSource,
    dest: &Path,
) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::GENERIC_WRITE;
    use windows::Win32::Graphics::Imaging::{
        GUID_ContainerFormatJpeg, GUID_WICPixelFormat24bppBGR, IWICBitmapEncoder,
        WICBitmapDitherTypeNone, WICBitmapEncoderNoCache, WICBitmapPaletteTypeCustom,
    };

    unsafe {
        let converter = factory
            .CreateFormatConverter()
            .map_err(|_| "this image could not be converted".to_string())?;
        converter
            .Initialize(
                source,
                &GUID_WICPixelFormat24bppBGR,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|_| "this image could not be converted".to_string())?;

        // The size to encode is asked of the last step in the chain rather than worked
        // out, so a scale and a quarter turn cannot disagree about which way round it
        // ended up.
        let mut out_w = 0u32;
        let mut out_h = 0u32;
        converter
            .GetSize(&mut out_w, &mut out_h)
            .map_err(|_| "this image reports no size".to_string())?;

        let stream = factory
            .CreateStream()
            .map_err(|_| "the preview could not be written".to_string())?;
        stream
            .InitializeFromFilename(&HSTRING::from(dest), GENERIC_WRITE.0)
            .map_err(|_| "the preview could not be written".to_string())?;

        let encoder: IWICBitmapEncoder = factory
            .CreateEncoder(&GUID_ContainerFormatJpeg, std::ptr::null())
            .map_err(|_| "the preview could not be encoded".to_string())?;
        encoder
            .Initialize(&stream, WICBitmapEncoderNoCache)
            .map_err(|_| "the preview could not be encoded".to_string())?;

        let mut out_frame = None;
        let mut options = None;
        encoder
            .CreateNewFrame(&mut out_frame, &mut options)
            .map_err(|_| "the preview could not be encoded".to_string())?;
        let out_frame = out_frame.ok_or("the preview could not be encoded")?;

        out_frame
            .Initialize(options.as_ref())
            .map_err(|_| "the preview could not be encoded".to_string())?;
        out_frame
            .SetSize(out_w, out_h)
            .map_err(|_| "the preview could not be encoded".to_string())?;
        // In and out: WIC reports back the format it settled on, which need not be the
        // one asked for.
        let mut format = GUID_WICPixelFormat24bppBGR;
        out_frame
            .SetPixelFormat(&mut format)
            .map_err(|_| "the preview could not be encoded".to_string())?;
        out_frame
            .WriteSource(&converter, std::ptr::null())
            .map_err(|_| "this image could not be decoded".to_string())?;
        out_frame
            .Commit()
            .map_err(|_| "the preview could not be written".to_string())?;
        encoder
            .Commit()
            .map_err(|_| "the preview could not be written".to_string())?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn decode_with_wic(_src: &Path, _dest: &Path, _orientation: u32) -> Result<(), String> {
    Err(ERR_NO_CODEC.to_string())
}

/// A name no other staged file can collide with, from the same source of randomness the
/// store's keys come from.
pub(crate) fn staged_name() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut raw = [0u8; 16];
    aes_gcm::aead::OsRng.fill_bytes(&mut raw);
    let hex: String = raw.iter().map(|b| format!("{b:02x}")).collect();
    format!("local-{hex}.jpg")
}

/// Decode one file the webview cannot draw and hand back a URL it can.
///
/// Staged in the same folder as the viewer's full-resolution originals, which is the
/// only folder the asset protocol's configured scope names, so no path has to be
/// admitted for it and the startup sweep that empties that folder cleans these up as
/// well.
#[tauri::command]
pub async fn decode_preview(app: AppHandle, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = checked_media_path(&app, &path)?;

        let dir = std::env::temp_dir().join("pfp-view");
        std::fs::create_dir_all(&dir)
            .map_err(|_| "the preview folder could not be created".to_string())?;
        let dest = dir.join(staged_name());

        let orientation = orientation_of(&resolved);
        if let Err(e) = decode_with_wic(&resolved, &dest, orientation) {
            // A half-written file is worse than none: the sweep would leave it until the
            // next start and the viewer might be handed it in the meantime.
            let _ = std::fs::remove_file(&dest);
            if e == ERR_NO_CODEC {
                crate::note(&app, "[local] decode: Windows has no codec for this format");
            }
            return Err(e);
        }

        // One at a time, as with the cloud originals. A failure to delete is not worth
        // reporting: the file is in the folder the startup sweep empties.
        let previous = app
            .state::<StagedPreview>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(dest.clone());
        if let Some(previous) = previous {
            let _ = std::fs::remove_file(previous);
        }

        Ok(asset_url(&crate::strip_verbatim(dest)))
    })
    .await
    .map_err(|e| format!("decoding that file failed: {e}"))?
}

// ---- Renaming ----

/// Windows keeps a handful of names for devices, and they are reserved with or without
/// an extension: `CON.jpg` is as refused as `CON`.
const RESERVED_STEMS: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Vet a name typed by the user, and settle its extension.
///
/// `original_ext` is carried over when the new name has none, so renaming "DSC_0042.jpg"
/// to "Sunset" gives "Sunset.jpg" rather than a file Windows no longer knows how to
/// open. A name that does bring its own extension is taken at its word, because changing
/// the extension deliberately is a thing people do.
fn validate_new_name(new_name: &str, original_ext: &str) -> Result<String, String> {
    let name = new_name.trim();
    if name.is_empty() {
        return Err("a name cannot be empty".into());
    }
    // Separators first, so the message for a path is about the path rather than about
    // whichever reserved character it happened to contain.
    if name.contains('/') || name.contains('\\') {
        return Err("a name cannot contain a path".into());
    }
    if name == "." || name == ".." || name.bytes().all(|b| b == b'.') {
        return Err("that is not a name".into());
    }
    // A colon would name an alternate data stream, so this is not only about tidiness:
    // "photo.jpg:hidden" writes into a stream of the existing file.
    if let Some(bad) = name
        .chars()
        .find(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (*c as u32) < 0x20)
    {
        let shown = if (bad as u32) < 0x20 { ' ' } else { bad };
        return Err(format!("a name cannot contain {shown}"));
    }
    // Windows strips these silently, so the file would end up under a name other than
    // the one that was asked for.
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("a name cannot end with a dot or a space".into());
    }

    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED_STEMS.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return Err("that name is reserved by Windows".into());
    }

    let has_ext = Path::new(name).extension().is_some();
    let full = if has_ext || original_ext.is_empty() {
        name.to_string()
    } else {
        format!("{name}.{original_ext}")
    };

    // NTFS's own limit for one component. Checked on the final name, because the
    // extension carried over above counts towards it.
    if full.chars().count() > 255 {
        return Err("that name is too long".into());
    }
    Ok(full)
}

/// Rename one local file, and return its new full path.
///
/// Refused inside the Explorer mount, and that refusal is the point rather than a
/// limitation: those files are Cloud Filter placeholders whose identity the sync root
/// tracks, and the mount keeps its own index of them by uid. Renaming one behind both of
/// their backs leaves the placeholder state and that index describing a file that is no
/// longer there.
#[tauri::command]
pub fn rename_local_file(app: AppHandle, path: String, new_name: String) -> Result<String, String> {
    let resolved = checked_media_path(&app, &path)?;
    if is_inside(&resolved, &crate::cloud_mount::sync_root_path()) {
        return Err("files in the Proton Photos folder are renamed from the app".into());
    }

    let original_ext = resolved
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    let final_name = validate_new_name(&new_name, &original_ext)?;

    let parent = resolved.parent().ok_or("that file has no folder")?;
    let dest = parent.join(&final_name);

    // Two different files, one of which already exists. Compared canonically so that
    // changing only the letter case of a name, which Windows treats as the same file,
    // is not mistaken for a collision with itself.
    if dest.exists() {
        let same = std::fs::canonicalize(&dest).map(|d| d == resolved).unwrap_or(false);
        if !same {
            return Err("a file with that name is already here".into());
        }
    }

    move_file(&resolved, &dest)?;
    Ok(crate::strip_verbatim(dest).to_string_lossy().into_owned())
}

/// Send one local file to the recycle bin.
///
/// Refused inside the Explorer mount for the same reason renaming is: those files are
/// placeholders the sync root tracks, and taking one out from under it leaves the mount
/// describing something that is no longer there. Photos in Drive are removed from the
/// app's own grid, which knows how to tell Proton about it.
///
/// The recycle bin rather than an outright delete, because this is reachable from a
/// window that opens on a double-click in Explorer, and a viewer is not where anyone
/// expects to lose a file for good.
#[tauri::command]
pub fn delete_local_file(app: AppHandle, path: String) -> Result<(), String> {
    let resolved = checked_media_path(&app, &path)?;
    if is_inside(&resolved, &crate::cloud_mount::sync_root_path()) {
        return Err("files in the Proton Photos folder are removed from the app".into());
    }
    recycle(&resolved)
}

/// Hand a path to the shell's own delete, which is what puts it somewhere recoverable.
///
/// `IFileOperation` rather than the older `SHFileOperationW`. The old call treats
/// `FOF_ALLOWUNDO` as a preference: where the bin cannot take the file it deletes it
/// outright and still reports success, so "moved to the recycle bin" quietly becomes
/// "gone" with nothing to say so. That is the wrong way for a mistake to go.
///
/// `FOFX_RECYCLEONDELETE` is the difference. It makes recycling the operation rather
/// than a wish: if the item cannot go to the bin the call FAILS, and the file is still
/// there to try something else with. Nothing here can delete anything for good.
///
/// COM has to be up on this thread first. A Tauri command runs on a pool thread that
/// has never initialised it, and the shell object cannot be created without it.
#[cfg(windows)]
fn recycle(path: &Path) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, SHCreateItemFromParsingName, IShellItem, FOFX_RECYCLEONDELETE,
        FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    };

    let wide = HSTRING::from(crate::strip_verbatim(path.to_path_buf()).as_os_str());

    unsafe {
        // Ignored on purpose: a thread already initialised for another apartment
        // answers RPC_E_CHANGED_MODE, which is not a reason to refuse the delete.
        let started = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| -> Result<(), String> {
            let op: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_ALL).map_err(|_| ERR)?;
            op.SetOperationFlags(
                FOFX_RECYCLEONDELETE | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI,
            )
            .map_err(|_| ERR)?;
            let item: IShellItem = SHCreateItemFromParsingName(&wide, None).map_err(|_| ERR)?;
            op.DeleteItem(&item, None).map_err(|_| ERR)?;
            op.PerformOperations().map_err(|_| ERR)?;
            // The shell reports a cancelled batch through this rather than as an error,
            // so without it a file still sitting there would read as one that had gone.
            if op.GetAnyOperationsAborted().map_err(|_| ERR)?.as_bool() {
                return Err("cancelled".into());
            }
            Ok(())
        })();
        if started {
            CoUninitialize();
        }
        result
    }
}

/// One message for every way the shell can refuse. Which COM call failed is no help to
/// anyone reading it, and the file is still there either way.
#[cfg(windows)]
const ERR: &str = "that file could not be moved to the recycle bin";

/// Proof that a delete is recoverable, which is the one thing about it that cannot be
/// read off the code: the earlier attempt at this compiled, ran, reported success, and
/// destroyed the file anyway.
///
/// Ignored by default because it is the rare test that touches something outside its
/// own temp directory: it puts one small file in the real recycle bin and leaves it
/// there, since taking it back out again would undo the very thing being proved. Run
/// it by name after changing anything in `recycle`.
#[cfg(all(test, windows))]
mod recycle_tests {
    use super::*;

    /// How many items the recycle bin is holding, across every drive.
    fn bin_items() -> i64 {
        use windows::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
        let mut info = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            ..Default::default()
        };
        unsafe { SHQueryRecycleBinW(None, &mut info) }.ok();
        info.i64NumItems
    }

    #[test]
    #[ignore = "puts a file in the real recycle bin; run by name"]
    fn a_deleted_file_lands_in_the_recycle_bin() {
        let path = std::env::temp_dir().join(format!("pfp-recycle-{}.jpg", std::process::id()));
        std::fs::write(&path, b"not a real photo").unwrap();
        let before = bin_items();

        recycle(&path).expect("the shell should have taken it");

        assert!(!path.exists(), "the file should be gone from where it was");
        assert_eq!(
            bin_items(),
            before + 1,
            "and it should be in the recycle bin, not destroyed"
        );
    }
}

#[cfg(not(windows))]
fn recycle(path: &Path) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

/// Move a file, refusing rather than overwriting.
///
/// `std::fs::rename` maps to MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows, which
/// destroys whatever is at the destination. Calling MoveFileEx directly without that flag
/// makes the check above atomic instead of advisory, so a file that appears between the
/// check and the move is not silently lost.
#[cfg(windows)]
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_COPY_ALLOWED};

    unsafe { MoveFileExW(&HSTRING::from(from), &HSTRING::from(to), MOVEFILE_COPY_ALLOWED) }
        .map_err(|_| "that file could not be renamed".to_string())
}

#[cfg(not(windows))]
fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|_| "that file could not be renamed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_media_table_answers_all_three_questions() {
        assert_eq!(mime_for_extension("jpg"), "image/jpeg");
        assert_eq!(mime_for_extension("JPG"), "application/octet-stream", "the caller lowercases");
        assert_eq!(mime_for_extension("heic"), "image/heic");
        assert_eq!(mime_for_extension("mp4"), "video/mp4");
        assert_eq!(mime_for_extension("exe"), "application/octet-stream");
        assert_eq!(mime_for_extension(""), "application/octet-stream");

        assert!(is_webview_drawable("png"));
        assert!(!is_webview_drawable("heic"));
        assert!(!is_webview_drawable("txt"));

        // Only a still the engine cannot draw takes the decode route. A container it
        // will not play cannot be helped by a JPEG encoder, so it is never flagged.
        assert!(needs_decode("heic"));
        assert!(needs_decode("cr2"));
        assert!(!needs_decode("jpg"));
        assert!(!needs_decode("mkv"), "a video is never sent to the still decoder");
        assert!(!needs_decode("txt"));
    }

    #[test]
    fn svg_is_not_a_local_photo() {
        // The one image type that carries markup, left out on purpose.
        assert!(media_entry("svg").is_none());
    }

    #[test]
    fn an_extension_is_taken_from_the_end_and_lowercased() {
        assert_eq!(extension_of("a.JPG"), "jpg");
        assert_eq!(extension_of("holiday.2024.heic"), "heic");
        assert_eq!(extension_of("noext"), "");
        assert_eq!(extension_of(".hidden"), "", "a dotfile has no extension of its own");
    }

    #[test]
    fn a_uri_component_matches_the_javascript_one() {
        // The unreserved set encodeURIComponent leaves alone, verbatim.
        assert_eq!(encode_uri_component("aZ09-_.!~*'()"), "aZ09-_.!~*'()");
        assert_eq!(encode_uri_component(r"C:\a b\x.jpg"), "C%3A%5Ca%20b%5Cx.jpg");
        // Multi-byte characters are escaped one UTF-8 byte at a time, uppercase hex.
        assert_eq!(encode_uri_component("é"), "%C3%A9");
        assert_eq!(encode_uri_component("/"), "%2F");
    }

    #[test]
    fn a_name_may_not_carry_a_path_or_a_stream() {
        for bad in [r"..\..\evil.jpg", "sub/dir.jpg", r"sub\dir.jpg", "..", "."] {
            assert!(validate_new_name(bad, "jpg").is_err(), "accepted {bad}");
        }
        // A colon opens an alternate data stream on an existing file rather than
        // creating a new one.
        assert!(validate_new_name("photo.jpg:hidden", "jpg").is_err());
        assert!(validate_new_name("C:photo.jpg", "jpg").is_err());
    }

    #[test]
    fn a_name_may_not_be_reserved_or_shaped_like_a_trap() {
        for bad in ["CON", "con.jpg", "NUL.jpeg", "lpt1", "COM9.png"] {
            assert!(validate_new_name(bad, "jpg").is_err(), "accepted {bad}");
        }
        for bad in ["a<b", "a>b", "a\"b", "a|b", "a?b", "a*b", "a\u{7}b"] {
            assert!(validate_new_name(bad, "jpg").is_err(), "accepted {bad}");
        }
        // Windows strips a trailing dot or space, so the result would not be the name
        // that was asked for.
        assert!(validate_new_name("photo.", "jpg").is_err());
        assert!(validate_new_name("photo .jpg ", "jpg").is_ok(), "the outer trim handles this");
        assert!(validate_new_name("", "jpg").is_err());
        assert!(validate_new_name("   ", "jpg").is_err());
        assert!(validate_new_name(&"a".repeat(300), "jpg").is_err());
        // The carried extension counts towards the limit.
        assert!(validate_new_name(&"a".repeat(253), "jpg").is_err());
    }

    #[test]
    fn an_extension_is_kept_unless_it_was_clearly_changed() {
        assert_eq!(validate_new_name("Sunset", "jpg").unwrap(), "Sunset.jpg");
        assert_eq!(validate_new_name("Sunset.png", "jpg").unwrap(), "Sunset.png");
        assert_eq!(validate_new_name("Sunset", "").unwrap(), "Sunset");
        assert_eq!(validate_new_name("  Sunset  ", "jpg").unwrap(), "Sunset.jpg");
        assert_eq!(validate_new_name("holiday.2024", "jpg").unwrap(), "holiday.2024");
    }

    #[test]
    fn only_an_absolute_plain_argument_is_a_file_to_open() {
        let argv = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();

        assert_eq!(launch_arg(&argv(&[])), None);
        assert_eq!(launch_arg(&argv(&["photosforproton.exe"])), None, "the exe alone is not a request");
        assert_eq!(launch_arg(&argv(&["photosforproton.exe", "--update"])), None, "a switch is not a file");
        assert_eq!(launch_arg(&argv(&["photosforproton.exe", "/S"])), None);
        assert_eq!(launch_arg(&argv(&["photosforproton.exe", "relative.jpg"])), None);

        #[cfg(windows)]
        {
            assert_eq!(launch_arg(&argv(&["photosforproton.exe", r"C:\a\b.jpg"])), Some(r"C:\a\b.jpg"));
            // The exe is index 0 in both shapes, including the plugin's argv where it is
            // the SECOND process's own path.
            assert_eq!(
                launch_arg(&argv(&[r"C:\install\photosforproton.exe", r"C:\a\b.jpg"])),
                Some(r"C:\a\b.jpg")
            );
            assert_eq!(
                launch_arg(&argv(&["photosforproton.exe", "--update", r"C:\a\b.jpg"])),
                Some(r"C:\a\b.jpg"),
                "a switch does not hide the file behind it"
            );
            assert_eq!(
                launch_arg(&argv(&["photosforproton.exe", r"C:\a\first.jpg", r"C:\a\second.jpg"])),
                Some(r"C:\a\first.jpg")
            );
        }
    }

    #[test]
    fn a_preview_is_only_scaled_when_it_is_too_large() {
        assert_eq!(scaled_to_fit(4032, 3024, 4096), None, "an ordinary phone photo is untouched");
        assert_eq!(scaled_to_fit(4096, 4096, 4096), None);
        assert_eq!(scaled_to_fit(8192, 4096, 4096), Some((4096, 2048)));
        assert_eq!(scaled_to_fit(4096, 8192, 4096), Some((2048, 4096)));
        assert_eq!(scaled_to_fit(0, 0, 4096), None, "nothing to scale");
        // An extreme panorama must not lose its short edge entirely.
        let (_, h) = scaled_to_fit(100_000, 10, 4096).unwrap();
        assert!(h >= 1, "an edge was rounded away");
    }

    #[test]
    fn every_exif_orientation_maps_to_the_transform_that_undoes_it() {
        const ROTATE_90: i32 = 1;
        const ROTATE_180: i32 = 2;
        const ROTATE_270: i32 = 3;
        const FLIP_H: i32 = 8;
        const FLIP_V: i32 = 16;

        assert_eq!(wic_transform_for(1), None, "upright already");
        assert_eq!(wic_transform_for(2), Some(FLIP_H));
        assert_eq!(wic_transform_for(3), Some(ROTATE_180));
        assert_eq!(wic_transform_for(4), Some(FLIP_V));
        assert_eq!(wic_transform_for(5), Some(ROTATE_90 | FLIP_H));
        assert_eq!(wic_transform_for(6), Some(ROTATE_90));
        assert_eq!(wic_transform_for(7), Some(ROTATE_270 | FLIP_H));
        assert_eq!(wic_transform_for(8), Some(ROTATE_270));
        assert_eq!(wic_transform_for(0), None, "an absent tag reads as upright");
        assert_eq!(wic_transform_for(99), None, "and so does a corrupt one");

        // The four that turn the picture onto its other edge are the four whose stored
        // dimensions are reported the other way round.
        for o in 1..=4 {
            assert!(!orientation_swaps_axes(o), "{o} does not swap");
        }
        for o in 5..=8 {
            assert!(orientation_swaps_axes(o), "{o} swaps");
        }
    }

    #[test]
    fn a_civil_date_converts_to_the_right_instant() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        // 2000 is a leap year, 1900 is not.
        assert_eq!(days_from_civil(2000, 3, 1) - days_from_civil(2000, 2, 28), 2);
        assert_eq!(days_from_civil(2001, 3, 1) - days_from_civil(2001, 2, 28), 1);

        assert_eq!(civil_to_unix_ms(1970, 1, 1, 0, 0, 0, 0), 0);
        assert_eq!(civil_to_unix_ms(1970, 1, 1, 0, 0, 1, 0), 1_000);
        assert_eq!(civil_to_unix_ms(1970, 1, 1, 0, 0, 0, 250), 250);
        // A known instant, checked against a value that is easy to look up.
        assert_eq!(civil_to_unix_ms(2024, 1, 1, 0, 0, 0, 0), 1_704_067_200_000);
        assert!(civil_to_unix_ms(1969, 7, 20, 20, 17, 40, 0) < 0, "before the epoch");
    }

    #[test]
    fn a_capture_time_with_a_zone_is_that_exact_instant() {
        let mut dt = exif::DateTime::from_ascii(b"2024:01:01 02:00:00").unwrap();
        dt.parse_offset(b"+02:00").unwrap();
        // 02:00 at UTC+2 is midnight UTC.
        assert_eq!(exif_unix_ms(&dt), Some(1_704_067_200_000));

        let mut west = exif::DateTime::from_ascii(b"2023:12:31 19:00:00").unwrap();
        west.parse_offset(b"-05:00").unwrap();
        assert_eq!(exif_unix_ms(&west), Some(1_704_067_200_000));
    }

    #[test]
    fn a_corrupt_capture_time_is_no_capture_time() {
        // from_ascii does not range-check, so this is the last line of defence against a
        // damaged tag becoming some other, plausible-looking day.
        let bad = exif::DateTime::from_ascii(b"2024:19:44 33:99:99").unwrap();
        assert_eq!(exif_unix_ms(&bad), None);
        assert!(!plausible_civil(2024, 13, 1, 0, 0, 0));
        assert!(!plausible_civil(2024, 1, 32, 0, 0, 0));
        assert!(!plausible_civil(2024, 1, 1, 24, 0, 0));
        assert!(plausible_civil(2024, 12, 31, 23, 59, 60), "a leap second is real");
        // A day past the month's end is the case a flat 1..=31 waved through, and it is
        // the damaging one: it is a real date, so nothing downstream can tell it apart
        // from one the camera actually recorded.
        assert!(!plausible_civil(2024, 2, 31, 12, 0, 0));
        assert!(!plausible_civil(2024, 4, 31, 12, 0, 0), "April has 30");
        assert!(plausible_civil(2024, 2, 29, 12, 0, 0), "2024 is a leap year");
        assert!(!plausible_civil(2023, 2, 29, 12, 0, 0), "2023 is not");
        assert!(!plausible_civil(1900, 2, 29, 12, 0, 0), "a century is not, unless");
        assert!(plausible_civil(2000, 2, 29, 12, 0, 0), "it divides by 400");
    }

    #[test]
    fn a_camera_is_named_once() {
        assert_eq!(camera_label(Some("Canon"), Some("Canon EOS R5")).as_deref(), Some("Canon EOS R5"));
        assert_eq!(camera_label(Some("Apple"), Some("iPhone 15 Pro")).as_deref(), Some("Apple iPhone 15 Pro"));
        assert_eq!(camera_label(Some("NIKON CORPORATION"), Some("NIKON Z 6")).as_deref(), Some("NIKON Z 6"));
        assert_eq!(camera_label(None, Some("Pixel 8")).as_deref(), Some("Pixel 8"));
        assert_eq!(camera_label(Some("Sony"), None).as_deref(), Some("Sony"));
        assert_eq!(camera_label(None, None), None);
        assert_eq!(camera_label(Some("  "), Some("")), None, "a blank tag is no tag");
    }

    #[test]
    fn a_filesystem_timestamp_survives_the_epoch() {
        use std::time::{Duration, UNIX_EPOCH};
        assert_eq!(unix_ms(UNIX_EPOCH), 0);
        assert_eq!(unix_ms(UNIX_EPOCH + Duration::from_millis(1_500)), 1_500);
        assert_eq!(unix_ms(UNIX_EPOCH - Duration::from_millis(1_500)), -1_500);
    }

    #[test]
    fn a_path_is_only_inside_a_folder_on_a_component_boundary() {
        let temp = std::env::temp_dir();
        let Ok(base) = std::fs::canonicalize(&temp) else {
            return;
        };
        assert!(is_inside(&base.join("a").join("b.jpg"), &temp));
        assert!(!is_inside(Path::new("C:").join("nowhere-at-all").as_path(), &temp));
        // A sibling whose name merely starts the same way is not inside.
        let sibling = base.parent().map(|p| p.join("Tempest").join("x.jpg"));
        if let Some(sibling) = sibling {
            assert!(!is_inside(&sibling, &base));
        }
    }
}
