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

// Videos compressed for upload with the machine's own encoders: on Windows its Media Foundation,
// the same trade `upload_frame` and `local_file` make, on Linux the ffmpeg the Flatpak runtime
// brings (its codecs extension, with VA-API and NVENC for the graphics card and x264 besides).
// No codec ships in this app, and a machine that cannot do it uploads the original. The sidecar
// decides what to make (`compression.ts`); this reads a video for that decision and writes what
// was decided.
//
// The sidecar asks for these on its own: a line on its stdout with a `call` and a `callId`,
// which the reader in `spawn_sidecar` hands to `dispatch`. The work runs on a thread of its own,
// and the answer, with any progress before it, goes back to that same sidecar as a line on its
// stdin; a sidecar started since is never answered for one that is gone.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// The calls still running, by the sidecar generation that made them and their id, with the flag
/// a cancel sets. The generation is part of the key because a restarted sidecar numbers its calls
/// from 1 again: a call of the old one finishing must not drop, or a cancel reach, a new one's.
fn running() -> &'static Mutex<HashMap<(u64, u64), Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<(u64, u64), Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn track(key: (u64, u64)) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    running().lock().unwrap().insert(key, Arc::clone(&cancel));
    cancel
}

fn untrack(key: (u64, u64)) {
    running().lock().unwrap().remove(&key);
}

fn cancel_call(key: (u64, u64)) {
    if let Some(flag) = running().lock().unwrap().get(&key) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Hands one call of the sidecar's to a thread of its own, or stops one it gave up on.
pub(crate) fn dispatch(app: &AppHandle, generation: u64, method: &str, call_id: u64, params: Value) {
    let key = (generation, call_id);
    if method == "cancel" {
        cancel_call(key);
        return;
    }
    let cancel = track(key);
    let app = app.clone();
    let method = method.to_string();
    std::thread::spawn(move || {
        let progress = |value: f64| {
            post(&app, generation, &json!({ "hostProgress": call_id, "value": value }));
        };
        let result = match method.as_str() {
            "videoEncoders" => Ok(serde_json::to_value(encoders()).unwrap_or(Value::Null)),
            "videoProbe" => probe(params.get("path").and_then(Value::as_str).unwrap_or("")),
            "videoTranscode" => transcode(&params, &cancel, &progress).map(|_| Value::Null),
            "powerState" => Ok(crate::keep_all::power_state()),
            other => Err(format!("unknown call: {other}")),
        };
        untrack(key);
        let line = match result {
            Ok(value) => json!({ "hostReply": call_id, "ok": true, "result": value }),
            Err(error) => json!({ "hostReply": call_id, "ok": false, "error": error }),
        };
        post(&app, generation, &line);
    });
}

/// One line to the sidecar of `generation`, if it is still the one running.
fn post(app: &AppHandle, generation: u64, value: &Value) {
    let Ok(mut line) = serde_json::to_string(value) else { return };
    line.push('\n');
    let shared = app.state::<crate::SharedSidecar>().inner().clone();
    shared.post(generation, &line);
}

/// The encoders this PC has for each codec a compressed video can be written in: H.264 in any
/// form (Windows has its own), H.265 and AV1 only in hardware, as the phone asks of them.
#[derive(serde::Serialize, Clone, Copy, Default, Debug)]
pub struct Encoders {
    pub avc: bool,
    pub hevc: bool,
    pub av1: bool,
}

/// Read once: drivers do not come and go while the app runs.
pub fn encoders() -> Encoders {
    static FOUND: OnceLock<Encoders> = OnceLock::new();
    *FOUND.get_or_init(find_encoders)
}

#[cfg(windows)]
fn find_encoders() -> Encoders {
    use windows::Win32::Media::MediaFoundation::{
        MFTEnumEx, MFMediaType_Video, MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG, MFT_ENUM_FLAG_ASYNCMFT,
        MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_ENUM_FLAG_SYNCMFT, MFT_REGISTER_TYPE_INFO,
        MFVideoFormat_AV1, MFVideoFormat_H264, MFVideoFormat_HEVC,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let has = |subtype: windows::core::GUID, flags: MFT_ENUM_FLAG| -> bool {
        let info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: subtype };
        let mut list = std::ptr::null_mut();
        let mut count = 0u32;
        let found = unsafe {
            MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, flags | MFT_ENUM_FLAG_SORTANDFILTER, None, Some(&info), &mut list, &mut count)
        };
        if found.is_err() || list.is_null() {
            return false;
        }
        unsafe {
            for i in 0..count as usize {
                drop(std::ptr::read(list.add(i)));
            }
            CoTaskMemFree(Some(list as *const _));
        }
        count > 0
    };
    Encoders {
        avc: has(MFVideoFormat_H264, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_HARDWARE),
        hevc: has(MFVideoFormat_HEVC, MFT_ENUM_FLAG_HARDWARE),
        av1: has(MFVideoFormat_AV1, MFT_ENUM_FLAG_HARDWARE),
    }
}

