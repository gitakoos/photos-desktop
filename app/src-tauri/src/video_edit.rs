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

// The single-clip video editor's host side: what one edit of one video comes to as ONE ffmpeg
// pass (a trim, a turn, a crop, a look, a speed, the sound), the frame grab and the GIF, with
// progress events and a cancel. The window describes the edit as JSON; the arguments are built
// here by pure functions, tested without a video, and passed to ffmpeg as a vector, never through
// a shell.
//
// Everything is written under one staging folder, which is also the only place besides a user's
// own media files that a source may be read from: the sidecar stages a Drive video there, told
// where by the host when it starts. On Windows it is in the temp folder; on Linux it is in the
// app's cache folder on disk, as the sandbox's /tmp is a small RAM disk a long video would fill.
// The folder and each job's folder in it are the user's alone, and the whole is swept at startup.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::video_compress::ff::{self, Colour, Encoder};

/// The name of the staging folder.
pub(crate) const STAGING: &str = "pfp-vedit";

/// The longest a GIF made here runs, and the widest it is.
const GIF_MAX_MS: u64 = 30_000;
const GIF_MAX_WIDTH: u32 = 1080;

/// The shortest part an edit may keep.
const MIN_SPAN_MS: u64 = 100;

/// The staging folder: the temp folder on Windows, the app's cache folder elsewhere.
pub(crate) fn staging_root(app: &AppHandle) -> PathBuf {
    #[cfg(not(windows))]
    {
        use tauri::Manager;
        if let Ok(cache) = app.path().app_cache_dir() {
            return cache.join(STAGING);
        }
    }
    let _ = app;
    std::env::temp_dir().join(STAGING)
}

/// Removes everything staged. Run at startup, when no edit can be using it.
pub fn reap(app: &AppHandle) {
    let _ = std::fs::remove_dir_all(staging_root(app));
}

/// Creates `dir` and its parents, readable by this user only where the system has such modes.
pub(crate) fn private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(dir)
}

// ---- The edit, as the window describes it ----

/// A rectangle as fractions of the frame it is cut from (after the turn).
#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A music file picked from the computer, and how it joins the clip.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Music {
    pub path: String,
    /// Percent, 100 as recorded.
    pub volume: u32,
    /// "replace" drops the clip's own sound; "mix" plays under it.
    pub mode: String,
    /// Repeated to the clip's length when shorter; longer is cut either way.
    pub looped: bool,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioEdit {
    pub mute: bool,
    /// Percent, 100 as recorded.
    pub volume: u32,
    pub fade_in_ms: u64,
    pub fade_out_ms: u64,
    pub music: Option<Music>,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct GifEdit {
    pub width: u32,
    pub fps: u32,
}

#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Edit {
    /// "video", "gif" or "frame".
    pub kind: String,
    pub src: String,
    pub start_ms: u64,
    /// 0 reads as the end of the video.
    pub end_ms: u64,
    /// The moment a frame is taken at.
    pub frame_ms: u64,
    /// A quarter turn clockwise each: 0, 90, 180 or 270.
    pub rotate: u32,
    pub flip_h: bool,
    pub flip_v: bool,
    pub crop: Option<Crop>,
    /// A preset's name, or "" / "none".
    pub filter: String,
    /// -100 to 100 each.
    pub brightness: i32,
    pub contrast: i32,
    pub saturation: i32,
    /// 0.5 to 2; 0 reads as 1.
    pub speed: f64,
    pub audio: AudioEdit,
    pub gif: GifEdit,
    /// Unix milliseconds of the capture the copy keeps.
    pub creation_ms: Option<i64>,
}

impl Edit {
    fn speed(&self) -> f64 {
        if self.speed > 0.0 {
            self.speed
        } else {
            1.0
        }
    }

    /// Whether the picture is left alone by the look: no preset, no slider.
    pub fn look_is_neutral(&self) -> bool {
        matches!(self.filter.as_str(), "" | "none") && self.brightness == 0 && self.contrast == 0 && self.saturation == 0
    }
}

/// What ffprobe read of the source that the arguments depend on.
#[derive(Clone, Debug, PartialEq)]
pub struct Src {
    pub width: u32,
    pub height: u32,
    /// The turn the file asks players to apply, 0, 90, 180 or 270.
    pub rotation: u32,
    pub duration_ms: u64,
    pub fps: f64,
    pub video_bitrate: u64,
    pub has_audio: bool,
    /// "sdr", "pq" or "hlg".
    pub transfer: String,
}

impl Src {
    pub fn from_probe(p: &Value) -> Src {
        Src {
            width: p["width"].as_u64().unwrap_or(0) as u32,
            height: p["height"].as_u64().unwrap_or(0) as u32,
            rotation: (p["rotation"].as_u64().unwrap_or(0) % 360) as u32,
            duration_ms: p["durationMs"].as_u64().unwrap_or(0),
            fps: p["fps"].as_f64().unwrap_or(0.0),
            video_bitrate: p["videoBitrate"].as_u64().unwrap_or(0),
            has_audio: p["hasAudio"].as_bool().unwrap_or(false),
            transfer: p["transfer"].as_str().unwrap_or("sdr").to_string(),
        }
    }

    fn is_hdr(&self) -> bool {
        self.transfer == "pq" || self.transfer == "hlg"
    }

    /// The frame as a player shows it: the file's own turn applied.
    pub fn upright(&self) -> (u32, u32) {
        if self.rotation == 90 || self.rotation == 270 {
            (self.height, self.width)
        } else {
            (self.width, self.height)
        }
    }
}

// ---- Geometry ----

/// The frame after the edit's turn.
fn turned(src: &Src, rotate: u32) -> (u32, u32) {
    let (w, h) = src.upright();
    if rotate == 90 || rotate == 270 {
        (h, w)
    } else {
        (w, h)
    }
}

/// The crop as whole, even pixels inside a `w` by `h` frame: each edge floored to even, never
/// past the frame and never smaller than 2 pixels. None for no crop or the whole frame. The
/// answer is width, height, x, y, in the order ffmpeg's `crop` takes them.
pub fn crop_rect(crop: &Crop, w: u32, h: u32) -> Option<(u32, u32, u32, u32)> {
    if w < 2 || h < 2 {
        return None;
    }
    let frac = |v: f64| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
    let even = |v: f64| ((v.floor() as u32) / 2) * 2;
    let x = even(frac(crop.x) * w as f64).min(w - 2);
    let y = even(frac(crop.y) * h as f64).min(h - 2);
    let cw = even(frac(crop.w) * w as f64).clamp(2, w - x);
    let ch = even(frac(crop.h) * h as f64).clamp(2, h - y);
    if x == 0 && y == 0 && cw >= w && ch >= h {
        None
    } else {
        Some((cw, ch, x, y))
    }
}

/// The frame the edit ends with: turned, then cropped, then an odd side taken down to even.
pub fn output_frame(edit: &Edit, src: &Src) -> (u32, u32) {
    let (w, h) = turned(src, edit.rotate);
    let (w, h) = match edit.crop.as_ref().and_then(|c| crop_rect(c, w, h)) {
        Some((cw, ch, _, _)) => (cw, ch),
        None => (w, h),
    };
    (w & !1, h & !1)
}

// ---- The video side of the filter graph ----

/// The preset's ffmpeg filters; the window draws the same names with CSS filters.
fn preset_filter(name: &str) -> Option<&'static str> {
    Some(match name {
        "vivid" => "eq=saturation=1.4:contrast=1.1",
        "warm" => "colorbalance=rs=0.10:gs=0.03:bs=-0.10:rm=0.06:bm=-0.06,eq=saturation=1.08",
        "cool" => "colorbalance=rs=-0.08:bs=0.10:rm=-0.05:bm=0.06,eq=saturation=1.05",
        "mono" => "hue=s=0,eq=contrast=1.08",
        "sepia" => "colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131",
        "fade" => "eq=contrast=0.85:brightness=0.04:saturation=0.8",
        _ => return None,
    })
}

