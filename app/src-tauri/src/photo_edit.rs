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

// The local photo editor's two ends: hand a file to an in-browser canvas so it can be
// edited, and take the canvas back as a new file on disk.
//
// Both go through `local_file::checked_media_path`, so nothing here reaches a file the
// renderer was never meant to name, and neither touches the sidecar: editing a photo
// works with no vault and no sign-in, exactly as opening one from Explorer does.
//
// Two things set this apart from the plain viewer. The source has to arrive as a
// SAME-ORIGIN `data:` URL, because an asset-protocol URL is cross-origin and a canvas
// that draws from it is tainted and can no longer be read back. And it arrives at FULL
// resolution, upright, so the editor works on the real pixels and the file it saves is
// not a downscaled copy.
//
// A few EXIF and JPEG helpers here read the same tags `local_file` does, re-implemented
// rather than shared because those helpers are private to that module and this one does
// not own it. The calendar arithmetic is Howard Hinnant's, frozen, and the capture-time
// reading matches `local_file` deliberately so the editor and the viewer never disagree
// about when a photo was taken.

use std::path::Path;

use base64::Engine as _;
use little_exif::exif_tag::ExifTag;
use little_exif::filetype::FileExtension;
use little_exif::metadata::Metadata;
use little_exif::rational::uR64;
use tauri::AppHandle;

// ---- Handing a photo to the editor ----

/// Everything the editor needs to open one photo: the pixels as a canvas-readable data
/// URL, their upright size, and the metadata worth showing and carrying forward.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorSource {
    /// A `data:` URL, base64, same-origin on purpose. An asset URL would taint the
    /// canvas; this is the whole reason the command exists.
    data_url: String,
    /// Upright dimensions, matching the pixels in `data_url`.
    width: u32,
    height: u32,
    /// Unix milliseconds, read the same way the viewer reads it.
    capture_time: Option<i64>,
    camera: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
}

/// Read one local photo and prepare it for the in-browser editor.
///
/// Asynchronous for the same reason the viewer's reads are: the file may be a cloud
/// placeholder whose first read pulls it down, and a full-resolution decode is not work
/// for the thread that paints the window.
///
/// Orientation is always resolved to upright before the bytes leave here, by one of two
/// routes. A drawable file that is already upright is returned verbatim, no re-encode and
/// no quality lost. A drawable file whose EXIF turns it on its side, and every file the
/// engine cannot draw, is decoded by Windows at full resolution with the rotation baked
/// into the pixels. Either way the editor receives upright pixels and the size it is told
/// matches them, so the JPEG it saves is upright with Orientation = 1.
#[tauri::command]
pub async fn local_editor_source(app: AppHandle, path: String) -> Result<EditorSource, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = crate::local_file::checked_media_path(&app, &path)?;
        let ext = crate::local_file::extension_of(&resolved.to_string_lossy());
        let entry = crate::local_file::media_entry(&ext).ok_or("that file is not a photo")?;
        let (_, mime, drawable) = *entry;
        // A video is a photo to the allowlist but not to an image editor.
        if !mime.starts_with("image/") {
            return Err("only photos can be opened in the editor".into());
        }

        let meta = read_source_meta(&resolved);

        // The bytes reach the canvas one of two ways: verbatim when the file is already
        // both drawable and upright, decoded-and-baked otherwise. `raw_drawable_source`
        // answers `None` when it declines (not upright, or its size cannot be read
        // cheaply), and that is the signal to decode.
        let verbatim = drawable
            .then(|| raw_drawable_source(&resolved, mime, meta.orientation))
            .flatten();
        let (data_url, width, height) = match verbatim {
            Some(source) => source,
            None => decode_full_res_source(&resolved, meta.orientation)?,
        };

        Ok(EditorSource {
            data_url,
            width,
            height,
            capture_time: meta.capture_time,
            camera: meta.camera,
            latitude: meta.latitude,
            longitude: meta.longitude,
        })
    })
    .await
    .map_err(|e| format!("preparing that photo failed: {e}"))?
}

/// Return a drawable file verbatim as a data URL, or `None` to decline.
///
/// It declines in exactly the cases the editor must not receive raw bytes for: a
/// non-upright EXIF orientation, whose rotation the canvas cannot be trusted to apply,
/// and a file whose size cannot be read from its header, which would leave the editor
/// without dimensions. Both fall through to a full decode, which settles orientation and
/// size together.
///
/// When it does return bytes there is no re-encode: a JPEG stays the exact JPEG on disk,
/// full quality, and the only cost is the base64 the data URL requires.
fn raw_drawable_source(path: &Path, mime: &str, orientation: u32) -> Option<(String, u32, u32)> {
    if orientation != 1 {
        return None;
    }
    let (width, height) = header_dimensions(path)?;
    let bytes = std::fs::read(path).ok()?;
    Some((data_url(mime, &bytes), width, height))
}

/// Decode a file the engine cannot draw (or a drawable one that is on its side) at full
/// resolution, upright, as a JPEG data URL.
fn decode_full_res_source(path: &Path, orientation: u32) -> Result<(String, u32, u32), String> {
    let jpeg = decode_full_res_to_jpeg(path, orientation)?;
    let (width, height) =
        jpeg_sof_dimensions(&jpeg).ok_or("the decoded image reported no size")?;
    Ok((data_url("image/jpeg", &jpeg), width, height))
}

/// One `data:` URL, built into a single string with its capacity reserved up front so
/// the base64 is appended in place rather than encoded into a throwaway string first.
///
/// Peak memory for one call is the source bytes plus this string, roughly 2.3x the
/// encoded image: the input Vec (1x) and the URL (about 1.34x its input). For a 40 MB
/// JPEG that is near 95 MB held at once, which is the accepted price of editing at full
/// resolution and is documented here rather than hidden.
fn data_url(mime: &str, bytes: &[u8]) -> String {
    let mut url = String::with_capacity(mime.len() + 13 + (bytes.len() / 3 + 1) * 4);
    url.push_str("data:");
    url.push_str(mime);
    url.push_str(";base64,");
    base64::engine::general_purpose::STANDARD.encode_string(bytes, &mut url);
    url
}

// ---- Reading the source's own metadata ----

/// What one source file says about itself, read from its header without decoding pixels.
/// Both the editor (which shows the first four) and the saver (which re-attaches the
/// rest to a rebuilt EXIF block) draw from this.
struct SourceMeta {
    capture_time: Option<i64>,
    camera: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    /// The raw `DateTimeOriginal` string, kept for re-writing verbatim.
    date_original: Option<String>,
    make: Option<String>,
    model: Option<String>,
    /// The EXIF orientation, or 1 when absent or unreadable.
    orientation: u32,
}

impl Default for SourceMeta {
    fn default() -> Self {
        SourceMeta {
            capture_time: None,
            camera: None,
            latitude: None,
            longitude: None,
            date_original: None,
            make: None,
            model: None,
            orientation: 1,
        }
    }
}

/// The ASCII value of one EXIF tag, trimmed of surrounding space and its terminating NUL,
/// or `None` when it is absent or blank.
fn ascii_field(meta: &exif::Exif, tag: exif::Tag) -> Option<String> {
    let field = meta.get_field(tag, exif::In::PRIMARY)?;
    let exif::Value::Ascii(ref parts) = field.value else {
        return None;
    };
    let text = String::from_utf8_lossy(parts.first()?)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    (!text.is_empty()).then_some(text)
}