#[cfg(not(windows))]
fn find_encoders() -> Encoders {
    let found = ff::encoders();
    Encoders { avc: found.avc.is_some(), hevc: found.hevc.is_some(), av1: found.av1.is_some() }
}

/// What Windows reads off a video: its frame, rate, length, bitrates, codec, whether it carries
/// an HDR transfer, and how it is turned. The fields `compression.ts` plans from.
#[cfg(windows)]
pub fn probe(path: &str) -> Result<Value, String> {
    use windows::core::{Interface, HSTRING};
    use windows::Foundation::IReference;
    use windows::Media::MediaProperties::MediaEncodingProfile;
    use windows::Storage::StorageFile;
    use windows::Win32::Media::MediaFoundation::MF_MT_TRANSFER_FUNCTION;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let err = |e: windows::core::Error| e.message().to_string();
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path)).and_then(|op| op.get()).map_err(err)?;
    let profile = MediaEncodingProfile::CreateFromFileAsync(&file).and_then(|op| op.get()).map_err(err)?;
    let video = profile.Video().map_err(err)?;
    let rate = video.FrameRate().map_err(err)?;
    let (num, den) = (rate.Numerator().unwrap_or(0), rate.Denominator().unwrap_or(0));
    let fps = if num > 0 && den > 0 { num as f64 / den as f64 } else { 0.0 };
    let codec = match video.Subtype().map(|s| s.to_string().to_ascii_uppercase()).unwrap_or_default().as_str() {
        "H264" | "AVC1" => "avc",
        "HEVC" | "H265" | "HVC1" | "HEV1" => "hevc",
        "AV1" | "AV01" => "av1",
        _ => "other",
    };
    // 15 is SMPTE ST 2084 (PQ) and 16 HLG: the two HDR transfers a camera writes.
    let transfer = video
        .Properties()
        .and_then(|p| p.Lookup(MF_MT_TRANSFER_FUNCTION))
        .and_then(|v| v.cast::<IReference<u32>>())
        .and_then(|r| r.Value())
        .unwrap_or(0);
    let (audio_bitrate, has_audio) = match profile.Audio() {
        Ok(audio) => (audio.Bitrate().unwrap_or(0), true),
        Err(_) => (0, false),
    };
    let props = file.Properties().and_then(|p| p.GetVideoPropertiesAsync()).and_then(|op| op.get()).map_err(err)?;
    let duration_ms = props.Duration().map(|d| d.Duration / 10_000).unwrap_or(0);
    let rotation = props.Orientation().map(|o| o.0).unwrap_or(0);
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Ok(json!({
        "width": video.Width().unwrap_or(0),
        "height": video.Height().unwrap_or(0),
        "fps": fps,
        "durationMs": duration_ms,
        "videoBitrate": video.Bitrate().unwrap_or(0),
        "audioBitrate": audio_bitrate,
        "hasAudio": has_audio,
        "codec": codec,
        "hdr": transfer == 15 || transfer == 16,
        "rotation": rotation,
        "size": size,
    }))
}