/// The three sliders as one `eq`, or None when all sit at zero. Brightness is additive in ffmpeg
/// and tops out at 0.4; contrast and saturation are multiples around 1.
fn slider_filter(edit: &Edit) -> Option<String> {
    if edit.brightness == 0 && edit.contrast == 0 && edit.saturation == 0 {
        return None;
    }
    let pct = |v: i32| v.clamp(-100, 100) as f64 / 100.0;
    Some(format!(
        "eq=brightness={:.3}:contrast={:.3}:saturation={:.3}",
        pct(edit.brightness) * 0.4,
        1.0 + pct(edit.contrast),
        1.0 + pct(edit.saturation)
    ))
}

/// The filters that turn, flip, crop and colour the picture, in that order, after the source's own
/// turn (which ffmpeg applies on the way in) and, for HDR written as SDR, the tone map.
fn picture_filters(edit: &Edit, src: &Src, tone_map: bool) -> Result<Vec<String>, String> {
    let mut f: Vec<String> = Vec::new();
    if tone_map {
        f.push(ff::TONE_MAP.to_string());
    }
    match edit.rotate {
        0 => {}
        90 => f.push("transpose=1".into()),
        180 => f.push("hflip,vflip".into()),
        270 => f.push("transpose=2".into()),
        other => return Err(format!("a turn of {other} degrees")),
    }
    if edit.flip_h {
        f.push("hflip".into());
    }
    if edit.flip_v {
        f.push("vflip".into());
    }
    let (w, h) = turned(src, edit.rotate);
    if let Some((cw, ch, x, y)) = edit.crop.as_ref().and_then(|c| crop_rect(c, w, h)) {
        f.push(format!("crop={cw}:{ch}:{x}:{y}"));
    }
    if let Some(preset) = preset_filter(&edit.filter) {
        f.push(preset.to_string());
    }
    if let Some(eq) = slider_filter(edit) {
        f.push(eq);
    }
    Ok(f)
}

// ---- The sound ----

fn seconds(ms: u64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

fn gain(percent: u32) -> String {
    format!("{:.3}", percent.min(200) as f64 / 100.0)
}

/// The audio part of the graph from `[0:a]` (the clip's own sound) and `[1:a]` (the music), ending
/// in `[a]`; None when the copy has no sound. `out_ms` is the length of the copy.
fn audio_graph(edit: &Edit, has_audio: bool, out_ms: u64) -> Option<String> {
    let music = edit.audio.music.as_ref().filter(|m| !m.path.is_empty());
    let replace = music.is_some_and(|m| m.mode == "replace");
    let own = has_audio && !edit.audio.mute && !replace;
    if !own && music.is_none() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if own {
        let mut chain = vec!["aformat=channel_layouts=stereo".to_string(), "aresample=48000".to_string()];
        let speed = edit.speed();
        if (speed - 1.0).abs() > 1e-9 {
            chain.push(format!("atempo={speed}"));
        }
        let volume = if edit.audio.volume == 0 { 100 } else { edit.audio.volume };
        if volume != 100 {
            chain.push(format!("volume={}", gain(volume)));
        }
        parts.push(format!("[0:a:0]{}[own]", chain.join(",")));
    }
    let last = if let Some(m) = music {
        let mut chain = vec![
            "aformat=channel_layouts=stereo".to_string(),
            "aresample=48000".to_string(),
            format!("atrim=duration={}", seconds(out_ms)),
            "asetpts=PTS-STARTPTS".to_string(),
        ];
        if m.volume != 100 {
            chain.push(format!("volume={}", gain(m.volume)));
        }
        if !m.looped {
            chain.push(format!("apad=whole_dur={}", seconds(out_ms)));
        }
        parts.push(format!("[1:a:0]{}[mus]", chain.join(",")));
        if own {
            parts.push("[own][mus]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]".into());
            "[mix]"
        } else {
            "[mus]"
        }
    } else {
        "[own]"
    };
    // The fades are laid over the whole mix, each no longer than the copy allows.
    let fade_in = edit.audio.fade_in_ms.min(out_ms);
    let fade_out = edit.audio.fade_out_ms.min(out_ms.saturating_sub(fade_in));
    let mut tail: Vec<String> = Vec::new();
    if fade_in > 0 {
        tail.push(format!("afade=t=in:st=0:d={}", seconds(fade_in)));
    }
    if fade_out > 0 {
        tail.push(format!("afade=t=out:st={}:d={}", seconds(out_ms - fade_out), seconds(fade_out)));
    }
    if tail.is_empty() {
        tail.push("anull".into());
    }
    parts.push(format!("{last}{}[a]", tail.join(",")));
    Some(parts.join(";"))
}

// ---- The encoding ----

/// How the picture is written: the encoder and what happens to the colour.
#[derive(Clone, Debug)]
pub struct Encoding {
    pub encoder: Encoder,
    pub colour: Colour,
}

/// An HDR source keeps its HDR when nothing colours it and the machine has an H.265 encoder that
/// writes 10 bits; anything else HDR is tone-mapped to SDR, written as H.264. SDR is H.264.
pub fn choose_encoding(
    edit: &Edit,
    src: &Src,
    avc: Option<&Encoder>,
    hevc: Option<&Encoder>,
    hevc_hdr: bool,
) -> Result<Encoding, String> {
    if src.is_hdr() && edit.look_is_neutral() && hevc_hdr {
        if let Some(encoder) = hevc {
            let colour = if src.transfer == "hlg" { Colour::KeepHlg } else { Colour::KeepPq };
            return Ok(Encoding { encoder: encoder.clone(), colour });
        }
    }
    let encoder = avc.ok_or("no video encoder here")?;
    let colour = if src.is_hdr() { Colour::ToSdr } else { Colour::Sdr };
    Ok(Encoding { encoder: encoder.clone(), colour })
}

/// The bitrate for the copy: the source's, scaled to the pixels left, with a floor and a ceiling;
/// a guess from the frame and rate when the source does not say.
pub fn target_bitrate(src: &Src, out_w: u32, out_h: u32) -> u64 {
    let out_px = out_w as f64 * out_h as f64;
    let src_px = (src.width as f64 * src.height as f64).max(1.0);
    let base = if src.video_bitrate > 0 {
        src.video_bitrate as f64 * (out_px / src_px).min(1.0)
    } else {
        out_px * src.fps.clamp(1.0, 60.0) * 0.1
    };
    base.clamp(1_500_000.0, 60_000_000.0) as u64
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|v| v.to_string()).collect()
}

/// The encoder and rate arguments of the video stream.
fn encode_args(enc: &Encoding, bitrate: u64) -> Vec<String> {
    let name = enc.encoder.name.as_str();
    let mut a = vec!["-c:v".to_string(), name.to_string()];
    if name == "libx264" {
        a.extend(strings(&["-crf", "19", "-preset", "medium"]));
    } else {
        a.extend(["-b:v".to_string(), bitrate.to_string()]);
        a.extend(["-maxrate".to_string(), (bitrate * 3 / 2).to_string()]);
        a.extend(["-bufsize".to_string(), (bitrate * 2).to_string()]);
    }
    if name.starts_with("hevc") {
        if enc.colour.keeps_hdr() {
            a.extend(strings(&["-profile:v", "main10"]));
        }
        a.extend(strings(&["-tag:v", "hvc1"]));
    }
    a.extend(ff::colour_tags(enc.colour));
    a
}