/// One signed decimal degree from a GPS coordinate: three rationals (degrees, minutes,
/// seconds) and a hemisphere reference. `None` unless every part is present and the
/// result lands in the coordinate's real range, so a corrupt block reads as no location
/// rather than as a point in the sea.
fn gps_decimal(
    meta: &exif::Exif,
    coord: exif::Tag,
    reference: exif::Tag,
    negative_ref: char,
    max_abs: f64,
) -> Option<f64> {
    let field = meta.get_field(coord, exif::In::PRIMARY)?;
    let exif::Value::Rational(ref parts) = field.value else {
        return None;
    };
    let (d, m, s) = (parts.first()?, parts.get(1)?, parts.get(2)?);
    let mut value = d.to_f64() + m.to_f64() / 60.0 + s.to_f64() / 3600.0;
    if !value.is_finite() || value > max_abs {
        return None;
    }
    let hemisphere = ascii_field(meta, reference)
        .and_then(|r| r.chars().next())
        .map(|c| c.to_ascii_uppercase());
    if hemisphere == Some(negative_ref) {
        value = -value;
    }
    Some(value)
}

/// Read the header, never the image. `kamadak-exif` stops within the first few kilobytes
/// for every container that matters, so a 100 megapixel file costs what a small one does.
fn read_source_meta(path: &Path) -> SourceMeta {
    let mut meta = SourceMeta::default();
    let Ok(file) = std::fs::File::open(path) else {
        return meta;
    };
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
        return meta;
    };

    meta.orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1);

    if let Some(field) = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY) {
        if let exif::Value::Ascii(ref parts) = field.value {
            if let Some(raw) = parts.first() {
                meta.date_original = {
                    let s = String::from_utf8_lossy(raw).trim_end_matches('\0').trim().to_string();
                    (!s.is_empty()).then_some(s)
                };
                if let Ok(mut dt) = exif::DateTime::from_ascii(raw) {
                    if let Some(offset) = ascii_field(&exif, exif::Tag::OffsetTimeOriginal) {
                        let _ = dt.parse_offset(offset.as_bytes());
                    }
                    meta.capture_time = exif_capture_ms(&dt);
                }
            }
        }
    }

    meta.make = ascii_field(&exif, exif::Tag::Make);
    meta.model = ascii_field(&exif, exif::Tag::Model);
    meta.camera = camera_label(meta.make.as_deref(), meta.model.as_deref());
    meta.latitude = gps_decimal(
        &exif,
        exif::Tag::GPSLatitude,
        exif::Tag::GPSLatitudeRef,
        'S',
        90.0,
    );
    meta.longitude = gps_decimal(
        &exif,
        exif::Tag::GPSLongitude,
        exif::Tag::GPSLongitudeRef,
        'W',
        180.0,
    );
    meta
}

/// One readable camera name from the make and model tags, with the make dropped when the
/// model already carries it ("Canon" plus "Canon EOS R5" is just "Canon EOS R5").
fn camera_label(make: Option<&str>, model: Option<&str>) -> Option<String> {
    let make = make.map(str::trim).filter(|s| !s.is_empty());
    let model = model.map(str::trim).filter(|s| !s.is_empty());
    match (make, model) {
        (Some(make), Some(model)) => {
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

// ---- Capture time (mirrors local_file so the editor and viewer never disagree) ----

fn is_leap_year(y: u16) -> bool {
    (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400)
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

/// Reject a timestamp whose fields cannot be a date. `DateTime::from_ascii` does not
/// range-check, so a corrupt tag can arrive as month 19, and turning that into some other
/// real day silently is worse than reporting no capture time.
fn plausible_civil(y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8) -> bool {
    (1826..=9999).contains(&y)
        && (1..=12).contains(&mo)
        && (1..=days_in_month(y, mo)).contains(&d)
        && h <= 23
        && mi <= 59
        && s <= 60
}

/// Days from 1970-01-01 to a civil date, by Howard Hinnant's algorithm.
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as i64;
    let mp = if month > 2 { month - 3 } else { month + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era as i64 * 146_097 + doe - 719_468
}

fn civil_to_unix_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32, ms: u32) -> i64 {
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h as i64 * 3_600 + mi as i64 * 60 + s as i64;
    secs * 1_000 + ms as i64
}

/// An EXIF capture time as an instant, read exactly as the viewer reads it: an explicit
/// offset settles it, otherwise the machine's own zone on that date (DST included) is the
/// only defensible reading, and only when that is unavailable is the wall clock taken as
/// UTC.
fn exif_capture_ms(dt: &exif::DateTime) -> Option<i64> {
    if !plausible_civil(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second) {
        return None;
    }
    let ms = dt.nanosecond.unwrap_or(0) / 1_000_000;
    let wall = |y: u16, mo: u8, d: u8, h: u8, mi: u8, s: u8| {
        civil_to_unix_ms(y as i32, mo as u32, d as u32, h as u32, mi as u32, s as u32, ms)
    };
    if let Some(offset) = dt.offset {
        return Some(
            wall(dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second) - offset as i64 * 60_000,
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

// ---- Full-resolution decode with Windows' own imaging component ----

/// EXIF orientation as the WIC transform that undoes it, expressed as the raw bits so the
/// mapping can be checked without a Windows type in the way. `None` for an upright image
/// and for any value outside the eight the tag defines.
fn wic_transform_for(orientation: u32) -> Option<i32> {
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

/// The image dimensions from a file's header, without decoding it.
fn header_dimensions(path: &Path) -> Option<(u32, u32)> {
    let size = imagesize::size(path).ok()?;
    Some((size.width as u32, size.height as u32))
}

/// Decode one file with the OS at FULL resolution, upright, into JPEG bytes.
///
/// Unlike the viewer's preview decode this applies no size cap: the editor works on the
/// real pixels. The rotation is baked in because the JPEG produced here carries no
/// orientation for the editor to apply afterwards. The tail is `local_file::encode_jpeg`,
/// reused through a staging file so the pixel-format and committed-size handling is not a
/// second copy that could drift from the viewer's.
///
/// Peak memory is WIC's decoded bitmap, about width x height x 3 bytes (roughly 300 MB
/// for a 100 megapixel image), plus the encoded JPEG. That ceiling is inherent to a
/// full-resolution decode and is the accepted cost of editing without downscaling.
#[cfg(windows)]
fn decode_full_res_to_jpeg(src: &Path, orientation: u32) -> Result<Vec<u8>, String> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::Foundation::{
        GENERIC_READ, RPC_E_CHANGED_MODE, WINCODEC_ERR_COMPONENTNOTFOUND,
    };
    use windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, IWICBitmapSource, IWICImagingFactory, WICBitmapTransformOptions,
        WICDecodeMetadataCacheOnDemand,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };

    let dir = std::env::temp_dir().join("pfp-edit");
    std::fs::create_dir_all(&dir)
        .map_err(|_| "the edit staging folder could not be created".to_string())?;
    let dest = dir.join(crate::local_file::staged_name());

    let decoded = (|| unsafe {
        // Never uninitialised, for the same reason the viewer's decode leaves it: this
        // runs on a pooled blocking thread, and tearing COM down under a later user of it
        // is worse than leaving one apartment reference behind.
        let hr = CoInitializeEx(None, COINIT_MULTITHREADED);
        if hr.is_err() && hr != RPC_E_CHANGED_MODE {
            return Err("the imaging component could not be started".to_string());
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
                    crate::local_file::ERR_NO_CODEC.to_string()
                } else {
                    "this file could not be decoded".to_string()
                }
            })?;

        let frame = decoder
            .GetFrame(0)
            .map_err(|_| "this file holds no readable image".to_string())?;
        let mut source: IWICBitmapSource =
            frame.cast().map_err(|_| "unreadable image".to_string())?;

        if let Some(transform) = wic_transform_for(orientation) {
            let rotator = factory
                .CreateBitmapFlipRotator()
                .map_err(|_| "this image could not be turned upright".to_string())?;
            rotator
                .Initialize(&source, WICBitmapTransformOptions(transform))
                .map_err(|_| "this image could not be turned upright".to_string())?;
            source = rotator.cast().map_err(|_| "unreadable image".to_string())?;
        }

        crate::local_file::encode_jpeg(&factory, &source, &dest)?;
        Ok(())
    })();

    let result = decoded.and_then(|()| {
        std::fs::read(&dest).map_err(|_| "the decoded image could not be read".to_string())
    });
    let _ = std::fs::remove_file(&dest);
    result
}

#[cfg(not(windows))]
fn decode_full_res_to_jpeg(_src: &Path, _orientation: u32) -> Result<Vec<u8>, String> {
    Err(crate::local_file::ERR_NO_CODEC.to_string())
}

// ---- Saving the edited photo ----

/// Save the canvas's edited JPEG next to the original, with the original's metadata
/// re-attached, and return the new file's path.
///
/// The canvas re-encode strips every tag, so the date, camera and location have to be
/// carried across by hand. How depends on the source. A JPEG's own EXIF segment is copied
/// wholesale, keeping every tag it holds down to the maker notes, and only its orientation
/// and pixel dimensions are patched in place; nothing moves, so the maker notes' internal
/// offsets stay valid. For anything else a fresh block is built from what could be read.
/// Either way the output's orientation is 1, because the pixels arrive upright.
///
/// The original is never overwritten: the copy takes a timestamped name, disambiguated if
/// one save lands in the same second as another, and is created with `create_new` so a
/// name that appears underneath is a refusal rather than a clobber.
#[tauri::command]
pub async fn save_local_edit(
    app: AppHandle,
    src_path: String,
    image_base64: String,
    format: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let format = OutFormat::parse(format.as_deref())?;
        let resolved = crate::local_file::checked_media_path(&app, &src_path)?;
        let ext = crate::local_file::extension_of(&resolved.to_string_lossy());
        match crate::local_file::media_entry(&ext) {
            Some((_, mime, _)) if mime.starts_with("image/") => {}
            _ => return Err("only photos can be edited".into()),
        }

        let edited = decode_edited(&image_base64)?;
        let meta = read_source_meta(&resolved);

        // A JPEG source saved as a JPEG has its EXIF copied verbatim; anything else has its
        // metadata rebuilt. A JPEG that carries none falls through to the rebuild too, which
        // then has little to write beyond the upright orientation and the new size.
        let source_app1 = (is_jpeg(&ext) && format == OutFormat::Jpeg)
            .then(|| std::fs::read(&resolved).ok())
            .flatten()
            .and_then(|bytes| find_exif_app1(&bytes));

        let output = assemble_output(source_app1.as_deref(), &meta, &edited, format)?;

        let parent = resolved.parent().ok_or("that photo has no folder")?;
        let stem = resolved
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "photo".to_string());
        write_new_copy(parent, &stem, &local_now(), format.extension(), &output)
    })
    .await
    .map_err(|e| format!("saving that photo failed: {e}"))?
}