#[cfg(not(windows))]
pub fn probe(path: &str) -> Result<Value, String> {
    let size = std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())?;
    let out = std::process::Command::new("ffprobe")
        .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path])
        .output()
        .map_err(|e| format!("ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffprobe: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let read: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(ff::probe_from(&read, size))
}

/// Writes `src` as `dst` at the codec, frame, bitrate and frame rate the sidecar planned, with the
/// source's turn kept, in hardware where the machine has it. Progress goes out from 0 to 1; a
/// cancel stops the transcode and leaves no file behind.
#[cfg(windows)]
fn transcode(params: &Value, cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Foundation::PropertyValue;
    use windows::Media::MediaProperties::{MediaEncodingProfile, VideoEncodingQuality};
    use windows::Media::Transcoding::MediaTranscoder;
    use windows::Storage::StorageFile;
    use windows::Win32::Media::MediaFoundation::MF_MT_VIDEO_ROTATION;
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows_future::{AsyncActionProgressHandler, AsyncStatus};

    let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let number = |key: &str| params.get(key).and_then(Value::as_u64).unwrap_or(0);
    let (src, dst, codec) = (text("src"), text("dst"), text("codec"));
    let (width, height, bitrate) = (number("width") as u32, number("height") as u32, number("bitrate") as u32);
    let fps = params.get("fps").and_then(Value::as_f64).filter(|f| *f > 0.0);
    let rotation = number("rotation") as u32;
    if src.is_empty() || dst.is_empty() || width == 0 || height == 0 || bitrate == 0 {
        return Err("nothing to transcode".into());
    }

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let err = |e: windows::core::Error| e.message().to_string();
    let source = StorageFile::GetFileFromPathAsync(&HSTRING::from(src.as_str())).and_then(|op| op.get()).map_err(err)?;
    // Made empty first and opened as a file: the transcoder writes into it from the start.
    std::fs::File::create(&dst).map_err(|e| e.to_string())?;
    let removed = || {
        let _ = std::fs::remove_file(&dst);
    };
    let target = StorageFile::GetFileFromPathAsync(&HSTRING::from(dst.as_str())).and_then(|op| op.get()).map_err(|e| {
        removed();
        err(e)
    })?;

    let quality = VideoEncodingQuality::HD1080p;
    let profile = match codec.as_str() {
        "hevc" => MediaEncodingProfile::CreateHevc(quality),
        "av1" => MediaEncodingProfile::CreateAv1(quality),
        _ => MediaEncodingProfile::CreateMp4(quality),
    }
    .map_err(err)?;
    let source_profile = MediaEncodingProfile::CreateFromFileAsync(&source).and_then(|op| op.get()).map_err(err)?;
    // Set and handed back whole, as some profiles give out a copy of their video properties. An
    // AV1 encoder may still write a size of its own: the sidecar reads the copy back and checks.
    let video = profile.Video().map_err(err)?;
    video.SetWidth(width).map_err(err)?;
    video.SetHeight(height).map_err(err)?;
    video.SetBitrate(bitrate).map_err(err)?;
    let rate = video.FrameRate().map_err(err)?;
    match fps {
        Some(f) => {
            rate.SetNumerator((f * 1000.0).round() as u32).map_err(err)?;
            rate.SetDenominator(1000).map_err(err)?;
        }
        None => {
            // The source's own rate, exactly as it gives it.
            let from = source_profile.Video().and_then(|v| v.FrameRate()).map_err(err)?;
            rate.SetNumerator(from.Numerator().map_err(err)?).map_err(err)?;
            rate.SetDenominator(from.Denominator().map_err(err)?.max(1)).map_err(err)?;
        }
    }
    let aspect = video.PixelAspectRatio().map_err(err)?;
    aspect.SetNumerator(1).map_err(err)?;
    aspect.SetDenominator(1).map_err(err)?;
    if rotation != 0 {
        // A phone films upright as a turned frame: the turn is kept as the source had it.
        let value = PropertyValue::CreateUInt32(rotation).map_err(err)?;
        video.Properties().and_then(|p| p.Insert(MF_MT_VIDEO_ROTATION, &value)).map_err(err)?;
    }
    profile.SetVideo(&video).map_err(err)?;
    if source_profile.Audio().is_err() {
        profile.SetAudio(None).map_err(err)?;
    }

    let transcoder = MediaTranscoder::new().map_err(err)?;
    transcoder.SetHardwareAccelerationEnabled(true).map_err(err)?;
    let prepared = transcoder
        .PrepareFileTranscodeAsync(&source, &target, &profile)
        .and_then(|op| op.get())
        .map_err(|e| {
            removed();
            err(e)
        })?;
    if !prepared.CanTranscode().unwrap_or(false) {
        removed();
        return Err(format!("Windows cannot transcode it ({:?})", prepared.FailureReason().map(|r| r.0).unwrap_or(-1)));
    }
    let op = prepared.TranscodeAsync().map_err(err)?;
    // Windows reports on a thread of its own; the share done is kept here and passed on from the
    // loop below, a hundredth at a time.
    let done = Arc::new(std::sync::atomic::AtomicU64::new(0f64.to_bits()));
    let seen = Arc::clone(&done);
    let handler = AsyncActionProgressHandler::new(move |_, value: windows_core::Ref<'_, f64>| {
        seen.store((*value / 100.0).clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
        Ok(())
    });
    op.SetProgress(&handler).map_err(err)?;
    let mut told = -1.0f64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = op.Cancel();
            std::thread::sleep(std::time::Duration::from_millis(200));
            removed();
            return Err("cancelled".into());
        }
        let now = f64::from_bits(done.load(Ordering::Relaxed));
        if now - told >= 0.01 {
            told = now;
            progress(now);
        }
        match op.Status().map_err(err)? {
            AsyncStatus::Started => std::thread::sleep(std::time::Duration::from_millis(200)),
            AsyncStatus::Completed => return Ok(()),
            _ => {
                let failed = op.GetResults().err().map(err).unwrap_or_else(|| "the transcode stopped".into());
                removed();
                return Err(failed);
            }
        }
    }
}