/// `ms` since the epoch as `2026-11-14T10:20:30.000000Z`, the form a container's creation time
/// takes.
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let micros = ms.rem_euclid(1000) * 1000;
    let z = secs.div_euclid(86_400) + 719_468;
    let rem = secs.rem_euclid(86_400);
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{micros:06}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// `2026-11-14T10:20:30.000000Z` (or without the fraction) as Unix milliseconds.
pub fn parse_iso_utc(text: &str) -> Option<i64> {
    let (date, time) = text.trim().split_once('T')?;
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let time = time.trim_end_matches('Z').split(['+', '-']).next()?;
    let (hms, frac) = time.split_once('.').unwrap_or((time, "0"));
    let mut p = hms.split(':');
    let (h, mi, sec): (i64, i64, i64) = (p.next()?.parse().ok()?, p.next()?.parse().ok()?, p.next()?.parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let yy = if m <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let millis: i64 = format!("{frac:0<3}")[..3].parse().ok()?;
    Some(((days * 24 + h) * 60 + mi) * 60 * 1000 + sec * 1000 + millis)
}

/// What a plan comes to: the arguments, how long the copy runs (what the progress is measured
/// against) and the file's extension.
#[derive(Debug, PartialEq)]
pub struct Plan {
    pub args: Vec<String>,
    pub out_ms: u64,
    pub ext: &'static str,
}

fn head() -> Vec<String> {
    strings(&["-hide_banner", "-loglevel", "error", "-nostats", "-y"])
}

/// The part of the source the edit keeps, checked.
fn span(edit: &Edit, src: &Src) -> Result<(u64, u64), String> {
    let end = if edit.end_ms == 0 || edit.end_ms > src.duration_ms { src.duration_ms } else { edit.end_ms };
    if end < edit.start_ms + MIN_SPAN_MS {
        return Err("nothing left to keep".into());
    }
    Ok((edit.start_ms, end))
}

/// The arguments of the edit as a video: one pass over the kept part with the picture and the
/// sound each through their filters, written as MP4. A music file in the edit is already vetted.
pub fn video_plan(edit: &Edit, src: &Src, enc: &Encoding, dst: &str) -> Result<Plan, String> {
    let speed = edit.speed();
    if !(0.5..=2.0).contains(&speed) {
        return Err(format!("a speed of {speed}"));
    }
    let (start, end) = span(edit, src)?;
    let out_ms = ((end - start) as f64 / speed).round() as u64;
    let (out_w, out_h) = output_frame(edit, src);

    let mut picture = picture_filters(edit, src, enc.colour == Colour::ToSdr)?;
    if (speed - 1.0).abs() > 1e-9 {
        picture.push(format!("setpts=(PTS-STARTPTS)/{speed}"));
    }
    let (turned_w, turned_h) = turned(src, edit.rotate);
    let (before_w, before_h) = edit
        .crop
        .as_ref()
        .and_then(|c| crop_rect(c, turned_w, turned_h))
        .map(|(w, h, _, _)| (w, h))
        .unwrap_or((turned_w, turned_h));
    if before_w % 2 == 1 || before_h % 2 == 1 {
        picture.push(format!("scale={out_w}:{out_h}"));
    }
    let keeps_hdr = enc.colour.keeps_hdr();
    if enc.encoder.vaapi.is_some() {
        picture.push(format!("format={},hwupload", if keeps_hdr { ff::TEN_BIT } else { "nv12" }));
    } else {
        picture.push(format!("format={}", if keeps_hdr { ff::TEN_BIT } else { ff::frame_format(&enc.encoder.name) }));
    }
    let mut graph = format!("[0:v:0]{}[v]", picture.join(","));

    let music = edit.audio.music.as_ref().filter(|m| !m.path.is_empty());
    let audio = audio_graph(edit, src.has_audio, out_ms);
    if let Some(a) = &audio {
        graph.push(';');
        graph.push_str(a);
    }

    let mut a = head();
    if let Some(device) = &enc.encoder.vaapi {
        a.extend(["-vaapi_device".to_string(), device.clone()]);
    }
    a.extend(["-ss".to_string(), seconds(start), "-t".to_string(), seconds(end - start)]);
    a.extend(["-i".to_string(), edit.src.clone()]);
    if let Some(m) = music {
        if m.looped {
            a.extend(strings(&["-stream_loop", "-1"]));
        }
        a.extend(["-i".to_string(), m.path.clone()]);
    }
    a.extend(["-filter_complex".to_string(), graph]);
    a.extend(strings(&["-map", "[v]"]));
    if audio.is_some() {
        a.extend(strings(&["-map", "[a]", "-c:a", "aac", "-b:a", "160k"]));
    } else {
        a.push("-an".into());
    }
    a.extend(encode_args(enc, target_bitrate(src, out_w, out_h)));
    if music.is_some() {
        a.extend(["-t".to_string(), seconds(out_ms)]);
    }
    if let Some(ms) = edit.creation_ms {
        a.extend(["-metadata".to_string(), format!("creation_time={}", iso_utc(ms))]);
    }
    // The source's tags (a phone's place and make) go over as QuickTime keys, which an MP4 holds only
    // with `use_metadata_tags`; the brands are the source container's, not the copy's.
    a.extend(strings(&["-metadata", "major_brand=", "-metadata", "minor_version=", "-metadata", "compatible_brands="]));
    a.extend(strings(&["-movflags", "+faststart+use_metadata_tags", "-progress", "pipe:1"]));
    a.push(dst.to_string());
    Ok(Plan { args: a, out_ms, ext: "mp4" })
}

/// The arguments of the edit as a looping GIF: the picture through the same filters, then one
/// palette made for the whole clip and used for every frame.
pub fn gif_plan(edit: &Edit, src: &Src, dst: &str) -> Result<Plan, String> {
    let speed = edit.speed();
    if !(0.5..=2.0).contains(&speed) {
        return Err(format!("a speed of {speed}"));
    }
    let (start, end) = span(edit, src)?;
    let out_ms = ((end - start) as f64 / speed).round() as u64;
    if out_ms > GIF_MAX_MS {
        return Err("that is too long for a GIF".into());
    }
    let fps = edit.gif.fps.clamp(1, 30);
    let (frame_w, _) = output_frame(edit, src);
    let width = edit.gif.width.clamp(16, GIF_MAX_WIDTH).min(frame_w.max(16));
    let mut picture = picture_filters(edit, src, src.is_hdr())?;
    if (speed - 1.0).abs() > 1e-9 {
        picture.push(format!("setpts=(PTS-STARTPTS)/{speed}"));
    }
    picture.push(format!("fps={fps}"));
    picture.push(format!("scale={width}:-2:flags=lanczos"));
    let graph = format!(
        "[0:v:0]{},split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[g]",
        picture.join(",")
    );
    let mut a = head();
    a.extend(["-ss".to_string(), seconds(start), "-t".to_string(), seconds(end - start)]);
    a.extend(["-i".to_string(), edit.src.clone()]);
    a.extend(["-filter_complex".to_string(), graph]);
    a.extend(strings(&["-map", "[g]", "-an", "-loop", "0", "-f", "gif", "-progress", "pipe:1"]));
    a.push(dst.to_string());
    Ok(Plan { args: a, out_ms, ext: "gif" })
}

/// The arguments of one frame of the video, through the picture filters (turn, crop, look), as a
/// JPEG.
pub fn frame_plan(edit: &Edit, src: &Src, dst: &str) -> Result<Plan, String> {
    if src.duration_ms > 0 && edit.frame_ms > src.duration_ms {
        return Err("that moment is past the end".into());
    }
    let mut picture = picture_filters(edit, src, src.is_hdr())?;
    picture.push("format=yuvj420p".into());
    let mut a = head();
    a.extend(["-ss".to_string(), seconds(edit.frame_ms), "-i".to_string(), edit.src.clone()]);
    a.extend(["-vf".to_string(), picture.join(",")]);
    a.extend(strings(&["-frames:v", "1", "-an", "-q:v", "2", "-f", "mjpeg", "-progress", "pipe:1"]));
    a.push(dst.to_string());
    Ok(Plan { args: a, out_ms: 0, ext: "jpg" })
}

/// The arguments that read `times` (seconds) off `src` as one JPEG strip, one frame beside the
/// next, `height` pixels tall, to stdout. Each frame is its own fast seek.
pub fn strip_args(src: &str, times: &[f64], height: u32, tone_map: bool) -> Vec<String> {
    let mut a = strings(&["-hide_banner", "-loglevel", "error", "-nostats"]);
    let mut graph = String::new();
    for (i, t) in times.iter().enumerate() {
        a.extend(["-ss".to_string(), format!("{t:.3}"), "-i".to_string(), src.to_string()]);
        let tone = if tone_map { format!(",{}", ff::TONE_MAP) } else { String::new() };
        graph.push_str(&format!("[{i}:v:0]scale=-2:{height}{tone},format=yuvj420p[t{i}];"));
    }
    if times.len() == 1 {
        graph.push_str("[t0]null[o]");
    } else {
        for i in 0..times.len() {
            graph.push_str(&format!("[t{i}]"));
        }
        graph.push_str(&format!("hstack=inputs={}[o]", times.len()));
    }
    a.extend(["-filter_complex".to_string(), graph]);
    a.extend(strings(&["-map", "[o]", "-frames:v", "1", "-q:v", "5", "-f", "mjpeg", "pipe:1"]));
    a
}

/// The moments a strip of `count` frames reads from a video of `duration_ms`: the middle of each
/// of `count` equal parts, kept off the very end.
pub fn strip_times(duration_ms: u64, count: usize) -> Vec<f64> {
    let count = count.max(1);
    let total = duration_ms as f64 / 1000.0;
    (0..count).map(|i| ((i as f64 + 0.5) / count as f64 * total).min((total - 0.05).max(0.0))).collect()
}

/// The arguments that make the picture the upload uses as the copy's thumbnail: one frame from
/// `at_ms` into `file`, at most 1280 pixels on a side.
pub fn thumb_args(file: &str, at_ms: u64, dst: &str) -> Vec<String> {
    let mut a = strings(&["-hide_banner", "-loglevel", "error", "-nostats", "-y"]);
    a.extend(["-ss".to_string(), seconds(at_ms), "-i".to_string(), file.to_string()]);
    a.extend(strings(&[
        "-vf",
        "scale=1280:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p",
        "-frames:v",
        "1",
        "-an",
        "-q:v",
        "3",
        "-f",
        "mjpeg",
    ]));
    a.push(dst.to_string());
    a
}

// ---- Running it ----

fn jobs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The music files the picker handed out this session: the only ones an edit may mix in.
fn picked() -> &'static Mutex<HashSet<String>> {
    static PICKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    PICKED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// A job id as the window makes it: letters, digits and dashes, so it is one safe path component.
fn valid_job(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A path inside the staging folder.
fn staged(root: &Path, path: &Path) -> bool {
    match (std::fs::canonicalize(path), std::fs::canonicalize(root)) {
        (Ok(p), Ok(root)) => p.starts_with(root),
        _ => false,
    }
}

/// The file an edit reads: a video of the user's own, or one the sidecar staged.
fn source_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let given = Path::new(path);
    if staged(&staging_root(app), given) {
        return std::fs::canonicalize(given).map_err(|_| "that file could not be found".to_string());
    }
    let resolved = crate::local_file::checked_media_path(app, path)?;
    let ext = crate::local_file::extension_of(&resolved.to_string_lossy());
    match crate::local_file::media_entry(&ext) {
        Some((_, mime, _)) if mime.starts_with("video/") => Ok(resolved),
        _ => Err("that file is not a video".into()),
    }
}

/// ffmpeg and ffprobe want a path without the `\\?\` prefix.
fn plain(path: PathBuf) -> String {
    crate::strip_verbatim(path).to_string_lossy().into_owned()
}

/// When the video was made: its container's creation time, else the file's own dates.
fn capture_ms(path: &str) -> Option<i64> {
    let out = ff::command("ffprobe")
        .args(["-v", "error", "-show_entries", "format_tags=creation_time", "-of", "default=nw=1:nk=1", path])
        .output()
        .ok()?;
    let from_tag = String::from_utf8_lossy(&out.stdout).lines().next().and_then(parse_iso_utc);
    from_tag.filter(|ms| *ms > 0).or_else(|| {
        let meta = std::fs::metadata(path).ok()?;
        let t = meta.modified().or_else(|_| meta.created()).ok()?;
        t.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
    })
}

/// Opens a video for the editor: vets the path, lets the window play it and reads what the edit
/// needs of it.
#[tauri::command]
pub async fn video_edit_open(app: AppHandle, path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let resolved = source_path(&app, &path)?;
        app.asset_protocol_scope()
            .allow_file(&resolved)
            .map_err(|e| format!("that file could not be opened for viewing: {e}"))?;
        let plain_path = plain(resolved);
        let mut info = crate::video_compress::probe(&plain_path)?;
        if info["width"].as_u64().unwrap_or(0) == 0 {
            return Err("that file has no picture".into());
        }
        info["path"] = json!(plain_path);
        info["url"] = json!(crate::local_file::asset_url(Path::new(&plain_path)));
        info["captureMs"] = json!(capture_ms(&plain_path));
        Ok(info)
    })
    .await
    .map_err(|e| format!("opening that video failed: {e}"))?
}