/// What a copy is saved as: the editor encodes the pixels, this only checks and labels them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutFormat {
    Jpeg,
    Png,
    Webp,
}

impl OutFormat {
    /// The format the frontend asked for; none means a JPEG, as every save was before.
    fn parse(name: Option<&str>) -> Result<Self, String> {
        match name.unwrap_or("jpeg") {
            "jpeg" => Ok(Self::Jpeg),
            "png" => Ok(Self::Png),
            "webp" => Ok(Self::Webp),
            other => Err(format!("a photo cannot be saved as {other}")),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Webp => "webp",
        }
    }

    /// Whether the bytes really are this format, by their signature.
    fn matches(self, bytes: &[u8]) -> bool {
        match self {
            Self::Jpeg => bytes.starts_with(&[0xFF, 0xD8]),
            Self::Png => bytes.starts_with(&PNG_SIGNATURE),
            Self::Webp => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        }
    }
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

fn is_jpeg(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "jpe" | "jfif")
}

/// The edited image's bytes from what the frontend sent. A bare base64 payload is expected,
/// but a whole `data:` URL is accepted too, so a caller that forwards the canvas output
/// unchanged is not punished for it.
fn decode_edited(input: &str) -> Result<Vec<u8>, String> {
    let payload = match input.find("base64,") {
        Some(i) => &input[i + 7..],
        None => input.trim(),
    };
    base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|_| "the edited image was not valid base64".to_string())
}

/// Build the output file: the edited pixels, with metadata attached.
///
/// Separated from the command so it can be tested without a Tauri handle or the disk: it
/// takes bytes and returns bytes.
fn assemble_output(
    source_app1: Option<&[u8]>,
    meta: &SourceMeta,
    edited: &[u8],
    format: OutFormat,
) -> Result<Vec<u8>, String> {
    if !format.matches(edited) {
        return Err(format!("the edited image is not a readable {}", format.extension()));
    }
    if format != OutFormat::Jpeg {
        let size = imagesize::blob_size(edited)
            .map_err(|_| format!("the edited image is not a readable {}", format.extension()))?;
        let md = build_fresh_metadata(meta, size.width as u32, size.height as u32);
        let mut out = edited.to_vec();
        match format {
            OutFormat::Png => insert_png_exif(&mut out, &md)?,
            _ => {
                extend_webp(&mut out, size.width as u32, size.height as u32)?;
                md.write_to_vec(&mut out, FileExtension::WEBP)
                    .map_err(|e| format!("the photo's details could not be written: {e}"))?
            }
        }
        return Ok(out);
    }

    let (width, height) =
        jpeg_sof_dimensions(edited).ok_or("the edited image is not a readable JPEG")?;

    if let Some(app1) = source_app1 {
        let mut segment = app1.to_vec();
        // In place: orientation to 1, dimensions to the edited size. If the block cannot
        // be parsed we do not force it, we rebuild instead, which is safer than emitting a
        // half-patched segment.
        if patch_exif_app1(&mut segment, width, height).is_ok() {
            let body = strip_leading_exif_app1(edited);
            let mut out = Vec::with_capacity(2 + segment.len() + body.len().saturating_sub(2));
            out.extend_from_slice(&[0xFF, 0xD8]);
            out.extend_from_slice(&segment);
            out.extend_from_slice(&body[2..]);
            return Ok(out);
        }
    }

    // Fresh block from what was read. `write_to_vec` clears any EXIF the buffer already
    // holds and inserts this right after the start marker.
    let mut out = edited.to_vec();
    build_fresh_metadata(meta, width, height)
        .write_to_vec(&mut out, FileExtension::JPEG)
        .map_err(|e| format!("the photo's details could not be written: {e}"))?;
    Ok(out)
}