#[cfg(not(windows))]
fn transcode(params: &Value, cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<(), String> {
    use std::io::{BufRead, Read};
    use std::process::{Command, Stdio};

    let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let number = |key: &str| params.get(key).and_then(Value::as_u64).unwrap_or(0);
    let (src, dst, codec) = (text("src"), text("dst"), text("codec"));
    let (width, height, bitrate) = (number("width"), number("height"), number("bitrate"));
    let fps = params.get("fps").and_then(Value::as_f64).filter(|f| *f > 0.0);
    if src.is_empty() || dst.is_empty() || width == 0 || height == 0 || bitrate == 0 {
        return Err("nothing to transcode".into());
    }
    let found = ff::encoders();
    let encoder = match codec.as_str() {
        "hevc" => found.hevc.as_ref(),
        "av1" => found.av1.as_ref(),
        _ => found.avc.as_ref(),
    }
    .ok_or_else(|| format!("no {codec} encoder here"))?;
    let duration_us = probe(&src).ok().and_then(|p| p["durationMs"].as_u64()).unwrap_or(0) * 1000;

    let args = ff::transcode_args(&ff::Job { src: &src, dst: &dst, encoder, width, height, bitrate, fps });
    let mut child = Command::new("ffmpeg")
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let removed = || {
        let _ = std::fs::remove_file(&dst);
    };
    // ffmpeg reports how far it got on stdout, a key=value line at a time; the share done is kept
    // here and passed on from the loop below, a hundredth at a time.
    let done = Arc::new(std::sync::atomic::AtomicU64::new(0f64.to_bits()));
    let seen = Arc::clone(&done);
    let stdout = child.stdout.take();
    std::thread::spawn(move || {
        let Some(stdout) = stdout else { return };
        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<u64>().ok()) {
                if duration_us > 0 {
                    seen.store((us as f64 / duration_us as f64).clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
                }
            }
        }
    });
    let mut stderr = child.stderr.take();
    let mut told = -1.0f64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            removed();
            return Err("cancelled".into());
        }
        let now = f64::from_bits(done.load(Ordering::Relaxed));
        if now - told >= 0.01 {
            told = now;
            progress(now);
        }
        match child.try_wait().map_err(|e| e.to_string())? {
            None => std::thread::sleep(std::time::Duration::from_millis(200)),
            Some(status) if status.success() => {
                progress(1.0);
                return Ok(());
            }
            Some(status) => {
                let mut said = String::new();
                if let Some(err) = stderr.as_mut() {
                    let _ = err.read_to_string(&mut said);
                }
                removed();
                let last = said.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
                return Err(format!("ffmpeg stopped ({status}): {last}"));
            }
        }
    }
}