/// A strip of frames across the video, as one JPEG data URL.
#[tauri::command]
pub async fn video_edit_strip(app: AppHandle, path: String, count: u32, hdr: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine as _;
        let resolved = plain(source_path(&app, &path)?);
        let duration = crate::video_compress::probe(&resolved)?["durationMs"].as_u64().unwrap_or(0);
        let times = strip_times(duration, count.clamp(1, 48) as usize);
        let out = ff::command("ffmpeg")
            .args(strip_args(&resolved, &times, 64, hdr))
            .output()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        if !out.status.success() || out.stdout.is_empty() {
            return Err(format!("ffmpeg: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&out.stdout)))
    })
    .await
    .map_err(|e| format!("reading the frames failed: {e}"))?
}

/// Picks a music file; the answer names it and says how long it is. Only a file picked here can
/// be mixed in.
#[tauri::command]
pub async fn video_edit_pick_audio(window: tauri::WebviewWindow, title: String) -> Result<Option<Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        window
            .dialog()
            .file()
            .set_title(&title)
            .add_filter("Audio", &["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus", "wma", "mka"])
            .set_parent(&window)
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(file) = chosen else { return Ok(None) };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let resolved = std::fs::canonicalize(&path).map_err(|_| "that file could not be found".to_string())?;
    let plain_path = plain(resolved);
    let length = tauri::async_runtime::spawn_blocking({
        let p = plain_path.clone();
        move || audio_duration_ms(&p)
    })
    .await
    .map_err(|e| e.to_string())??;
    picked().lock().unwrap().insert(plain_path.clone());
    let name = Path::new(&plain_path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Some(json!({ "path": plain_path, "name": name, "durationMs": length })))
}