/// Put the EXIF block into a PNG as the standard `eXIf` chunk, right after the header, where
/// readers look for it (the crate's own PNG writer stores it as ImageMagick's text chunk,
/// which most readers skip).
fn insert_png_exif(png: &mut Vec<u8>, md: &Metadata) -> Result<(), String> {
    const EXIF_PREFIX: &[u8] = b"Exif\0\0";
    let app1 = md
        .as_u8_vec(FileExtension::JPEG)
        .map_err(|e| format!("the photo's details could not be written: {e}"))?;
    let tiff = app1
        .windows(EXIF_PREFIX.len())
        .position(|w| w == EXIF_PREFIX)
        .map(|i| &app1[i + EXIF_PREFIX.len()..])
        .ok_or("the photo's details could not be written")?;
    // The signature, then IHDR: length, type, its data, CRC.
    let ihdr_len = read_u32(png, 8, false).ok_or("the edited image is not a readable png")? as usize;
    if png.get(12..16) != Some(b"IHDR".as_slice()) || png.len() < 8 + 12 + ihdr_len {
        return Err("the edited image is not a readable png".into());
    }
    let at = 8 + 12 + ihdr_len;
    let mut chunk = Vec::with_capacity(tiff.len() + 12);
    chunk.extend_from_slice(&(tiff.len() as u32).to_be_bytes());
    chunk.extend_from_slice(b"eXIf");
    chunk.extend_from_slice(tiff);
    let crc = crc32(&chunk[4..]);
    chunk.extend_from_slice(&crc.to_be_bytes());
    png.splice(at..at, chunk);
    Ok(())
}

/// Give a simple WebP (one bare VP8 or VP8L chunk, as a canvas writes an opaque photo) the
/// extended header that EXIF needs, which the metadata crate cannot add itself: a VP8X chunk
/// with the canvas size, and the alpha flag a lossless frame says it uses. An extended file
/// is left as it is.
fn extend_webp(webp: &mut Vec<u8>, width: u32, height: u32) -> Result<(), String> {
    let kind = webp.get(12..16).ok_or("the edited image is not a readable webp")?;
    let alpha = match kind {
        b"VP8X" => return Ok(()),
        b"VP8 " => false,
        // The lossless header: a signature byte, then 14 + 14 bits of size and one alpha bit.
        b"VP8L" => (read_u32(webp, 21, true).ok_or("the edited image is not a readable webp")? >> 28) & 1 == 1,
        _ => return Err("the edited image is not a readable webp".into()),
    };
    if width == 0 || height == 0 || width > 1 << 24 || height > 1 << 24 {
        return Err("the edited image is not a readable webp".into());
    }
    let mut vp8x = Vec::with_capacity(18);
    vp8x.extend_from_slice(b"VP8X");
    vp8x.extend_from_slice(&10u32.to_le_bytes());
    vp8x.extend_from_slice(&[if alpha { 0x10 } else { 0 }, 0, 0, 0]);
    vp8x.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    vp8x.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    webp.splice(12..12, vp8x);
    let riff = read_u32(webp, 4, true).ok_or("the edited image is not a readable webp")?;
    write_u32(webp, 4, true, riff + 18);
    Ok(())
}

/// The CRC-32 a PNG chunk ends with, over its type and data.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in bytes {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// A fresh EXIF block for a source that had none to copy: the date, camera and location
/// that could be read, the upright orientation, and the edited size. Pixel dimensions go
/// in as the Exif-IFD tags a reader looks to for a JPEG's real size.
fn build_fresh_metadata(meta: &SourceMeta, width: u32, height: u32) -> Metadata {
    let mut md = Metadata::new();
    if let Some(date) = &meta.date_original {
        md.set_tag(ExifTag::DateTimeOriginal(date.clone()));
    }
    if let Some(make) = &meta.make {
        md.set_tag(ExifTag::Make(make.clone()));
    }
    if let Some(model) = &meta.model {
        md.set_tag(ExifTag::Model(model.clone()));
    }
    md.set_tag(ExifTag::Orientation(vec![1]));
    md.set_tag(ExifTag::ExifImageWidth(vec![width]));
    md.set_tag(ExifTag::ExifImageHeight(vec![height]));
    if let (Some(lat), Some(lon)) = (meta.latitude, meta.longitude) {
        let (lat_dms, lat_ref) = to_dms(lat, 'N', 'S');
        let (lon_dms, lon_ref) = to_dms(lon, 'E', 'W');
        md.set_tag(ExifTag::GPSLatitude(lat_dms));
        md.set_tag(ExifTag::GPSLatitudeRef(lat_ref));
        md.set_tag(ExifTag::GPSLongitude(lon_dms));
        md.set_tag(ExifTag::GPSLongitudeRef(lon_ref));
    }
    md
}

/// A signed decimal degree as the three rationals and the hemisphere letter EXIF stores.
/// Seconds keep three decimal places, which is well under a metre and all a rebuilt block
/// needs.
fn to_dms(value: f64, positive: char, negative: char) -> (Vec<uR64>, String) {
    let reference = if value < 0.0 { negative } else { positive };
    let abs = value.abs();
    let degrees = abs.floor();
    let minutes_full = (abs - degrees) * 60.0;
    let minutes = minutes_full.floor();
    let seconds = (minutes_full - minutes) * 60.0;
    let dms = vec![
        uR64 {
            nominator: degrees as u32,
            denominator: 1,
        },
        uR64 {
            nominator: minutes as u32,
            denominator: 1,
        },
        uR64 {
            nominator: (seconds * 1_000.0).round() as u32,
            denominator: 1_000,
        },
    ];
    (dms, reference.to_string())
}

// ---- JPEG and EXIF byte surgery ----

/// The width and height a JPEG declares in its start-of-frame marker, which is the real
/// pixel size a decoder uses. Scans the marker segments; standalone and entropy-coded
/// markers are stepped over, and the scan stops at the first frame header or at the start
/// of scan data.
fn jpeg_sof_dimensions(jpeg: &[u8]) -> Option<(u32, u32)> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return None;
        }
        let marker = jpeg[i + 1];
        // A fill byte is a run of 0xFF; step one and look again.
        if marker == 0xFF {
            i += 1;
            continue;
        }
        // Standalone markers carry no length payload.
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        // Start of scan, or end of image: no frame header will follow.
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = ((jpeg[i + 2] as usize) << 8) | jpeg[i + 3] as usize;
        if len < 2 || i + 2 + len > jpeg.len() {
            return None;
        }
        // A start-of-frame marker, of which C4 (Huffman tables), C8 (extension) and CC
        // (arithmetic-coding conditioning) are the three that are not one.
        if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
            let p = i + 4;
            let height = ((*jpeg.get(p + 1)? as u32) << 8) | *jpeg.get(p + 2)? as u32;
            let width = ((*jpeg.get(p + 3)? as u32) << 8) | *jpeg.get(p + 4)? as u32;
            if width == 0 || height == 0 {
                return None;
            }
            return Some((width, height));
        }
        i += 2 + len;
    }
    None
}

/// The byte range of the EXIF APP1 segment in a JPEG, marker and length included, or
/// `None` when there is none. An APP1 that carries XMP rather than EXIF is skipped, since
/// only the EXIF one starts with the "Exif\0\0" signature.
fn exif_app1_range(jpeg: &[u8]) -> Option<(usize, usize)> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return None;
    }
    let mut i = 2;
    while i + 4 <= jpeg.len() {
        if jpeg[i] != 0xFF {
            return None;
        }
        let marker = jpeg[i + 1];
        if marker == 0xFF {
            i += 1;
            continue;
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2;
            continue;
        }
        if marker == 0xDA || marker == 0xD9 {
            return None;
        }
        let len = ((jpeg[i + 2] as usize) << 8) | jpeg[i + 3] as usize;
        if len < 2 || i + 2 + len > jpeg.len() {
            return None;
        }
        let end = i + 2 + len;
        if marker == 0xE1 && jpeg.get(i + 4..end)?.starts_with(b"Exif\0\0") {
            return Some((i, end));
        }
        i = end;
    }
    None
}