/// The ffmpeg side of Linux: which encoder writes each codec here, what a probe reads, and the
/// command a transcode runs. The parts that only read and build are kept apart, so they are
/// tested on every platform.
#[cfg(any(not(windows), test))]
mod ff {
    use serde_json::{json, Value};

    /// One ffmpeg encoder, and the VA-API device its frames are uploaded to when it is one of those.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Encoder {
        pub name: String,
        pub vaapi: Option<String>,
    }

    /// The encoder for each codec, None where this machine has none that works.
    #[cfg(not(windows))]
    #[derive(Clone, Debug, Default)]
    pub struct Found {
        pub avc: Option<Encoder>,
        pub hevc: Option<Encoder>,
        pub av1: Option<Encoder>,
    }

    /// The candidates for one codec, best first: the graphics card through VA-API (Intel, AMD) and
    /// NVENC (NVIDIA), then for H.264 alone x264, as Windows offers H.265 and AV1 only in hardware.
    pub fn candidates(codec: &str, render_device: Option<&str>) -> Vec<Encoder> {
        let base = match codec {
            "hevc" => "hevc",
            "av1" => "av1",
            _ => "h264",
        };
        let mut out = Vec::new();
        if let Some(device) = render_device {
            out.push(Encoder { name: format!("{base}_vaapi"), vaapi: Some(device.to_string()) });
        }
        out.push(Encoder { name: format!("{base}_nvenc"), vaapi: None });
        if base == "h264" {
            out.push(Encoder { name: "libx264".into(), vaapi: None });
        }
        out
    }

    /// Everything a transcode needs to know.
    pub struct Job<'a> {
        pub src: &'a str,
        pub dst: &'a str,
        pub encoder: &'a Encoder,
        pub width: u64,
        pub height: u64,
        pub bitrate: u64,
        pub fps: Option<f64>,
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// The ffmpeg arguments for `job`. The source's turn is not applied to the pixels
    /// (`-noautorotate`): its display matrix goes over to the copy, so the copy has the frame the
    /// sidecar planned and the same turn, as the Windows transcoder writes it.
    pub fn transcode_args(job: &Job) -> Vec<String> {
        let mut a = strings(&["-hide_banner", "-loglevel", "error", "-nostats", "-y", "-noautorotate"]);
        if let Some(device) = &job.encoder.vaapi {
            a.extend(["-vaapi_device".to_string(), device.clone()]);
        }
        a.extend(["-i".to_string(), job.src.to_string()]);
        a.extend(strings(&["-map", "0:v:0", "-map", "0:a:0?"]));
        let scale = format!("scale={}:{}", job.width, job.height);
        let filter = if job.encoder.vaapi.is_some() { format!("{scale},format=nv12,hwupload") } else { scale };
        a.extend(["-vf".to_string(), filter, "-c:v".to_string(), job.encoder.name.clone()]);
        a.extend(["-b:v".to_string(), job.bitrate.to_string()]);
        a.extend(["-maxrate".to_string(), (job.bitrate * 3 / 2).to_string()]);
        a.extend(["-bufsize".to_string(), (job.bitrate * 2).to_string()]);
        if job.encoder.vaapi.is_none() {
            a.extend(strings(&["-pix_fmt", "yuv420p"]));
        }
        if job.encoder.name == "libx264" {
            a.extend(strings(&["-preset", "medium"]));
        }
        if job.encoder.name.starts_with("hevc") {
            // The tag Apple's players and the browsers look for.
            a.extend(strings(&["-tag:v", "hvc1"]));
        }
        if let Some(fps) = job.fps {
            a.extend(["-r".to_string(), format!("{fps:.3}")]);
        }
        a.extend(strings(&["-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-progress", "pipe:1"]));
        a.push(job.dst.to_string());
        a
    }

    /// The arguments that try `encoder` on a few frames of a test picture, to see it works here.
    pub fn trial_args(encoder: &Encoder) -> Vec<String> {
        let mut a = strings(&["-hide_banner", "-loglevel", "error", "-nostats"]);
        if let Some(device) = &encoder.vaapi {
            a.extend(["-vaapi_device".to_string(), device.clone()]);
        }
        a.extend(strings(&["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=0.3"]));
        if encoder.vaapi.is_some() {
            a.extend(strings(&["-vf", "format=nv12,hwupload"]));
        } else {
            a.extend(strings(&["-pix_fmt", "yuv420p"]));
        }
        a.extend(["-c:v".to_string(), encoder.name.clone()]);
        a.extend(strings(&["-b:v", "1000000", "-f", "null", "-"]));
        a
    }

    fn number(v: Option<&Value>) -> Option<f64> {
        match v? {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        }
    }

    fn rate(v: Option<&Value>) -> f64 {
        let Some(text) = v.and_then(Value::as_str) else { return 0.0 };
        let mut parts = text.splitn(2, '/');
        let num: f64 = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0.0);
        let den: f64 = parts.next().and_then(|d| d.parse().ok()).unwrap_or(1.0);
        if num > 0.0 && den > 0.0 {
            num / den
        } else {
            0.0
        }
    }

    /// What `ffprobe -show_format -show_streams` says of a video, in the fields the Windows probe
    /// gives: frame, rate, length, bitrates, codec, an HDR transfer, and the turn.
    pub fn probe_from(read: &Value, size: u64) -> Value {
        let empty = Vec::new();
        let streams = read["streams"].as_array().unwrap_or(&empty);
        let video = streams.iter().find(|s| s["codec_type"] == "video");
        let audio = streams.iter().find(|s| s["codec_type"] == "audio");
        let Some(video) = video else {
            return json!({ "width": 0, "height": 0, "fps": 0.0, "durationMs": 0, "videoBitrate": 0, "audioBitrate": 0,
                "hasAudio": audio.is_some(), "codec": "other", "hdr": false, "rotation": 0, "size": size });
        };
        let fps = match rate(video.get("avg_frame_rate")) {
            f if f > 0.0 => f,
            _ => rate(video.get("r_frame_rate")),
        };
        let seconds = number(read["format"].get("duration")).or_else(|| number(video.get("duration"))).unwrap_or(0.0);
        let codec = match video["codec_name"].as_str().unwrap_or("") {
            "h264" => "avc",
            "hevc" => "hevc",
            "av1" => "av1",
            _ => "other",
        };
        let transfer = video["color_transfer"].as_str().unwrap_or("");
        let rotation = video["side_data_list"]
            .as_array()
            .and_then(|list| list.iter().find_map(|d| number(d.get("rotation"))))
            .map(|r| (r.round() as i64).rem_euclid(360))
            .unwrap_or(0);
        json!({
            "width": video["width"].as_u64().unwrap_or(0),
            "height": video["height"].as_u64().unwrap_or(0),
            "fps": fps,
            "durationMs": (seconds * 1000.0).round() as u64,
            "videoBitrate": number(video.get("bit_rate")).unwrap_or(0.0) as u64,
            "audioBitrate": audio.and_then(|a| number(a.get("bit_rate"))).unwrap_or(0.0) as u64,
            "hasAudio": audio.is_some(),
            "codec": codec,
            "hdr": transfer == "smpte2084" || transfer == "arib-std-b67",
            "rotation": rotation,
            "size": size,
        })
    }

    /// The first render node of the graphics card, the device VA-API encodes on.
    #[cfg(not(windows))]
    fn render_device() -> Option<String> {
        let mut nodes: Vec<String> = std::fs::read_dir("/dev/dri")
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .filter(|n| n.starts_with("renderD"))
            .collect();
        nodes.sort();
        nodes.first().map(|n| format!("/dev/dri/{n}"))
    }

    /// Whether `encoder` writes a few frames here within a few seconds.
    #[cfg(not(windows))]
    fn works(encoder: &Encoder) -> bool {
        use std::process::{Command, Stdio};
        let Ok(mut child) = Command::new("ffmpeg")
            .args(trial_args(encoder))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if started.elapsed() < std::time::Duration::from_secs(10) => {
                    std::thread::sleep(std::time::Duration::from_millis(50))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    }

    /// Tried once: drivers do not come and go while the app runs.
    #[cfg(not(windows))]
    pub fn encoders() -> &'static Found {
        static FOUND: std::sync::OnceLock<Found> = std::sync::OnceLock::new();
        FOUND.get_or_init(|| {
            let device = render_device();
            let pick = |codec: &str| candidates(codec, device.as_deref()).into_iter().find(works);
            Found { avc: pick("avc"), hevc: pick("hevc"), av1: pick("av1") }
        })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Against a real video, named in `PFP_TEST_VIDEO`: reads it, writes it at 720p H.264, and
    /// reads the copy back. Ignored by default, as it needs a file and a few seconds.
    #[test]
    #[ignore]
    fn probes_and_transcodes_a_real_video() {
        let Ok(src) = std::env::var("PFP_TEST_VIDEO") else { return };
        println!("encoders: {:?}", encoders());
        let info = probe(&src).expect("probe");
        println!("source: {info}");
        let (w, h) = (info["width"].as_u64().unwrap(), info["height"].as_u64().unwrap());
        let short = w.min(h) as f64;
        let target: f64 = std::env::var("PFP_TEST_SHORT").ok().and_then(|v| v.parse().ok()).unwrap_or(720.0);
        let scale = if short > target { target / short } else { 1.0 };
        let even = |v: f64| ((v / 2.0).round() * 2.0) as u64;
        let dst = std::env::temp_dir().join("pfp-transcode-test.mp4");
        let params = json!({
            "src": src,
            "dst": dst.to_string_lossy(),
            "codec": std::env::var("PFP_TEST_CODEC").unwrap_or_else(|_| "avc".into()),
            "width": even(w as f64 * scale),
            "height": even(h as f64 * scale),
            "bitrate": 2_000_000,
            "fps": 30.0,
            "rotation": info["rotation"].as_u64().unwrap_or(0),
        });
        let started = std::time::Instant::now();
        transcode(&params, &AtomicBool::new(false), &|p| print!("{:.0}% ", p * 100.0)).expect("transcode");
        println!("\ntook {:?}", started.elapsed());
        let out = probe(&dst.to_string_lossy()).expect("probe copy");
        println!("copy: {out}");
        assert!(out["size"].as_u64().unwrap() > 0);
    }
}