/// The length of a music file, or an error when ffmpeg cannot read it as sound.
fn audio_duration_ms(path: &str) -> Result<u64, String> {
    let out = ff::command("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|e| format!("ffprobe: {e}"))?;
    let read: Value = serde_json::from_slice(&out.stdout).map_err(|_| "that file is not sound".to_string())?;
    if read["streams"].as_array().is_none_or(|v| v.is_empty()) {
        return Err("that file has no sound".into());
    }
    let seconds = read["format"]["duration"].as_str().and_then(|d| d.parse::<f64>().ok()).unwrap_or(0.0);
    Ok((seconds * 1000.0).round() as u64)
}

/// Makes the edit: one ffmpeg pass into the job's staging folder. Progress goes out as
/// `video-edit-progress` events; the answer names the file, its thumbnail and its size.
#[tauri::command]
pub async fn video_edit_run(app: AppHandle, job_id: String, edit: Value) -> Result<Value, String> {
    if !valid_job(&job_id) {
        return Err("not a job".into());
    }
    let edit: Edit = serde_json::from_value(edit).map_err(|e| format!("the edit: {e}"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    jobs().lock().unwrap().insert(job_id.clone(), Arc::clone(&cancel));
    let id = job_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run(&app, &id, edit, &cancel)).await;
    jobs().lock().unwrap().remove(&job_id);
    result.map_err(|e| format!("the edit stopped: {e}"))?
}

fn run(app: &AppHandle, job_id: &str, mut edit: Edit, cancel: &AtomicBool) -> Result<Value, String> {
    let src_path = plain(source_path(app, &edit.src)?);
    edit.src = src_path.clone();
    if let Some(music) = edit.audio.music.as_mut() {
        if !music.path.is_empty() && !picked().lock().unwrap().contains(&music.path) {
            return Err("that music was not picked here".into());
        }
        if music.volume == 0 {
            music.volume = 100;
        }
    }
    let src = Src::from_probe(&crate::video_compress::probe(&src_path)?);
    if src.width == 0 {
        return Err("that file has no picture".into());
    }
    let root = staging_root(app);
    private_dir(&root).map_err(|e| e.to_string())?;
    let dir = root.join(job_id);
    private_dir(&dir).map_err(|e| e.to_string())?;
    let kind = if edit.kind.is_empty() { "video" } else { edit.kind.as_str() };
    let dst = |ext: &str| plain(dir.join(format!("out.{ext}")));
    let plan = match kind {
        "video" => {
            let found = ff::encoders();
            let enc = choose_encoding(&edit, &src, found.avc.as_ref(), found.hevc.as_ref(), found.hevc_hdr)?;
            video_plan(&edit, &src, &enc, &dst("mp4"))
        }
        "gif" => gif_plan(&edit, &src, &dst("gif")),
        "frame" => frame_plan(&edit, &src, &dst("jpg")),
        other => Err(format!("an edit of kind {other}")),
    };
    let plan = match plan {
        Ok(plan) => plan,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    let out_path = dst(plan.ext);
    let emit = |value: f64| {
        let _ = app.emit("video-edit-progress", json!({ "jobId": job_id, "value": value }));
    };
    if let Err(e) = crate::video_compress::run_ffmpeg(&plan.args, plan.out_ms * 1000, &out_path, cancel, &emit) {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    let size = std::fs::metadata(&out_path).map(|m| m.len()).unwrap_or(0);
    let facts = crate::video_compress::probe(&out_path).ok();
    let thumb = if is_own_thumb(kind) {
        Some(out_path.clone())
    } else {
        let thumb_path = plain(dir.join("thumb.jpg"));
        let at = facts.as_ref().and_then(|f| f["durationMs"].as_u64()).unwrap_or(0) / 2;
        let made = ff::command("ffmpeg").args(thumb_args(&out_path, at, &thumb_path)).output();
        made.is_ok_and(|o| o.status.success()).then_some(thumb_path)
    };
    let fact = |key: &str| facts.as_ref().map(|f| f[key].clone()).unwrap_or(Value::Null);
    Ok(json!({
        "path": out_path,
        "thumb": thumb,
        "size": size,
        "kind": kind,
        "ext": plan.ext,
        "width": fact("width"),
        "height": fact("height"),
        "durationMs": fact("durationMs"),
    }))
}

/// Whether an edit's output is handed over as its own thumbnail source: a frame is a picture
/// already, and a GIF's first frame is read by the sidecar, as the bundled ffmpeg has no GIF decoder.
fn is_own_thumb(kind: &str) -> bool {
    matches!(kind, "frame" | "gif")
}

/// Stops a running edit; its folder goes with it.
#[tauri::command]
pub fn video_edit_cancel(job_id: String) {
    if let Some(flag) = jobs().lock().unwrap().get(&job_id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Deletes what an edit staged, once its file has been saved or let go. `path` is the edit's output
/// or a staged source; the folder it sits in goes.
#[tauri::command]
pub fn video_edit_discard(app: AppHandle, path: String) {
    discard_in(&staging_root(&app), Path::new(&path));
}

/// Removes the folder `path` sits in when that folder is inside `root` and is not `root` itself.
fn discard_in(root: &Path, path: &Path) {
    if !staged(root, path) {
        return;
    }
    let (Some(dir), Ok(root)) = (path.parent().and_then(|d| std::fs::canonicalize(d).ok()), std::fs::canonicalize(root)) else {
        return;
    };
    if dir != root && dir.starts_with(&root) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The name of a copy: `stem_tag_yyyyMMdd_HHmmss.ext`, and `_2`, `_3`... when taken.
pub fn copy_name(stem: &str, tag: &str, stamp: &str, n: u32, ext: &str) -> String {
    if n <= 1 {
        format!("{stem}_{tag}_{stamp}.{ext}")
    } else {
        format!("{stem}_{tag}_{stamp}_{n}.{ext}")
    }
}

/// Writes the edit's file as a new copy beside the original, with the original's capture time as
/// the copy's modified time so the two sort together. Returns the copy's path. The original is
/// never overwritten.
#[tauri::command]
pub async fn video_edit_save_local(
    app: AppHandle,
    window: tauri::WebviewWindow,
    src_path: String,
    edited_path: String,
    capture_ms: Option<i64>,
    pick_title: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let original = crate::local_file::checked_media_path(&app, &src_path)?;
        let edited = PathBuf::from(&edited_path);
        if !staged(&staging_root(&app), &edited) {
            return Err("that file was not made here".into());
        }
        let ext = edited.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_ascii_lowercase();
        let tag = match ext.as_str() {
            "gif" => "gif",
            "jpg" => "frame",
            _ => "edit",
        };
        let parent = original.parent().ok_or("that video has no folder")?;
        let stem = original.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "video".into());
        let stamp = crate::photo_edit::stamp_str(&crate::photo_edit::local_now());
        if crate::local_file::is_portal_copy(&original) {
            let dest = crate::local_file::pick_copy_place(
                &window,
                &original,
                &copy_name(&stem, tag, &stamp, 1, &ext),
                &ext,
                pick_title.as_deref(),
            )?;
            return crate::local_file::write_picked_copy(&dest, |file| write_copy(&edited, file, &dest, capture_ms));
        }
        for n in 1..=10_000u32 {
            let dest = parent.join(copy_name(&stem, tag, &stamp, n, &ext));
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
                Ok(file) => {
                    write_copy(&edited, file, &dest, capture_ms)?;
                    return Ok(crate::strip_verbatim(dest).to_string_lossy().into_owned());
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(format!("the copy could not be written: {e}")),
            }
        }
        Err("a free name for the copy could not be found".into())
    })
    .await
    .map_err(|e| format!("saving that video failed: {e}"))?
}

/// Copies `from` into `file`, just created at `dest`, and gives it `capture_ms` as its modified
/// time. A copy that fails is deleted, so no partial file is left beside the original.
fn write_copy(from: &Path, mut file: std::fs::File, dest: &Path, capture_ms: Option<i64>) -> Result<(), String> {
    let copied = std::fs::File::open(from)
        .and_then(|mut src| std::io::copy(&mut src, &mut file))
        .and_then(|_| file.sync_all());
    if let Err(e) = copied {
        drop(file);
        let _ = std::fs::remove_file(dest);
        return Err(format!("the copy could not be written: {e}"));
    }
    if let Some(ms) = capture_ms.filter(|m| *m > 0) {
        let when = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
        let _ = file.set_modified(when);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src() -> Src {
        Src {
            width: 1920,
            height: 1080,
            rotation: 0,
            duration_ms: 20_000,
            fps: 30.0,
            video_bitrate: 8_000_000,
            has_audio: true,
            transfer: "sdr".into(),
        }
    }

    fn sdr_enc() -> Encoding {
        Encoding { encoder: Encoder { name: "libx264".into(), vaapi: None }, colour: Colour::Sdr }
    }

    fn arg_after(args: &[String], flag: &str) -> String {
        let i = args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("no {flag} in {args:?}"));
        args[i + 1].clone()
    }

    fn graph(plan: &Plan) -> String {
        arg_after(&plan.args, "-filter_complex")
    }

    #[test]
    fn a_plain_trim_seeks_on_the_input_and_reencodes() {
        let edit = Edit { src: "in.mp4".into(), start_ms: 2_000, end_ms: 7_500, ..Default::default() };
        let plan = video_plan(&edit, &src(), &sdr_enc(), "out.mp4").unwrap();
        assert_eq!(arg_after(&plan.args, "-ss"), "2.000");
        assert_eq!(arg_after(&plan.args, "-t"), "5.500");
        assert_eq!(plan.out_ms, 5_500);
        assert_eq!(graph(&plan).split(';').next().unwrap(), "[0:v:0]format=yuv420p[v]");
        assert_eq!(plan.args.last().unwrap(), "out.mp4");
        assert!(plan.args.windows(2).any(|w| w == ["-c:v", "libx264"]));
        assert!(plan.args.windows(2).any(|w| w == ["-crf", "19"]));
    }

    #[test]
    fn the_end_of_zero_or_past_the_video_is_the_video_end() {
        let edit = Edit { src: "in.mp4".into(), start_ms: 1_000, end_ms: 0, ..Default::default() };
        assert_eq!(video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap().out_ms, 19_000);
        let edit = Edit { end_ms: 99_000, ..edit };
        assert_eq!(video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap().out_ms, 19_000);
    }

    #[test]
    fn a_trim_with_nothing_left_is_refused() {
        let edit = Edit { start_ms: 5_000, end_ms: 5_050, ..Default::default() };
        assert!(video_plan(&edit, &src(), &sdr_enc(), "o.mp4").is_err());
    }

    #[test]
    fn the_turn_flip_crop_and_look_come_in_that_order() {
        let edit = Edit {
            rotate: 90,
            flip_h: true,
            crop: Some(Crop { x: 0.0, y: 0.25, w: 1.0, h: 0.5 }),
            filter: "mono".into(),
            brightness: 10,
            ..Default::default()
        };
        let g = graph(&video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap());
        let chain = g.split(';').next().unwrap();
        let pos = |needle: &str| chain.find(needle).unwrap_or_else(|| panic!("{needle} missing in {chain}"));
        assert!(pos("transpose=1") < pos("hflip"));
        assert!(pos("hflip") < pos("crop="));
        assert!(pos("crop=") < pos("hue=s=0"));
        assert!(pos("hue=s=0") < pos("eq=brightness=0.040"));
        // 1920x1080 turned is 1080x1920; a half-height band from a quarter down.
        assert!(chain.contains("crop=1080:960:0:480"), "{chain}");
    }

    #[test]
    fn crop_rects_are_even_and_stay_inside_the_frame() {
        assert_eq!(crop_rect(&Crop { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 1920, 1080), None);
        assert_eq!(crop_rect(&Crop { x: 0.25, y: 0.0, w: 0.5, h: 1.0 }, 1920, 1080), Some((960, 1080, 480, 0)));
        // 0.333 of 1081 is 360.0..., odd values floor to even.
        let (w, h, x, y) = crop_rect(&Crop { x: 0.1, y: 0.1, w: 0.333, h: 0.333 }, 1081, 1081).unwrap();
        assert!(w % 2 == 0 && h % 2 == 0 && x % 2 == 0 && y % 2 == 0);
        // A box reaching past the edge is pulled back inside.
        let (w, _, x, _) = crop_rect(&Crop { x: 0.9, y: 0.0, w: 0.5, h: 1.0 }, 1000, 1000).unwrap();
        assert!(x + w <= 1000);
        // Nonsense never panics or produces nothing.
        assert!(crop_rect(&Crop { x: f64::NAN, y: -3.0, w: 0.0, h: 9.0 }, 640, 480).is_some());
        assert_eq!(crop_rect(&Crop { x: 0.0, y: 0.0, w: 1.0, h: 1.0 }, 1, 1), None);
    }

    #[test]
    fn the_output_frame_follows_the_turn_and_the_crop() {
        let edit = Edit { rotate: 270, crop: Some(Crop { x: 0.0, y: 0.0, w: 1.0, h: 0.5 }), ..Default::default() };
        assert_eq!(output_frame(&edit, &src()), (1080, 960));
        let phone = Src { width: 1920, height: 1080, rotation: 90, ..src() };
        assert_eq!(output_frame(&Edit::default(), &phone), (1080, 1920));
        assert_eq!(output_frame(&Edit { rotate: 90, ..Default::default() }, &phone), (1920, 1080));
    }

    #[test]
    fn an_odd_frame_is_scaled_down_to_even_before_the_encoder() {
        let odd = Src { width: 1081, height: 607, ..src() };
        let g = graph(&video_plan(&Edit::default(), &odd, &sdr_enc(), "o.mp4").unwrap());
        assert!(g.contains("scale=1080:606"), "{g}");
    }

    #[test]
    fn speed_changes_the_picture_clock_and_the_sound_tempo() {
        let edit = Edit { speed: 2.0, start_ms: 0, end_ms: 10_000, ..Default::default() };
        let plan = video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap();
        let g = graph(&plan);
        assert!(g.contains("setpts=(PTS-STARTPTS)/2"), "{g}");
        assert!(g.contains("atempo=2"), "{g}");
        assert_eq!(plan.out_ms, 5_000);
        let slow = Edit { speed: 0.5, ..edit };
        assert_eq!(video_plan(&slow, &src(), &sdr_enc(), "o.mp4").unwrap().out_ms, 20_000);
        assert!(video_plan(&Edit { speed: 3.0, ..Default::default() }, &src(), &sdr_enc(), "o.mp4").is_err());
        // Zero is the unset value and means normal speed.
        let g = graph(&video_plan(&Edit::default(), &src(), &sdr_enc(), "o.mp4").unwrap());
        assert!(!g.contains("setpts") && !g.contains("atempo"));
    }

    #[test]
    fn mute_without_music_writes_no_sound() {
        let edit = Edit { audio: AudioEdit { mute: true, ..Default::default() }, ..Default::default() };
        let plan = video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap();
        assert!(plan.args.contains(&"-an".to_string()));
        assert!(!graph(&plan).contains("[a]"));
        let silent = Src { has_audio: false, ..src() };
        assert!(video_plan(&Edit::default(), &silent, &sdr_enc(), "o.mp4").unwrap().args.contains(&"-an".to_string()));
    }

    #[test]
    fn volume_and_fades_land_on_the_sound() {
        let edit = Edit {
            start_ms: 0,
            end_ms: 10_000,
            audio: AudioEdit { volume: 150, fade_in_ms: 1_000, fade_out_ms: 2_000, ..Default::default() },
            ..Default::default()
        };
        let g = graph(&video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap());
        assert!(g.contains("volume=1.500"), "{g}");
        assert!(g.contains("afade=t=in:st=0:d=1.000"), "{g}");
        assert!(g.contains("afade=t=out:st=8.000:d=2.000"), "{g}");
        assert!(g.ends_with("[a]"));
    }

    #[test]
    fn fades_never_exceed_the_copy() {
        let edit = Edit {
            start_ms: 0,
            end_ms: 1_000,
            audio: AudioEdit { fade_in_ms: 800, fade_out_ms: 800, ..Default::default() },
            ..Default::default()
        };
        let g = graph(&video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap());
        assert!(g.contains("afade=t=in:st=0:d=0.800"), "{g}");
        assert!(g.contains("afade=t=out:st=0.800:d=0.200"), "{g}");
    }

    fn music(mode: &str, looped: bool) -> Option<Music> {
        Some(Music { path: "song.mp3".into(), volume: 60, mode: mode.into(), looped })
    }

    #[test]
    fn music_that_replaces_drops_the_clips_own_sound() {
        let edit = Edit {
            start_ms: 0,
            end_ms: 8_000,
            audio: AudioEdit { music: music("replace", false), ..Default::default() },
            ..Default::default()
        };
        let plan = video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap();
        let g = graph(&plan);
        assert!(!g.contains("[0:a"), "{g}");
        assert!(g.contains("[1:a:0]") && g.contains("volume=0.600") && g.contains("atrim=duration=8.000"), "{g}");
        assert!(g.contains("apad=whole_dur=8.000"), "a shorter song is padded: {g}");
        assert!(plan.args.windows(2).any(|w| w == ["-i", "song.mp3"]));
        assert_eq!(arg_after(&plan.args[plan.args.len() - 20..], "-t"), "8.000");
    }

    #[test]
    fn music_that_mixes_plays_under_the_clips_sound_and_can_loop() {
        let edit = Edit {
            start_ms: 0,
            end_ms: 8_000,
            audio: AudioEdit { music: music("mix", true), ..Default::default() },
            ..Default::default()
        };
        let plan = video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap();
        let g = graph(&plan);
        assert!(g.contains("[0:a:0]") && g.contains("amix=inputs=2:duration=first"), "{g}");
        assert!(!g.contains("apad"), "a looped song needs no padding: {g}");
        let i = plan.args.iter().position(|a| a == "-stream_loop").unwrap();
        assert_eq!(&plan.args[i..i + 4], ["-stream_loop", "-1", "-i", "song.mp3"]);
    }

    #[test]
    fn muted_clip_with_mixed_music_keeps_only_the_music() {
        let edit = Edit {
            audio: AudioEdit { mute: true, music: music("mix", false), ..Default::default() },
            ..Default::default()
        };
        let g = graph(&video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap());
        assert!(!g.contains("[0:a") && !g.contains("amix"), "{g}");
    }

    #[test]
    fn the_capture_time_is_written_as_creation_time() {
        let edit = Edit { creation_ms: Some(1_700_000_000_123), ..Default::default() };
        let plan = video_plan(&edit, &src(), &sdr_enc(), "o.mp4").unwrap();
        assert_eq!(arg_after(&plan.args, "-metadata"), "creation_time=2023-11-14T22:13:20.123000Z");
        assert!(plan.args.windows(2).any(|w| w == ["-movflags", "+faststart+use_metadata_tags"]));
    }

    #[test]
    fn iso_times_round_trip() {
        for ms in [0i64, 951_782_400_000, 1_700_000_000_123, 4_102_444_799_999, -86_400_000] {
            assert_eq!(parse_iso_utc(&iso_utc(ms)), Some(ms), "{ms}");
        }
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00.000000Z");
        assert_eq!(parse_iso_utc("2024-02-29T12:00:00Z"), Some(1_709_208_000_000));
        assert_eq!(parse_iso_utc("garbage"), None);
    }

    fn hdr_src(transfer: &str) -> Src {
        Src { transfer: transfer.into(), ..src() }
    }

    fn enc(name: &str) -> Encoder {
        Encoder { name: name.into(), vaapi: None }
    }

    #[test]
    fn hdr_is_kept_only_when_nothing_colours_it_and_the_encoder_writes_ten_bits() {
        let neutral = Edit::default();
        let (avc, hevc) = (enc("libx264"), enc("hevc_nvenc"));
        let kept = choose_encoding(&neutral, &hdr_src("pq"), Some(&avc), Some(&hevc), true).unwrap();
        assert_eq!(kept.colour, Colour::KeepPq);
        assert_eq!(kept.encoder.name, "hevc_nvenc");
        assert_eq!(choose_encoding(&neutral, &hdr_src("hlg"), Some(&avc), Some(&hevc), true).unwrap().colour, Colour::KeepHlg);
        let tinted = Edit { filter: "vivid".into(), ..Default::default() };
        let mapped = choose_encoding(&tinted, &hdr_src("pq"), Some(&avc), Some(&hevc), true).unwrap();
        assert_eq!((mapped.colour, mapped.encoder.name.as_str()), (Colour::ToSdr, "libx264"));
        assert_eq!(choose_encoding(&neutral, &hdr_src("pq"), Some(&avc), Some(&hevc), false).unwrap().colour, Colour::ToSdr);
        assert_eq!(choose_encoding(&neutral, &src(), Some(&avc), Some(&hevc), true).unwrap().colour, Colour::Sdr);
        assert!(choose_encoding(&neutral, &src(), None, None, false).is_err());
    }

    #[test]
    fn tone_mapped_hdr_runs_the_map_first_and_kept_hdr_writes_ten_bit_tags() {
        let mapped = Encoding { encoder: enc("libx264"), colour: Colour::ToSdr };
        let g = graph(&video_plan(&Edit { rotate: 90, ..Default::default() }, &hdr_src("pq"), &mapped, "o.mp4").unwrap());
        assert!(g.starts_with(&format!("[0:v:0]{},transpose=1", ff::TONE_MAP)), "{g}");

        let kept = Encoding { encoder: enc("hevc_nvenc"), colour: Colour::KeepPq };
        let plan = video_plan(&Edit::default(), &hdr_src("pq"), &kept, "o.mp4").unwrap();
        assert!(graph(&plan).contains("format=p010le[v]"));
        assert!(plan.args.windows(2).any(|w| w == ["-profile:v", "main10"]));
        assert!(plan.args.windows(2).any(|w| w == ["-color_trc", "smpte2084"]));
        assert!(plan.args.windows(2).any(|w| w == ["-tag:v", "hvc1"]));
        assert!(plan.args.contains(&"-b:v".to_string()), "hardware encoders take a bitrate, not a crf");
    }

    #[test]
    fn a_vaapi_encoder_uploads_the_frames() {
        let vaapi = Encoding {
            encoder: Encoder { name: "h264_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) },
            colour: Colour::Sdr,
        };
        let plan = video_plan(&Edit::default(), &src(), &vaapi, "o.mp4").unwrap();
        assert!(graph(&plan).contains("format=nv12,hwupload[v]"));
        assert_eq!(arg_after(&plan.args, "-vaapi_device"), "/dev/dri/renderD128");
    }

    #[test]
    fn the_bitrate_follows_the_source_and_the_pixels_left() {
        assert_eq!(target_bitrate(&src(), 1920, 1080), 8_000_000);
        assert_eq!(target_bitrate(&src(), 960, 540), 2_000_000);
        assert_eq!(target_bitrate(&src(), 100, 100), 1_500_000);
        let unknown = Src { video_bitrate: 0, ..src() };
        assert_eq!(target_bitrate(&unknown, 1920, 1080), 6_220_800);
    }

    #[test]
    fn a_gif_is_one_palette_pass_at_the_chosen_width_and_rate() {
        let edit = Edit {
            kind: "gif".into(),
            src: "in.mp4".into(),
            start_ms: 1_000,
            end_ms: 4_000,
            gif: GifEdit { width: 480, fps: 15 },
            crop: Some(Crop { x: 0.0, y: 0.0, w: 0.5, h: 1.0 }),
            ..Default::default()
        };
        let plan = gif_plan(&edit, &src(), "o.gif").unwrap();
        let g = graph(&plan);
        assert!(g.contains("crop=960:1080:0:0,fps=15,scale=480:-2:flags=lanczos,split[a][b]"), "{g}");
        assert!(g.contains("palettegen=max_colors=256:stats_mode=diff") && g.contains("paletteuse=dither=bayer"), "{g}");
        assert_eq!(plan.ext, "gif");
        assert_eq!(plan.out_ms, 3_000);
        assert!(plan.args.windows(2).any(|w| w == ["-loop", "0"]));
        assert!(plan.args.contains(&"-an".to_string()));
    }

    #[test]
    fn a_gif_is_not_widened_and_not_made_too_long() {
        let narrow = Edit { crop: Some(Crop { x: 0.0, y: 0.0, w: 0.1, h: 1.0 }), gif: GifEdit { width: 720, fps: 10 }, ..Default::default() };
        assert!(graph(&gif_plan(&narrow, &src(), "o.gif").unwrap()).contains("scale=192:-2"));
        let long = Src { duration_ms: 120_000, ..src() };
        assert!(gif_plan(&Edit { gif: GifEdit { width: 480, fps: 10 }, ..Default::default() }, &long, "o.gif").is_err());
        // At double speed a 40 s span fits.
        let fast = Edit { speed: 2.0, end_ms: 40_000, gif: GifEdit { width: 480, fps: 10 }, ..Default::default() };
        assert!(gif_plan(&fast, &long, "o.gif").is_ok());
    }

    #[test]
    fn a_gif_from_hdr_is_tone_mapped() {
        let edit = Edit { gif: GifEdit { width: 480, fps: 10 }, ..Default::default() };
        let g = graph(&gif_plan(&edit, &hdr_src("hlg"), "o.gif").unwrap());
        assert!(g.starts_with(&format!("[0:v:0]{}", ff::TONE_MAP)), "{g}");
    }

    #[test]
    fn a_frame_seeks_to_the_moment_and_takes_the_look_with_it() {
        let edit = Edit { kind: "frame".into(), src: "in.mp4".into(), frame_ms: 4_250, rotate: 180, filter: "sepia".into(), ..Default::default() };
        let plan = frame_plan(&edit, &src(), "o.jpg").unwrap();
        assert_eq!(arg_after(&plan.args, "-ss"), "4.250");
        let vf = arg_after(&plan.args, "-vf");
        assert!(vf.starts_with("hflip,vflip,colorchannelmixer") && vf.ends_with("format=yuvj420p"), "{vf}");
        assert!(plan.args.windows(2).any(|w| w == ["-frames:v", "1"]));
        assert!(frame_plan(&Edit { frame_ms: 99_000, ..edit }, &src(), "o.jpg").is_err());
    }

    #[test]
    fn the_strip_seeks_each_frame_on_its_own_and_joins_them() {
        let times = strip_times(10_000, 4);
        assert_eq!(times, vec![1.25, 3.75, 6.25, 8.75]);
        let args = strip_args("in.mp4", &times, 64, false);
        assert_eq!(args.iter().filter(|a| *a == "-ss").count(), 4);
        let g = arg_after(&args, "-filter_complex");
        assert!(g.contains("[0:v:0]scale=-2:64,format=yuvj420p[t0]") && g.ends_with("[t0][t1][t2][t3]hstack=inputs=4[o]"), "{g}");
        assert!(strip_args("in.mp4", &[1.0], 64, false).iter().any(|a| a.ends_with("[t0]null[o]")));
        assert!(arg_after(&strip_args("in.mp4", &times, 64, true), "-filter_complex").contains("zscale"));
        // The last moment stays off the very end, and an empty video still names a moment.
        assert_eq!(strip_times(1_000, 1), vec![0.5]);
        assert_eq!(strip_times(0, 3), vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn the_edit_reads_from_json_and_unset_fields_are_neutral() {
        let edit: Edit = serde_json::from_value(json!({
            "kind": "video", "src": "a.mp4", "startMs": 500, "rotate": 90, "flipH": true,
            "crop": { "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.5 },
            "audio": { "fadeInMs": 300, "music": { "path": "m.mp3", "mode": "mix", "looped": true, "volume": 40 } },
            "gif": { "width": 480, "fps": 12 }, "creationMs": 5
        }))
        .unwrap();
        assert_eq!((edit.start_ms, edit.rotate, edit.flip_h), (500, 90, true));
        assert_eq!(edit.audio.fade_in_ms, 300);
        assert_eq!(edit.audio.music.as_ref().map(|m| (m.volume, m.looped)), Some((40, true)));
        assert_eq!(edit.creation_ms, Some(5));
        let bare: Edit = serde_json::from_value(json!({})).unwrap();
        assert!(bare.look_is_neutral());
        assert_eq!(bare.speed(), 1.0);
    }

    #[test]
    fn job_ids_and_names_are_single_safe_components() {
        assert!(valid_job("3f2a-90bc"));
        assert!(!valid_job("") && !valid_job("../x") && !valid_job("a/b") && !valid_job(&"a".repeat(65)));
        assert_eq!(copy_name("clip", "edit", "20261114_101500", 1, "mp4"), "clip_edit_20261114_101500.mp4");
        assert_eq!(copy_name("clip", "gif", "20261114_101500", 3, "gif"), "clip_gif_20261114_101500_3.gif");
    }

    #[test]
    fn a_gif_and_a_frame_are_their_own_thumbnail_and_a_video_gets_one_made() {
        assert!(is_own_thumb("gif"));
        assert!(is_own_thumb("frame"));
        assert!(!is_own_thumb("video"));
    }

    #[test]
    fn a_failed_copy_leaves_no_partial_file_and_a_good_one_keeps_the_capture_time() {
        let dir = std::env::temp_dir().join(format!("pfp-vedit-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("clip_edit.mp4");
        let file = std::fs::File::create(&dest).unwrap();
        assert!(write_copy(&dir.join("missing.mp4"), file, &dest, None).is_err());
        assert!(!dest.exists());

        let src = dir.join("out.mp4");
        std::fs::write(&src, b"video").unwrap();
        let file = std::fs::File::create(&dest).unwrap();
        write_copy(&src, file, &dest, Some(1_600_000_000_000)).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"video");
        let modified = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert_eq!(modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(), 1_600_000_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discarding_takes_only_a_job_folder_inside_the_staging_folder() {
        let base = std::env::temp_dir().join(format!("pfp-vedit-discard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join(STAGING);
        let job = root.join("job-1");
        private_dir(&job).unwrap();
        std::fs::write(job.join("out.mp4"), b"x").unwrap();
        std::fs::write(base.join("keep.mp4"), b"x").unwrap();
        std::fs::write(root.join("loose.mp4"), b"x").unwrap();
        discard_in(&root, &base.join("keep.mp4"));
        discard_in(&root, &root.join("loose.mp4"));
        assert!(base.join("keep.mp4").exists() && root.join("loose.mp4").exists());
        discard_in(&root, &job.join("out.mp4"));
        assert!(!job.exists() && root.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            private_dir(&job).unwrap();
            assert_eq!(std::fs::metadata(&job).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_source_facts_come_from_the_probe() {
        let probe = json!({ "width": 1080, "height": 1920, "fps": 59.94, "durationMs": 12000, "videoBitrate": 9000000,
            "hasAudio": true, "transfer": "hlg", "rotation": 270 });
        let s = Src::from_probe(&probe);
        assert_eq!((s.width, s.height, s.rotation, s.has_audio), (1080, 1920, 270, true));
        assert_eq!(s.upright(), (1920, 1080));
        assert!(s.is_hdr());
    }

    /// Against a real video, named in `PFP_TEST_VIDEO`: runs the plans through the app's ffmpeg and
    /// reads the results back. Ignored by default, as it needs the binaries and a few seconds.
    #[test]
    #[ignore]
    fn plans_run_against_a_real_video() {
        let Ok(path) = std::env::var("PFP_TEST_VIDEO") else { return };
        let probe = crate::video_compress::probe(&path).expect("probe");
        let src = Src::from_probe(&probe);
        let dir = std::env::temp_dir().join("pfp-vedit-test");
        let _ = std::fs::create_dir_all(&dir);
        let out = |name: &str| dir.join(name).to_string_lossy().into_owned();
        let found = ff::encoders();
        let base = Edit { src: path.clone(), start_ms: 500, end_ms: 3_500, ..Default::default() };
        let music_path = std::env::var("PFP_TEST_MUSIC").ok();
        let cases: Vec<(&str, Edit)> = vec![
            ("plain", base.clone()),
            (
                "everything",
                Edit {
                    rotate: 90,
                    flip_h: true,
                    crop: Some(Crop { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }),
                    filter: "warm".into(),
                    brightness: 10,
                    contrast: 10,
                    saturation: 10,
                    speed: 1.5,
                    creation_ms: Some(1_700_000_000_000),
                    audio: AudioEdit {
                        volume: 120,
                        fade_in_ms: 500,
                        fade_out_ms: 500,
                        music: music_path.clone().map(|p| Music { path: p, volume: 50, mode: "mix".into(), looped: true }),
                        ..Default::default()
                    },
                    ..base.clone()
                },
            ),
        ];
        for (name, edit) in cases {
            let enc = choose_encoding(&edit, &src, found.avc.as_ref(), found.hevc.as_ref(), found.hevc_hdr).unwrap();
            let dst = out(&format!("{name}.mp4"));
            let plan = video_plan(&edit, &src, &enc, &dst).unwrap();
            crate::video_compress::run_ffmpeg(&plan.args, plan.out_ms * 1000, &dst, &AtomicBool::new(false), &|_| {})
                .unwrap_or_else(|e| panic!("{name}: {e}\n{:?}", plan.args));
            println!("{name}: {}", crate::video_compress::probe(&dst).unwrap());
        }
        let gif = Edit { gif: GifEdit { width: 320, fps: 10 }, ..base.clone() };
        let dst = out("clip.gif");
        let plan = gif_plan(&gif, &src, &dst).unwrap();
        crate::video_compress::run_ffmpeg(&plan.args, plan.out_ms * 1000, &dst, &AtomicBool::new(false), &|_| {})
            .unwrap_or_else(|e| panic!("gif: {e}\n{:?}", plan.args));
        println!("gif bytes: {}", std::fs::metadata(&dst).unwrap().len());
        let frame = Edit { frame_ms: 1_000, ..base };
        let dst = out("frame.jpg");
        let plan = frame_plan(&frame, &src, &dst).unwrap();
        crate::video_compress::run_ffmpeg(&plan.args, 0, &dst, &AtomicBool::new(false), &|_| {})
            .unwrap_or_else(|e| panic!("frame: {e}\n{:?}", plan.args));
        let strip = ff::command("ffmpeg").args(strip_args(&path, &strip_times(src.duration_ms, 8), 64, src.is_hdr())).output().unwrap();
        assert!(strip.status.success() && strip.stdout.len() > 500, "{}", String::from_utf8_lossy(&strip.stderr));
    }
}