/// The EXIF APP1 segment of a JPEG as its own bytes, or `None` when there is none.
fn find_exif_app1(jpeg: &[u8]) -> Option<Vec<u8>> {
    let (start, end) = exif_app1_range(jpeg)?;
    Some(jpeg[start..end].to_vec())
}

/// A JPEG with any leading EXIF APP1 removed. The canvas never writes one, so this is a
/// guard against re-saving an already-saved file rather than an everyday step: without it
/// such a file would end up carrying two EXIF segments.
fn strip_leading_exif_app1(jpeg: &[u8]) -> Vec<u8> {
    match exif_app1_range(jpeg) {
        Some((start, end)) => {
            let mut out = Vec::with_capacity(jpeg.len() - (end - start));
            out.extend_from_slice(&jpeg[..start]);
            out.extend_from_slice(&jpeg[end..]);
            out
        }
        None => jpeg.to_vec(),
    }
}

fn read_u16(buf: &[u8], off: usize, le: bool) -> Option<u16> {
    let b = buf.get(off..off + 2)?;
    Some(if le {
        u16::from_le_bytes([b[0], b[1]])
    } else {
        u16::from_be_bytes([b[0], b[1]])
    })
}

fn read_u32(buf: &[u8], off: usize, le: bool) -> Option<u32> {
    let b = buf.get(off..off + 4)?;
    Some(if le {
        u32::from_le_bytes([b[0], b[1], b[2], b[3]])
    } else {
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    })
}

fn write_u16(buf: &mut [u8], off: usize, le: bool, v: u16) {
    let b = if le { v.to_le_bytes() } else { v.to_be_bytes() };
    if let Some(slot) = buf.get_mut(off..off + 2) {
        slot.copy_from_slice(&b);
    }
}

fn write_u32(buf: &mut [u8], off: usize, le: bool, v: u32) {
    let b = if le { v.to_le_bytes() } else { v.to_be_bytes() };
    if let Some(slot) = buf.get_mut(off..off + 4) {
        slot.copy_from_slice(&b);
    }
}

const TAG_IMAGE_WIDTH: u16 = 0x0100;
const TAG_IMAGE_HEIGHT: u16 = 0x0101;
const TAG_ORIENTATION: u16 = 0x0112;
const TAG_EXIF_IFD: u16 = 0x8769;
const TAG_PIXEL_X: u16 = 0xA002;
const TAG_PIXEL_Y: u16 = 0xA003;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;

/// Patch one dimension tag's value in place, without moving a byte.
///
/// A LONG value is a plain four-byte overwrite. A SHORT that still fits stays a SHORT; one
/// that no longer fits (an edited edge past 65535) has its type field promoted to LONG,
/// which changes no offsets because the value field is four bytes wide either way.
fn patch_dimension(tiff: &mut [u8], le: bool, entry: usize, ty: u16, value: u32) {
    let value_off = entry + 8;
    match ty {
        TYPE_SHORT if value <= u16::MAX as u32 => {
            write_u16(tiff, value_off, le, value as u16);
            write_u16(tiff, value_off + 2, le, 0);
        }
        TYPE_SHORT => {
            write_u16(tiff, entry + 2, le, TYPE_LONG);
            write_u32(tiff, value_off, le, value);
        }
        TYPE_LONG => write_u32(tiff, value_off, le, value),
        _ => {}
    }
}

/// Walk one IFD, patching what belongs there, and return the Exif sub-IFD's offset if the
/// IFD points at one. `orientation` is only patched in the primary IFD (that is where the
/// tag lives); the pixel-dimension tags are patched wherever they appear.
fn patch_ifd(
    tiff: &mut [u8],
    le: bool,
    ifd: usize,
    patch_orientation: bool,
    width: u32,
    height: u32,
) -> Option<usize> {
    let count = read_u16(tiff, ifd, le)? as usize;
    let mut exif_ifd = None;
    for n in 0..count {
        let entry = ifd + 2 + n * 12;
        let tag = read_u16(tiff, entry, le)?;
        let ty = read_u16(tiff, entry + 2, le)?;
        match tag {
            TAG_ORIENTATION if patch_orientation => write_u16(tiff, entry + 8, le, 1),
            TAG_IMAGE_WIDTH | TAG_PIXEL_X => patch_dimension(tiff, le, entry, ty, width),
            TAG_IMAGE_HEIGHT | TAG_PIXEL_Y => patch_dimension(tiff, le, entry, ty, height),
            TAG_EXIF_IFD => exif_ifd = read_u32(tiff, entry + 8, le).map(|o| o as usize),
            _ => {}
        }
    }
    exif_ifd
}

/// Force one copied EXIF APP1 segment upright and to the edited size, in place.
///
/// The segment is `FF E1`, a two-byte length, "Exif\0\0", then the TIFF block every offset
/// inside it is measured from. Orientation is set to 1 in the primary IFD, and the pixel
/// dimensions are set both there and in the Exif sub-IFD it points to. Nothing is moved,
/// added or removed, so the GPS block, the maker notes and every other tag keep the byte
/// positions their own internal pointers assume.
fn patch_exif_app1(segment: &mut [u8], width: u32, height: u32) -> Result<(), String> {
    if segment.len() < 18 || segment.get(4..10).is_none_or(|s| s != b"Exif\0\0") {
        return Err("the EXIF segment is malformed".into());
    }
    let tiff = &mut segment[10..];
    let le = match tiff.get(0..2) {
        Some(b"II") => true,
        Some(b"MM") => false,
        _ => return Err("the EXIF byte order is unreadable".into()),
    };
    if read_u16(tiff, 2, le) != Some(42) {
        return Err("the EXIF header is unreadable".into());
    }
    let ifd0 = read_u32(tiff, 4, le).ok_or("the EXIF header is truncated")? as usize;
    let exif_ifd = patch_ifd(tiff, le, ifd0, true, width, height);
    if let Some(sub) = exif_ifd {
        patch_ifd(tiff, le, sub, false, width, height);
    }
    Ok(())
}

// ---- Naming and writing the new file ----

/// A local wall-clock stamp for the saved copy's name.
struct Stamp {
    year: u16,
    month: u8,
    day: u8,
    hour: u8,
    minute: u8,
    second: u8,
}

/// The current local time. Local, not UTC, because the name is for a person reading their
/// own folder.
#[cfg(windows)]
fn local_now() -> Stamp {
    use windows::Win32::System::SystemInformation::GetLocalTime;
    let t = unsafe { GetLocalTime() };
    Stamp {
        year: t.wYear,
        month: t.wMonth as u8,
        day: t.wDay as u8,
        hour: t.wHour as u8,
        minute: t.wMinute as u8,
        second: t.wSecond as u8,
    }
}

/// Days from 1970-01-01 back to a civil date, the inverse of `days_from_civil`. Only the
/// non-Windows build needs it, to turn a UTC instant into fields for the fallback stamp.
#[cfg(not(windows))]
fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    ((y + if m <= 2 { 1 } else { 0 }) as i32, m as u32, d as u32)
}