#[cfg(test)]
mod ff_tests {
    use super::ff::*;
    use serde_json::json;

    #[test]
    fn hardware_comes_first_and_only_h264_falls_back_to_software() {
        let names =
            |codec| candidates(codec, Some("/dev/dri/renderD128")).into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names("avc"), ["h264_vaapi", "h264_nvenc", "libx264"]);
        assert_eq!(names("hevc"), ["hevc_vaapi", "hevc_nvenc"]);
        assert_eq!(names("av1"), ["av1_vaapi", "av1_nvenc"]);
        assert_eq!(candidates("avc", None).len(), 2, "no VA-API without a render node");
    }

    #[test]
    fn a_probe_reads_frame_rate_length_codec_hdr_and_turn() {
        let read = json!({
            "streams": [
                { "codec_type": "video", "codec_name": "hevc", "width": 3840, "height": 2160,
                  "avg_frame_rate": "30000/1001", "r_frame_rate": "30/1", "bit_rate": "40000000",
                  "color_transfer": "arib-std-b67", "side_data_list": [{ "side_data_type": "Display Matrix", "rotation": -90 }] },
                { "codec_type": "audio", "codec_name": "aac", "bit_rate": "192000" }
            ],
            "format": { "duration": "12.345" }
        });
        let p = probe_from(&read, 99);
        assert_eq!(p["width"], 3840);
        assert_eq!(p["height"], 2160);
        assert!((p["fps"].as_f64().unwrap() - 29.97).abs() < 0.01);
        assert_eq!(p["durationMs"], 12345);
        assert_eq!(p["videoBitrate"], 40_000_000);
        assert_eq!(p["audioBitrate"], 192_000);
        assert_eq!(p["hasAudio"], true);
        assert_eq!(p["codec"], "hevc");
        assert_eq!(p["hdr"], true);
        assert_eq!(p["rotation"], 270);
        assert_eq!(p["size"], 99);
    }

    #[test]
    fn a_probe_of_a_file_without_video_reads_as_unreadable() {
        let p = probe_from(&json!({ "streams": [{ "codec_type": "audio" }], "format": {} }), 5);
        assert_eq!(p["width"], 0);
        assert_eq!(p["durationMs"], 0);
    }

    #[test]
    fn a_transcode_keeps_the_turn_scales_and_writes_the_planned_bitrate() {
        let enc = Encoder { name: "libx264".into(), vaapi: None };
        let job = Job { src: "/a.mov", dst: "/b.mp4", encoder: &enc, width: 1280, height: 720, bitrate: 3_000_000, fps: Some(30.0) };
        let a = transcode_args(&job).join(" ");
        assert!(a.contains("-noautorotate -i /a.mov"), "{a}");
        assert!(a.contains("-map 0:v:0 -map 0:a:0?"), "{a}");
        assert!(a.contains("-vf scale=1280:720 -c:v libx264 -b:v 3000000"), "{a}");
        assert!(a.contains("-pix_fmt yuv420p"), "{a}");
        assert!(a.contains("-r 30.000"), "{a}");
        assert!(a.ends_with("-progress pipe:1 /b.mp4"), "{a}");
    }

    #[test]
    fn a_vaapi_transcode_uploads_its_frames_to_the_card() {
        let enc = Encoder { name: "hevc_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) };
        let job = Job { src: "s", dst: "d", encoder: &enc, width: 1920, height: 1080, bitrate: 1, fps: None };
        let a = transcode_args(&job).join(" ");
        assert!(a.contains("-vaapi_device /dev/dri/renderD128 -i s"), "{a}");
        assert!(a.contains("-vf scale=1920:1080,format=nv12,hwupload -c:v hevc_vaapi"), "{a}");
        assert!(a.contains("-tag:v hvc1"), "{a}");
        assert!(!a.contains("-pix_fmt"), "{a}");
        assert!(!a.contains(" -r "), "{a}");
    }

    #[test]
    fn an_encoder_is_tried_on_a_test_picture() {
        let a = trial_args(&Encoder { name: "h264_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) }).join(" ");
        assert!(a.contains("-vaapi_device /dev/dri/renderD128 -f lavfi"), "{a}");
        assert!(a.ends_with("-c:v h264_vaapi -b:v 1000000 -f null -"), "{a}");
    }
}

#[cfg(test)]
mod running_tests {
    use super::*;

    #[test]
    fn a_restarted_sidecars_call_is_not_touched_by_the_old_ones_with_the_same_id() {
        let old = track((9001, 5));
        let new = track((9002, 5));
        untrack((9001, 5));
        assert!(running().lock().unwrap().contains_key(&(9002, 5)), "the new call stays tracked");
        cancel_call((9001, 5));
        assert!(!new.load(Ordering::SeqCst), "a cancel for the old one does not reach the new one");
        cancel_call((9002, 5));
        assert!(new.load(Ordering::SeqCst));
        assert!(!old.load(Ordering::SeqCst));
        untrack((9002, 5));
    }
}