#[cfg(not(windows))]
fn local_now() -> Stamp {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (year, month, day) = civil_from_days(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    Stamp {
        year: year as u16,
        month: month as u8,
        day: day as u8,
        hour: (rem / 3_600) as u8,
        minute: (rem % 3_600 / 60) as u8,
        second: (rem % 60) as u8,
    }
}

/// The stamp as `yyyyMMdd_HHmmss`.
fn stamp_str(s: &Stamp) -> String {
    format!(
        "{:04}{:02}{:02}_{:02}{:02}{:02}",
        s.year, s.month, s.day, s.hour, s.minute, s.second
    )
}

/// The name for the nth candidate copy of `stem`. The first bears the stamp alone; a
/// collision within the same second gains a counter.
fn edit_file_name(stem: &str, stamp: &str, n: u32, ext: &str) -> String {
    if n <= 1 {
        format!("{stem}_edit_{stamp}.{ext}")
    } else {
        format!("{stem}_edit_{stamp}_{n}.{ext}")
    }
}

/// The first candidate name that no file in `dir` already holds.
fn next_free_name(dir: &Path, stem: &str, stamp: &str, ext: &str) -> String {
    for n in 1..=9_999 {
        let name = edit_file_name(stem, stamp, n, ext);
        if !dir.join(&name).exists() {
            return name;
        }
    }
    edit_file_name(stem, stamp, 10_000, ext)
}

/// Write the output under a fresh, non-colliding name and return its path. `create_new`
/// makes the collision check part of the write itself: a file that appears between
/// choosing the name and opening it is a refusal, never a silent overwrite of the
/// original or of another save.
fn write_new_copy(dir: &Path, stem: &str, stamp: &Stamp, ext: &str, bytes: &[u8]) -> Result<String, String> {
    use std::io::Write;
    let stamp = stamp_str(stamp);
    for n in 1..=10_000u32 {
        let name = if n == 1 {
            next_free_name(dir, stem, &stamp, ext)
        } else {
            edit_file_name(stem, &stamp, n, ext)
        };
        let dest = dir.join(&name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&dest)
        {
            Ok(mut file) => {
                file.write_all(bytes)
                    .map_err(|e| format!("the edited photo could not be written: {e}"))?;
                return Ok(crate::strip_verbatim(dest).to_string_lossy().into_owned());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("the edited photo could not be written: {e}")),
        }
    }
    Err("a free name for the edited photo could not be found".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal but marker-valid JPEG carrying a start-of-frame with the given size, so
    /// the dimension reader and the metadata writers have something real to work on
    /// without decoding pixels.
    fn jpeg_with_size(w: u16, h: u16) -> Vec<u8> {
        let mut v = vec![0xFF, 0xD8];
        v.extend_from_slice(&[
            0xFF, 0xC0, 0x00, 0x0B, 0x08, (h >> 8) as u8, h as u8, (w >> 8) as u8, w as u8, 0x01,
            0x01, 0x11, 0x00,
        ]);
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    }

    /// A source JPEG carrying a known date, orientation, size and location, built with the
    /// same crate the save path uses to write fresh metadata.
    fn source_with_exif() -> Vec<u8> {
        let mut jpeg = jpeg_with_size(100, 200);
        let mut md = Metadata::new();
        md.set_tag(ExifTag::DateTimeOriginal("2021:07:20 15:30:00".to_string()));
        md.set_tag(ExifTag::Make("TestMake".to_string()));
        md.set_tag(ExifTag::Model("TestModel".to_string()));
        md.set_tag(ExifTag::Orientation(vec![6]));
        md.set_tag(ExifTag::ExifImageWidth(vec![100]));
        md.set_tag(ExifTag::ExifImageHeight(vec![200]));
        // 47 deg 29' 52.44" N, 19 deg 2' 24.72" E (Budapest), as whole-part rationals.
        md.set_tag(ExifTag::GPSLatitude(vec![
            uR64 { nominator: 47, denominator: 1 },
            uR64 { nominator: 29, denominator: 1 },
            uR64 { nominator: 52_440, denominator: 1_000 },
        ]));
        md.set_tag(ExifTag::GPSLatitudeRef("N".to_string()));
        md.set_tag(ExifTag::GPSLongitude(vec![
            uR64 { nominator: 19, denominator: 1 },
            uR64 { nominator: 2, denominator: 1 },
            uR64 { nominator: 24_720, denominator: 1_000 },
        ]));
        md.set_tag(ExifTag::GPSLongitudeRef("E".to_string()));
        md.write_to_vec(&mut jpeg, FileExtension::JPEG).unwrap();
        jpeg
    }

    /// Read one field back out of an output JPEG with the reader the real app uses.
    fn read_back(jpeg: &[u8]) -> exif::Exif {
        let mut cur = std::io::Cursor::new(jpeg);
        exif::Reader::new().read_from_container(&mut cur).expect("output has readable EXIF")
    }

    fn uint(exif: &exif::Exif, tag: exif::Tag) -> Option<u32> {
        exif.get_field(tag, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0))
    }

    fn ascii(exif: &exif::Exif, tag: exif::Tag) -> Option<String> {
        ascii_field(exif, tag)
    }

    #[test]
    fn the_edited_name_is_stamped_and_disambiguates() {
        let stamp = Stamp {
            year: 2024,
            month: 1,
            day: 2,
            hour: 13,
            minute: 4,
            second: 5,
        };
        assert_eq!(stamp_str(&stamp), "20240102_130405");
        assert_eq!(edit_file_name("DSC_0001", "20240102_130405", 1, "jpg"), "DSC_0001_edit_20240102_130405.jpg");
        assert_eq!(edit_file_name("DSC_0001", "20240102_130405", 2, "jpg"), "DSC_0001_edit_20240102_130405_2.jpg");
        assert_eq!(edit_file_name("DSC_0001", "20240102_130405", 1, "webp"), "DSC_0001_edit_20240102_130405.webp");

        let dir = std::env::temp_dir().join(format!("pfp-edit-name-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stamp = "20240102_130405";
        // Nothing there yet: the first candidate wins.
        assert_eq!(next_free_name(&dir, "IMG", stamp, "jpg"), "IMG_edit_20240102_130405.jpg");
        // Occupy it, and the counter appears.
        std::fs::write(dir.join("IMG_edit_20240102_130405.jpg"), b"x").unwrap();
        assert_eq!(next_free_name(&dir, "IMG", stamp, "jpg"), "IMG_edit_20240102_130405_2.jpg");
        std::fs::write(dir.join("IMG_edit_20240102_130405_2.jpg"), b"x").unwrap();
        assert_eq!(next_free_name(&dir, "IMG", stamp, "jpg"), "IMG_edit_20240102_130405_3.jpg");
        // Another format is another name.
        assert_eq!(next_free_name(&dir, "IMG", stamp, "png"), "IMG_edit_20240102_130405.png");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_new_copy_never_overwrites_and_returns_the_path() {
        let dir = std::env::temp_dir().join(format!("pfp-edit-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stamp = Stamp { year: 2024, month: 3, day: 4, hour: 5, minute: 6, second: 7 };

        let first = write_new_copy(&dir, "pic", &stamp, "jpg", b"one").unwrap();
        assert!(first.ends_with("pic_edit_20240304_050607.jpg"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one");

        // A second save in the same second must not touch the first file.
        let second = write_new_copy(&dir, "pic", &stamp, "jpg", b"two").unwrap();
        assert!(second.ends_with("pic_edit_20240304_050607_2.jpg"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one", "the first copy is untouched");
        assert_eq!(std::fs::read(&second).unwrap(), b"two");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn base64_is_decoded_with_or_without_a_data_url_prefix() {
        // "hello" as base64 is "aGVsbG8=".
        assert_eq!(decode_edited("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_edited("data:image/jpeg;base64,aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_edited("  aGVsbG8=  ").unwrap(), b"hello");
        assert!(decode_edited("not valid !!!").is_err());
    }

    #[test]
    fn a_data_url_is_one_string_with_the_right_prefix() {
        let url = data_url("image/png", b"hello");
        assert_eq!(url, "data:image/png;base64,aGVsbG8=");
    }

    #[test]
    fn a_jpeg_reports_its_frame_size() {
        assert_eq!(jpeg_sof_dimensions(&jpeg_with_size(640, 480)), Some((640, 480)));
        assert_eq!(jpeg_sof_dimensions(&jpeg_with_size(1, 1)), Some((1, 1)));
        assert_eq!(jpeg_sof_dimensions(b"not a jpeg"), None);
        // A source built with an EXIF segment still reports its frame size, past the APP1.
        assert_eq!(jpeg_sof_dimensions(&source_with_exif()), Some((100, 200)));
    }

    #[test]
    fn the_exif_segment_is_found_only_when_present() {
        assert!(find_exif_app1(&jpeg_with_size(10, 10)).is_none(), "no EXIF to find");
        let app1 = find_exif_app1(&source_with_exif()).expect("the built-in EXIF is found");
        assert_eq!(&app1[0..2], &[0xFF, 0xE1], "it is an APP1 segment");
        assert_eq!(&app1[4..10], b"Exif\0\0", "with the EXIF signature");
    }

    #[test]
    fn gps_degrees_survive_a_round_trip() {
        // Northern/eastern stays positive, southern/western goes negative.
        let (dms, r) = to_dms(47.4979, 'N', 'S');
        assert_eq!(r, "N");
        let back = dms[0].nominator as f64
            + dms[1].nominator as f64 / 60.0
            + (dms[2].nominator as f64 / dms[2].denominator as f64) / 3600.0;
        assert!((back - 47.4979).abs() < 1e-3, "got {back}");

        let (_, r) = to_dms(-19.04, 'E', 'W');
        assert_eq!(r, "W", "a negative longitude is west");
    }

    #[test]
    fn the_calendar_matches_known_instants() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        assert_eq!(civil_to_unix_ms(1970, 1, 1, 0, 0, 0, 0), 0);
        assert_eq!(civil_to_unix_ms(2024, 1, 1, 0, 0, 0, 0), 1_704_067_200_000);
        assert!(!plausible_civil(2024, 13, 1, 0, 0, 0));
        assert!(!plausible_civil(2024, 2, 30, 0, 0, 0));
        assert!(plausible_civil(2024, 2, 29, 0, 0, 0), "2024 is a leap year");
    }

    #[test]
    fn a_capture_time_with_an_offset_is_that_exact_instant() {
        let mut dt = exif::DateTime::from_ascii(b"2024:01:01 02:00:00").unwrap();
        dt.parse_offset(b"+02:00").unwrap();
        assert_eq!(exif_capture_ms(&dt), Some(1_704_067_200_000));
    }

    #[test]
    fn a_camera_is_named_once() {
        assert_eq!(camera_label(Some("Canon"), Some("Canon EOS R5")).as_deref(), Some("Canon EOS R5"));
        assert_eq!(camera_label(Some("Apple"), Some("iPhone 15 Pro")).as_deref(), Some("Apple iPhone 15 Pro"));
        assert_eq!(camera_label(None, None), None);
    }

    #[test]
    fn every_orientation_maps_to_the_transform_that_undoes_it() {
        assert_eq!(wic_transform_for(1), None);
        assert_eq!(wic_transform_for(6), Some(1));
        assert_eq!(wic_transform_for(3), Some(2));
        assert_eq!(wic_transform_for(8), Some(3));
        assert_eq!(wic_transform_for(0), None, "an absent tag is upright");
        assert_eq!(wic_transform_for(9), None, "and so is a corrupt one");
    }

    #[test]
    fn a_short_dimension_is_promoted_to_long_when_it_no_longer_fits() {
        // One IFD, one entry: a SHORT pixel-width. Big-endian ("MM") for clarity.
        // Entry layout: tag(2) type(2) count(4) value(4).
        let mut tiff = vec![
            b'M', b'M', 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // header, IFD0 at offset 8
            0x00, 0x01, // one entry
            0xA0, 0x02, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x64, 0x00, 0x00, // PixelX SHORT=100
            0x00, 0x00, 0x00, 0x00, // next-IFD offset
        ];
        // Fits in a SHORT: stays SHORT, value overwritten.
        patch_ifd(&mut tiff, false, 8, false, 640, 480);
        assert_eq!(read_u16(&tiff, 10 + 2, false), Some(TYPE_SHORT), "still SHORT");
        assert_eq!(read_u16(&tiff, 10 + 8, false), Some(640), "value overwritten");
        // Past 65535: type promoted to LONG, full value written inline.
        patch_ifd(&mut tiff, false, 8, false, 70_000, 1);
        assert_eq!(read_u16(&tiff, 10 + 2, false), Some(TYPE_LONG), "promoted to LONG");
        assert_eq!(read_u32(&tiff, 10 + 8, false), Some(70_000));
    }

    #[test]
    fn a_jpeg_source_keeps_its_metadata_and_is_forced_upright_at_the_edited_size() {
        let source = source_with_exif();
        // Sanity: the fixture itself carries what the assertions below rely on, so a
        // failure here points at the fixture, not the code under test.
        let before = read_back(&source);
        assert_eq!(uint(&before, exif::Tag::Orientation), Some(6), "fixture starts rotated");
        assert_eq!(uint(&before, exif::Tag::PixelXDimension), Some(100));
        assert_eq!(ascii(&before, exif::Tag::DateTimeOriginal).as_deref(), Some("2021:07:20 15:30:00"));
        assert!(before.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY).is_some());

        let app1 = find_exif_app1(&source).unwrap();
        let edited = jpeg_with_size(640, 480);
        let out = assemble_output(Some(&app1), &SourceMeta::default(), &edited, OutFormat::Jpeg).unwrap();

        let after = read_back(&out);
        // Date, camera and location carried across untouched.
        assert_eq!(ascii(&after, exif::Tag::DateTimeOriginal).as_deref(), Some("2021:07:20 15:30:00"));
        assert_eq!(ascii(&after, exif::Tag::Make).as_deref(), Some("TestMake"));
        assert_eq!(ascii(&after, exif::Tag::Model).as_deref(), Some("TestModel"));
        assert!(after.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY).is_some(), "GPS survived");
        let lat = gps_decimal(&after, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, 'S', 90.0);
        assert!(lat.map(|v| (v - 47.4979).abs() < 1e-2).unwrap_or(false), "latitude preserved: {lat:?}");
        // Orientation reset and dimensions updated.
        assert_eq!(uint(&after, exif::Tag::Orientation), Some(1), "forced upright");
        assert_eq!(uint(&after, exif::Tag::PixelXDimension), Some(640), "width is the edited width");
        assert_eq!(uint(&after, exif::Tag::PixelYDimension), Some(480), "height is the edited height");
        // The frame the pixels really are stays the edited size.
        assert_eq!(jpeg_sof_dimensions(&out), Some((640, 480)));
    }

    #[test]
    fn a_non_jpeg_source_gets_a_fresh_block_with_date_gps_and_the_edited_size() {
        let meta = SourceMeta {
            date_original: Some("2019:01:02 03:04:05".to_string()),
            make: Some("PixelMaker".to_string()),
            model: Some("PixelModel".to_string()),
            latitude: Some(12.5),
            longitude: Some(-34.25),
            orientation: 1,
            ..SourceMeta::default()
        };
        let edited = jpeg_with_size(800, 600);
        let out = assemble_output(None, &meta, &edited, OutFormat::Jpeg).unwrap();

        let after = read_back(&out);
        assert_eq!(ascii(&after, exif::Tag::DateTimeOriginal).as_deref(), Some("2019:01:02 03:04:05"));
        assert_eq!(ascii(&after, exif::Tag::Make).as_deref(), Some("PixelMaker"));
        assert_eq!(uint(&after, exif::Tag::Orientation), Some(1), "upright");
        assert_eq!(uint(&after, exif::Tag::PixelXDimension), Some(800));
        assert_eq!(uint(&after, exif::Tag::PixelYDimension), Some(600));

        let lat = gps_decimal(&after, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, 'S', 90.0);
        let lon = gps_decimal(&after, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, 'W', 180.0);
        assert!(lat.map(|v| (v - 12.5).abs() < 1e-3).unwrap_or(false), "latitude: {lat:?}");
        assert!(lon.map(|v| (v + 34.25).abs() < 1e-3).unwrap_or(false), "longitude went west: {lon:?}");
        assert_eq!(jpeg_sof_dimensions(&out), Some((800, 600)));
    }

    fn png_with_size(w: u32, h: u32) -> Vec<u8> {
        let mut v = PNG_SIGNATURE.to_vec();
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&w.to_be_bytes());
        ihdr.extend_from_slice(&h.to_be_bytes());
        ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
        v.extend_from_slice(&13u32.to_be_bytes());
        v.extend_from_slice(&ihdr);
        v.extend_from_slice(&crc32(&ihdr).to_be_bytes());
        let iend = b"IEND";
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(iend);
        v.extend_from_slice(&crc32(iend).to_be_bytes());
        v
    }

    /// A simple lossy WebP, as a canvas encodes one: RIFF, then one VP8 chunk whose frame
    /// header carries the size.
    fn webp_with_size(w: u16, h: u16) -> Vec<u8> {
        let mut vp8 = vec![0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a];
        vp8.extend_from_slice(&w.to_le_bytes());
        vp8.extend_from_slice(&h.to_le_bytes());
        vp8.extend_from_slice(&[0u8; 8]);
        let mut v = b"RIFF".to_vec();
        v.extend_from_slice(&((4 + 8 + vp8.len()) as u32).to_le_bytes());
        v.extend_from_slice(b"WEBP");
        v.extend_from_slice(b"VP8 ");
        v.extend_from_slice(&(vp8.len() as u32).to_le_bytes());
        v.extend_from_slice(&vp8);
        v
    }

    fn sample_meta() -> SourceMeta {
        SourceMeta {
            date_original: Some("2019:01:02 03:04:05".to_string()),
            make: Some("PixelMaker".to_string()),
            latitude: Some(12.5),
            longitude: Some(-34.25),
            orientation: 1,
            ..SourceMeta::default()
        }
    }

    #[test]
    fn a_format_is_parsed_and_named() {
        assert_eq!(OutFormat::parse(None), Ok(OutFormat::Jpeg), "no format is the old JPEG save");
        assert_eq!(OutFormat::parse(Some("png")).map(OutFormat::extension), Ok("png"));
        assert_eq!(OutFormat::parse(Some("webp")).map(OutFormat::extension), Ok("webp"));
        assert!(OutFormat::parse(Some("gif")).is_err());
    }

    #[test]
    fn the_png_crc_matches_the_standard() {
        // The IEND chunk's CRC every PNG ends with.
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
    }

    #[test]
    fn a_png_copy_carries_its_date_and_place_in_an_exif_chunk() {
        let out = assemble_output(None, &sample_meta(), &png_with_size(320, 200), OutFormat::Png).unwrap();
        assert!(out.starts_with(&PNG_SIGNATURE));
        let after = read_back(&out);
        assert_eq!(ascii(&after, exif::Tag::DateTimeOriginal).as_deref(), Some("2019:01:02 03:04:05"));
        assert_eq!(uint(&after, exif::Tag::Orientation), Some(1), "upright");
        assert_eq!(uint(&after, exif::Tag::PixelXDimension), Some(320));
        assert_eq!(uint(&after, exif::Tag::PixelYDimension), Some(200));
        let lat = gps_decimal(&after, exif::Tag::GPSLatitude, exif::Tag::GPSLatitudeRef, 'S', 90.0);
        assert!(lat.map(|v| (v - 12.5).abs() < 1e-3).unwrap_or(false), "latitude: {lat:?}");
        // Still the same picture: the header first and the end chunk last.
        assert_eq!(imagesize::blob_size(&out).map(|s| (s.width, s.height)).ok(), Some((320, 200)));
        assert!(out.ends_with(&[b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]));
    }

    #[test]
    fn a_webp_copy_carries_its_date_and_place() {
        let out = assemble_output(None, &sample_meta(), &webp_with_size(640, 480), OutFormat::Webp).unwrap();
        let after = read_back(&out);
        assert_eq!(ascii(&after, exif::Tag::DateTimeOriginal).as_deref(), Some("2019:01:02 03:04:05"));
        assert_eq!(uint(&after, exif::Tag::PixelXDimension), Some(640));
        let lon = gps_decimal(&after, exif::Tag::GPSLongitude, exif::Tag::GPSLongitudeRef, 'W', 180.0);
        assert!(lon.map(|v| (v + 34.25).abs() < 1e-3).unwrap_or(false), "longitude: {lon:?}");
        assert_eq!(imagesize::blob_size(&out).map(|s| (s.width, s.height)).ok(), Some((640, 480)));
    }

    #[test]
    fn a_simple_webp_gains_the_extended_header_with_its_size() {
        let mut webp = webp_with_size(640, 480);
        let before = webp.len();
        extend_webp(&mut webp, 640, 480).unwrap();
        assert_eq!(&webp[12..16], b"VP8X");
        assert_eq!(webp.len(), before + 18);
        assert_eq!(read_u32(&webp, 4, true), Some((webp.len() - 8) as u32), "RIFF size follows");
        assert_eq!(webp[20], 0, "an opaque frame has no alpha flag");
        assert_eq!(&webp[24..30], &[0x7F, 0x02, 0x00, 0xDF, 0x01, 0x00], "639 x 479");
        assert_eq!(&webp[30..34], b"VP8 ", "the frame follows untouched");
        // Already extended: nothing changes.
        let again = webp.clone();
        extend_webp(&mut webp, 640, 480).unwrap();
        assert_eq!(webp, again);
    }

    #[test]
    fn bytes_of_another_format_are_refused() {
        assert!(assemble_output(None, &sample_meta(), &jpeg_with_size(10, 10), OutFormat::Png).is_err());
        assert!(assemble_output(None, &sample_meta(), &png_with_size(10, 10), OutFormat::Webp).is_err());
        assert!(assemble_output(None, &sample_meta(), &webp_with_size(10, 10), OutFormat::Jpeg).is_err());
    }
}
