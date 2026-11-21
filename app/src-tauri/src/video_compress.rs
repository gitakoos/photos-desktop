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

// Videos compressed for upload with the app's own ffmpeg, the same build on Windows and Linux
// (ffmpeg/build.sh), so both write the same copy: on the graphics card where it has an encoder,
// with x264 on the processor for H.264 otherwise. The macOS build of it encodes with
// VideoToolbox, the encoder macOS carries for the Mac's own graphics hardware. A machine where
// nothing works uploads the original. The sidecar decides what to make (`compression.ts`); this reads a video for that
// decision and writes what was decided.
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
            #[cfg(target_os = "linux")]
            "keepDropOriginal" => {
                crate::files_drive::keep_original(params.get("path").and_then(Value::as_str).unwrap_or(""))
            }
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

/// The encoders this machine has for each codec a compressed video can be written in: H.264 on
/// the graphics card or with x264, H.265 and AV1 only on the card, as the phone asks of them.
/// `hevcHdr` and `av1Hdr`: that encoder also writes 10 bits, so an HDR video keeps its HDR.
#[derive(serde::Serialize, Clone, Copy, Default, Debug)]
pub struct Encoders {
    pub avc: bool,
    pub hevc: bool,
    pub av1: bool,
    #[serde(rename = "hevcHdr")]
    pub hevc_hdr: bool,
    #[serde(rename = "av1Hdr")]
    pub av1_hdr: bool,
}

pub fn encoders() -> Encoders {
    let found = ff::encoders();
    Encoders {
        avc: found.avc.is_some(),
        hevc: found.hevc.is_some(),
        av1: found.av1.is_some(),
        hevc_hdr: found.hevc_hdr,
        av1_hdr: found.av1_hdr,
    }
}

/// What ffprobe reads off a video: its frame, rate, length, bitrates, codec, its colour (the HDR
/// curve, the primaries, the bit depth, a Dolby Vision stream without a picture other players
/// show right), and how it is turned. The fields `compression.ts` plans from.
pub fn probe(path: &str) -> Result<Value, String> {
    let size = std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())?;
    let out = ff::command("ffprobe")
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
/// source's turn kept, on the graphics card where the machine has one. An HDR source keeps its
/// HDR (`hdr` "keep", with its `transfer`) or is tone-mapped to SDR (`hdr` "tone-map"). Progress
/// goes out from 0 to 1; a cancel stops the transcode and leaves no file behind.
fn transcode(params: &Value, cancel: &AtomicBool, progress: &dyn Fn(f64)) -> Result<(), String> {
    let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let number = |key: &str| params.get(key).and_then(Value::as_u64).unwrap_or(0);
    let (src, dst, codec) = (text("src"), text("dst"), text("codec"));
    let (width, height, bitrate) = (number("width"), number("height"), number("bitrate"));
    let fps = params.get("fps").and_then(Value::as_f64).filter(|f| *f > 0.0);
    if src.is_empty() || dst.is_empty() || width == 0 || height == 0 || bitrate == 0 {
        return Err("nothing to transcode".into());
    }
    let colour = ff::Colour::from_plan(&text("hdr"), &text("transfer"))?;
    let found = ff::encoders();
    let (encoder, keeps_hdr) = match codec.as_str() {
        "hevc" => (found.hevc.as_ref(), found.hevc_hdr),
        "av1" => (found.av1.as_ref(), found.av1_hdr),
        _ => (found.avc.as_ref(), false),
    };
    let encoder = encoder.ok_or_else(|| format!("no {codec} encoder here"))?;
    if colour.keeps_hdr() && !keeps_hdr {
        return Err(format!("the {codec} encoder here does not keep HDR"));
    }
    let duration_us = probe(&src).ok().and_then(|p| p["durationMs"].as_u64()).unwrap_or(0) * 1000;

    let args = ff::transcode_args(&ff::Job { src: &src, dst: &dst, encoder, width, height, bitrate, fps, colour });
    run_ffmpeg(&args, duration_us, &dst, cancel, progress)
}

/// Runs ffmpeg with `args` (which end in `-progress pipe:1` and write `dst`) to its end. Progress
/// goes out from 0 to 1 against `duration_us` of output; a cancel or a failure leaves no `dst`.
pub(crate) fn run_ffmpeg(
    args: &[String],
    duration_us: u64,
    dst: &str,
    cancel: &AtomicBool,
    progress: &dyn Fn(f64),
) -> Result<(), String> {
    use std::io::{BufRead, Read};
    use std::process::Stdio;

    let mut child = ff::command("ffmpeg")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg: {e}"))?;
    let removed = || {
        let _ = std::fs::remove_file(dst);
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

/// The upload's picture of a video or of a HEIC or HEIF still (upload_frame.rs): a JPEG in `dest`,
/// upright, at most `edge` on its longer side, taken `at` seconds in. macOS only, where the
/// app's own ffmpeg draws it; Windows asks the shell and Linux asks GStreamer. A file that holds
/// its decoder longer than twenty seconds gets no picture, so one bad clip cannot stall a drop.
#[cfg(target_os = "macos")]
pub fn picture(src: &std::path::Path, dest: &std::path::Path, edge: u32, at: f64) -> bool {
    let args = ff::picture_args(&src.to_string_lossy(), &dest.to_string_lossy(), edge, at);
    ff::finishes(ff::command("ffmpeg").args(args), std::time::Duration::from_secs(20))
        && std::fs::metadata(dest).is_ok_and(|m| m.len() > 0)
}

/// The app's ffmpeg: where it is, which encoder writes each codec here, what a probe reads, and
/// the command a transcode runs. The parts that only read and build are kept apart, so they are
/// tested on every platform.
pub(crate) mod ff {
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::process::Command;

    /// `ffmpeg` or `ffprobe` as the app carries it: in `resources/ffmpeg` beside the executable
    /// (`Contents/Resources/ffmpeg` in a macOS bundle), or, in a build run from the source, where
    /// ffmpeg/build.sh writes it.
    pub fn tool(name: &str) -> PathBuf {
        let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
        let beside = std::env::current_exe().ok().and_then(|exe| {
            exe.parent().map(|dir| {
                // A macOS bundle keeps its resources in `Contents/Resources`, beside `Contents/MacOS`.
                let resources = if cfg!(target_os = "macos") { dir.join("..").join("Resources") } else { dir.join("resources") };
                resources.join("ffmpeg").join(&file)
            })
        });
        if let Some(path) = beside.filter(|p| p.exists()) {
            return path;
        }
        let target = if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        };
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("ffmpeg-{target}")).join(file)
    }

    /// A command for `ffmpeg` or `ffprobe`, with no console window of its own on Windows.
    pub fn command(name: &str) -> Command {
        #[allow(unused_mut)]
        let mut command = Command::new(tool(name));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command
    }

    /// One ffmpeg encoder, and the VA-API device its frames are uploaded to when it is one of those.
    #[derive(Clone, Debug, PartialEq)]
    pub struct Encoder {
        pub name: String,
        pub vaapi: Option<String>,
    }

    /// The encoder for each codec, None where this machine has none that works, and whether the
    /// H.265 and AV1 ones also write 10 bits.
    #[derive(Clone, Debug, Default)]
    pub struct Found {
        pub avc: Option<Encoder>,
        pub hevc: Option<Encoder>,
        pub av1: Option<Encoder>,
        pub hevc_hdr: bool,
        pub av1_hdr: bool,
    }

    /// What a transcode does with the colour: an SDR video is written as it is, an HDR one keeps
    /// its HDR (10 bits, BT.2020, its PQ or HLG curve) or is tone-mapped to SDR.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum Colour {
        Sdr,
        KeepPq,
        KeepHlg,
        ToSdr,
    }

    impl Colour {
        /// From the sidecar's plan: `hdr` "keep" with the source's `transfer`, or "tone-map".
        pub fn from_plan(hdr: &str, transfer: &str) -> Result<Colour, String> {
            match (hdr, transfer) {
                ("keep", "pq") => Ok(Colour::KeepPq),
                ("keep", "hlg") => Ok(Colour::KeepHlg),
                ("keep", other) => Err(format!("no HDR curve to keep: {other:?}")),
                ("tone-map", _) => Ok(Colour::ToSdr),
                _ => Ok(Colour::Sdr),
            }
        }

        pub fn keeps_hdr(self) -> bool {
            matches!(self, Colour::KeepPq | Colour::KeepHlg)
        }
    }

    /// HDR to SDR: to linear light, to the BT.709 primaries, the highlights rolled off (Hable, the
    /// colours kept), then the BT.709 curve and matrix at TV range, as 8-bit 4:2:0.
    pub const TONE_MAP: &str =
        "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p";

    /// The system the encoders are picked for, named apart so every system's list is tested on
    /// any machine.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub enum System {
        Windows,
        Linux,
        MacOs,
    }

    impl System {
        pub fn current() -> System {
            if cfg!(windows) {
                System::Windows
            } else if cfg!(target_os = "macos") {
                System::MacOs
            } else {
                System::Linux
            }
        }
    }

    /// The candidates for one codec, best first: the graphics card (NVIDIA through NVENC; Intel and
    /// AMD through Quick Sync and AMF on Windows, VA-API on Linux), then for H.264 alone x264. On
    /// macOS only VideoToolbox, which writes H.264 and H.265: the macOS build carries no x264.
    pub fn candidates(codec: &str, render_device: Option<&str>, system: System) -> Vec<Encoder> {
        let base = match codec {
            "hevc" => "hevc",
            "av1" => "av1",
            _ => "h264",
        };
        if system == System::MacOs {
            return match base {
                "av1" => Vec::new(),
                _ => vec![Encoder { name: format!("{base}_videotoolbox"), vaapi: None }],
            };
        }
        let windows = system == System::Windows;
        let mut out = Vec::new();
        if let Some(device) = render_device.filter(|_| !windows) {
            out.push(Encoder { name: format!("{base}_vaapi"), vaapi: Some(device.to_string()) });
        }
        out.push(Encoder { name: format!("{base}_nvenc"), vaapi: None });
        if windows {
            out.push(Encoder { name: format!("{base}_qsv"), vaapi: None });
            out.push(Encoder { name: format!("{base}_amf"), vaapi: None });
        }
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
        pub colour: Colour,
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// The frame layout an encoder takes from memory: Quick Sync and AMF want NV12, and it is the
    /// one VideoToolbox works in.
    pub fn frame_format(encoder: &str) -> &'static str {
        if encoder.ends_with("_qsv") || encoder.ends_with("_amf") || encoder.ends_with("_videotoolbox") {
            "nv12"
        } else {
            "yuv420p"
        }
    }

    /// The frames handed to an encoder that keeps HDR: 10 bits, as P010.
    pub const TEN_BIT: &str = "p010le";

    /// The colour tags a copy carries: BT.2020 with the source's curve when it keeps HDR, BT.709
    /// after a tone map. An SDR source's own tags go over as they are.
    pub fn colour_tags(colour: Colour) -> Vec<String> {
        let (primaries, curve, matrix) = match colour {
            Colour::Sdr => return Vec::new(),
            Colour::KeepPq => ("bt2020", "smpte2084", "bt2020nc"),
            Colour::KeepHlg => ("bt2020", "arib-std-b67", "bt2020nc"),
            Colour::ToSdr => ("bt709", "bt709", "bt709"),
        };
        strings(&["-color_primaries", primaries, "-color_trc", curve, "-colorspace", matrix, "-color_range", "tv"])
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
        let keeps_hdr = job.colour.keeps_hdr();
        let mut filter = format!("scale={}:{}", job.width, job.height);
        if job.colour == Colour::ToSdr {
            filter = format!("{filter},{TONE_MAP}");
        }
        if job.encoder.vaapi.is_some() {
            let frames = if keeps_hdr { TEN_BIT } else { "nv12" };
            filter = format!("{filter},format={frames},hwupload");
        }
        a.extend(["-vf".to_string(), filter, "-c:v".to_string(), job.encoder.name.clone()]);
        a.extend(["-b:v".to_string(), job.bitrate.to_string()]);
        a.extend(["-maxrate".to_string(), (job.bitrate * 3 / 2).to_string()]);
        a.extend(["-bufsize".to_string(), (job.bitrate * 2).to_string()]);
        if job.encoder.vaapi.is_none() {
            let frames = if keeps_hdr { TEN_BIT } else { frame_format(&job.encoder.name) };
            a.extend(["-pix_fmt".to_string(), frames.to_string()]);
        }
        if job.encoder.name == "libx264" {
            a.extend(strings(&["-preset", "medium"]));
        }
        if job.encoder.name.starts_with("hevc") {
            if keeps_hdr {
                a.extend(strings(&["-profile:v", "main10"]));
            }
            // The tag Apple's players and the browsers look for.
            a.extend(strings(&["-tag:v", "hvc1"]));
        }
        a.extend(colour_tags(job.colour));
        if let Some(fps) = job.fps {
            a.extend(["-r".to_string(), format!("{fps:.3}")]);
        }
        a.extend(strings(&["-c:a", "aac", "-b:a", "160k"]));
        // The source's tags (a phone's place, make, model and capture date) go over as QuickTime
        // keys, which an MP4 holds only with `use_metadata_tags`. The brands are the source
        // container's, not the copy's.
        a.extend(strings(&["-metadata", "major_brand=", "-metadata", "minor_version=", "-metadata", "compatible_brands="]));
        a.extend(strings(&["-movflags", "+faststart+use_metadata_tags", "-progress", "pipe:1"]));
        a.push(job.dst.to_string());
        a
    }

    /// The arguments that try `encoder` on a few frames of a test picture, to see it works here;
    /// with `ten_bit`, whether it also writes the 10 bits an HDR copy needs.
    pub fn trial_args(encoder: &Encoder, ten_bit: bool) -> Vec<String> {
        let mut a = strings(&["-hide_banner", "-loglevel", "error", "-nostats"]);
        if let Some(device) = &encoder.vaapi {
            a.extend(["-vaapi_device".to_string(), device.clone()]);
        }
        a.extend(strings(&["-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=0.3"]));
        if encoder.vaapi.is_some() {
            let frames = if ten_bit { TEN_BIT } else { "nv12" };
            a.extend(["-vf".to_string(), format!("format={frames},hwupload")]);
        } else {
            let frames = if ten_bit { TEN_BIT } else { frame_format(&encoder.name) };
            a.extend(["-pix_fmt".to_string(), frames.to_string()]);
        }
        a.extend(["-c:v".to_string(), encoder.name.clone()]);
        if ten_bit && encoder.name.starts_with("hevc") {
            a.extend(strings(&["-profile:v", "main10"]));
        }
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

    /// What `ffprobe -show_format -show_streams` says of a video: frame, rate, length, bitrates,
    /// codec, colour and turn. `transfer` is "pq" (HDR10 and most Dolby Vision), "hlg" or "sdr";
    /// `dolbyVisionOnly` is a Dolby Vision stream with no base picture other players show right
    /// (profile 5), whose colours no transcode here reproduces.
    pub fn probe_from(read: &Value, size: u64) -> Value {
        let empty = Vec::new();
        let streams = read["streams"].as_array().unwrap_or(&empty);
        let video = streams.iter().find(|s| s["codec_type"] == "video");
        let audio = streams.iter().find(|s| s["codec_type"] == "audio");
        let Some(video) = video else {
            return json!({ "width": 0, "height": 0, "fps": 0.0, "durationMs": 0, "videoBitrate": 0, "audioBitrate": 0,
                "hasAudio": audio.is_some(), "codec": "other", "hdr": false, "transfer": "sdr", "primaries": "",
                "bitDepth": 8, "dolbyVisionOnly": false, "rotation": 0, "size": size });
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
        let transfer = match video["color_transfer"].as_str().unwrap_or("") {
            "smpte2084" => "pq",
            "arib-std-b67" => "hlg",
            _ => "sdr",
        };
        let pixels = video["pix_fmt"].as_str().unwrap_or("");
        let bit_depth = number(video.get("bits_per_raw_sample")).map(|b| b as u64).filter(|b| *b > 0).unwrap_or(
            if pixels.contains("12") {
                12
            } else if pixels.contains("10") {
                10
            } else {
                8
            },
        );
        let side = video["side_data_list"].as_array().unwrap_or(&empty);
        let rotation = side
            .iter()
            .find_map(|d| number(d.get("rotation")))
            .map(|r| (r.round() as i64).rem_euclid(360))
            .unwrap_or(0);
        let dolby_vision_only = side.iter().any(|d| {
            d["side_data_type"].as_str().is_some_and(|t| t.starts_with("DOVI"))
                && number(d.get("dv_bl_signal_compatibility_id")) == Some(0.0)
        });
        json!({
            "width": video["width"].as_u64().unwrap_or(0),
            "height": video["height"].as_u64().unwrap_or(0),
            "fps": fps,
            "durationMs": (seconds * 1000.0).round() as u64,
            "videoBitrate": number(video.get("bit_rate")).unwrap_or(0.0) as u64,
            "audioBitrate": audio.and_then(|a| number(a.get("bit_rate"))).unwrap_or(0.0) as u64,
            "hasAudio": audio.is_some(),
            "codec": codec,
            "hdr": transfer != "sdr",
            "transfer": transfer,
            "primaries": video["color_primaries"].as_str().unwrap_or(""),
            "bitDepth": bit_depth,
            "dolbyVisionOnly": dolby_vision_only,
            "rotation": rotation,
            "size": size,
        })
    }

    /// The first render node of the graphics card, the device VA-API encodes on.
    fn render_device() -> Option<String> {
        let mut nodes: Vec<String> = std::fs::read_dir("/dev/dri")
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
            .filter(|n| n.starts_with("renderD"))
            .collect();
        nodes.sort();
        nodes.first().map(|n| format!("/dev/dri/{n}"))
    }

    /// The arguments that draw one picture of `src` into `dst` as a JPEG, `at` seconds in: turned
    /// upright (ffmpeg applies the turn a video or a HEIF still carries), at most `edge` on its
    /// longer side and never enlarged. A HEIC made of tiles is put together by ffmpeg first.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn picture_args(src: &str, dst: &str, edge: u32, at: f64) -> Vec<String> {
        let mut a = strings(&["-hide_banner", "-loglevel", "error", "-nostdin", "-y"]);
        if at > 0.0 {
            a.extend(["-ss".to_string(), format!("{at:.3}")]);
        }
        a.extend(["-i".to_string(), src.to_string()]);
        a.extend(strings(&["-frames:v", "1", "-an", "-vf"]));
        a.push(format!(
            "scale=w='min({edge},iw)':h='min({edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p"
        ));
        a.extend(strings(&["-c:v", "mjpeg", "-q:v", "3", "-f", "mjpeg"]));
        a.push(dst.to_string());
        a
    }

    /// Whether `command` ends well within `limit`; one that runs on past it is stopped.
    pub fn finishes(command: &mut Command, limit: std::time::Duration) -> bool {
        use std::process::Stdio;
        let Ok(mut child) = command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else {
            return false;
        };
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if started.elapsed() < limit => std::thread::sleep(std::time::Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    }

    /// Whether `encoder` writes a few frames here within a few seconds, in 10 bits with `ten_bit`.
    fn works(encoder: &Encoder, ten_bit: bool) -> bool {
        finishes(command("ffmpeg").args(trial_args(encoder, ten_bit)), std::time::Duration::from_secs(10))
    }

    /// Tried once: drivers do not come and go while the app runs.
    pub fn encoders() -> &'static Found {
        static FOUND: std::sync::OnceLock<Found> = std::sync::OnceLock::new();
        FOUND.get_or_init(|| {
            let system = System::current();
            let device = if system == System::Linux { render_device() } else { None };
            let pick =
                |codec: &str| candidates(codec, device.as_deref(), system).into_iter().find(|e| works(e, false));
            let (hevc, av1) = (pick("hevc"), pick("av1"));
            let hevc_hdr = hevc.as_ref().is_some_and(|e| works(e, true));
            let av1_hdr = av1.as_ref().is_some_and(|e| works(e, true));
            Found { avc: pick("avc"), hevc, av1, hevc_hdr, av1_hdr }
        })
    }
}

#[cfg(test)]
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
            "hdr": std::env::var("PFP_TEST_HDR").unwrap_or_default(),
            "transfer": info["transfer"],
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
        let names = |codec, system| {
            candidates(codec, Some("/dev/dri/renderD128"), system).into_iter().map(|e| e.name).collect::<Vec<_>>()
        };
        assert_eq!(names("avc", System::Linux), ["h264_vaapi", "h264_nvenc", "libx264"]);
        assert_eq!(names("hevc", System::Linux), ["hevc_vaapi", "hevc_nvenc"]);
        assert_eq!(names("av1", System::Linux), ["av1_vaapi", "av1_nvenc"]);
        assert_eq!(candidates("avc", None, System::Linux).len(), 2, "no VA-API without a render node");
        assert_eq!(names("avc", System::Windows), ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
        assert_eq!(names("hevc", System::Windows), ["hevc_nvenc", "hevc_qsv", "hevc_amf"]);
        assert_eq!(names("av1", System::Windows), ["av1_nvenc", "av1_qsv", "av1_amf"]);
    }

    #[test]
    fn macos_encodes_with_videotoolbox_alone() {
        let names = |codec| candidates(codec, None, System::MacOs).into_iter().map(|e| e.name).collect::<Vec<_>>();
        assert_eq!(names("avc"), ["h264_videotoolbox"]);
        assert_eq!(names("hevc"), ["hevc_videotoolbox"]);
        assert!(names("av1").is_empty(), "VideoToolbox writes no AV1");
        assert_eq!(frame_format("hevc_videotoolbox"), "nv12");
        let enc = Encoder { name: "hevc_videotoolbox".into(), vaapi: None };
        let job = Job { src: "s", dst: "d", encoder: &enc, width: 1920, height: 1080, bitrate: 1, fps: None, colour: Colour::KeepHlg };
        let a = transcode_args(&job).join(" ");
        assert!(a.contains("-c:v hevc_videotoolbox"), "{a}");
        assert!(a.contains("-pix_fmt p010le"), "{a}");
        assert!(a.contains("-profile:v main10 -tag:v hvc1"), "{a}");
        let trial = trial_args(&enc, true).join(" ");
        assert!(trial.contains("-pix_fmt p010le -c:v hevc_videotoolbox -profile:v main10"), "{trial}");
    }

    #[test]
    fn a_picture_is_one_upright_jpeg_frame_never_enlarged() {
        let a = picture_args("/in.mov", "/out.jpg", 1920, 0.5).join(" ");
        assert!(a.contains("-ss 0.500 -i /in.mov -frames:v 1"), "{a}");
        assert!(!a.contains("noautorotate"), "the turn is applied to the picture");
        assert!(a.contains("scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease"), "{a}");
        assert!(a.ends_with("-c:v mjpeg -q:v 3 -f mjpeg /out.jpg"), "{a}");
        let still = picture_args("/in.heic", "/out.jpg", 1920, 0.0).join(" ");
        assert!(!still.contains("-ss"), "a still is read from its start: {still}");
    }

    #[test]
    fn quick_sync_and_amf_get_nv12_frames() {
        assert_eq!(frame_format("hevc_qsv"), "nv12");
        assert_eq!(frame_format("h264_amf"), "nv12");
        assert_eq!(frame_format("hevc_nvenc"), "yuv420p");
        assert_eq!(frame_format("libx264"), "yuv420p");
        let enc = Encoder { name: "hevc_qsv".into(), vaapi: None };
        let job = Job { src: "s", dst: "d", encoder: &enc, width: 1920, height: 1080, bitrate: 1, fps: None, colour: Colour::Sdr };
        assert!(transcode_args(&job).join(" ").contains("-pix_fmt nv12"));
        assert!(trial_args(&enc, false).join(" ").contains("-pix_fmt nv12"));
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
        assert_eq!(p["transfer"], "hlg");
        assert_eq!(p["dolbyVisionOnly"], false);
        assert_eq!(p["rotation"], 270);
        assert_eq!(p["size"], 99);
    }

    #[test]
    fn a_probe_reads_the_colour_and_a_dolby_vision_stream_without_a_base_picture() {
        let video = |extra: serde_json::Value| {
            let mut v = json!({ "codec_type": "video", "codec_name": "hevc", "width": 1920, "height": 1080 });
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            probe_from(&json!({ "streams": [v], "format": { "duration": "3" } }), 1)
        };
        let hdr10 = video(json!({ "pix_fmt": "yuv420p10le", "color_transfer": "smpte2084", "color_primaries": "bt2020" }));
        assert_eq!(hdr10["transfer"], "pq");
        assert_eq!(hdr10["primaries"], "bt2020");
        assert_eq!(hdr10["bitDepth"], 10);
        let sdr = video(json!({ "pix_fmt": "yuv420p", "color_transfer": "bt709", "color_primaries": "bt709" }));
        assert_eq!(sdr["transfer"], "sdr");
        assert_eq!(sdr["hdr"], false);
        assert_eq!(sdr["bitDepth"], 8);
        assert_eq!(video(json!({ "pix_fmt": "yuv420p", "bits_per_raw_sample": "10" }))["bitDepth"], 10);
        let dovi = |compat: u64| {
            video(json!({ "side_data_list": [{ "side_data_type": "DOVI configuration record", "dv_profile": 5,
                "dv_bl_signal_compatibility_id": compat }] }))["dolbyVisionOnly"]
                .clone()
        };
        assert_eq!(dovi(0), true, "profile 5: no base picture");
        assert_eq!(dovi(4), false, "profile 8.4: an HLG base picture");
        assert_eq!(dovi(1), false, "profile 8.1: an HDR10 base picture");
    }

    #[test]
    fn the_plan_names_what_happens_to_the_colour() {
        assert_eq!(Colour::from_plan("keep", "pq"), Ok(Colour::KeepPq));
        assert_eq!(Colour::from_plan("keep", "hlg"), Ok(Colour::KeepHlg));
        assert!(Colour::from_plan("keep", "sdr").is_err());
        assert_eq!(Colour::from_plan("tone-map", "pq"), Ok(Colour::ToSdr));
        assert_eq!(Colour::from_plan("", ""), Ok(Colour::Sdr));
    }

    #[test]
    fn an_hdr_copy_is_ten_bit_bt2020_with_the_sources_curve() {
        let enc = Encoder { name: "hevc_nvenc".into(), vaapi: None };
        let job = |colour| Job { src: "s", dst: "d", encoder: &enc, width: 1920, height: 1080, bitrate: 1, fps: None, colour };
        let pq = transcode_args(&job(Colour::KeepPq)).join(" ");
        assert!(pq.contains("-vf scale=1920:1080 -c:v hevc_nvenc"), "{pq}");
        assert!(pq.contains("-pix_fmt p010le"), "{pq}");
        assert!(pq.contains("-profile:v main10 -tag:v hvc1"), "{pq}");
        assert!(pq.contains("-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range tv"), "{pq}");
        let hlg = transcode_args(&job(Colour::KeepHlg)).join(" ");
        assert!(hlg.contains("-color_trc arib-std-b67"), "{hlg}");
        let av1 = Encoder { name: "av1_nvenc".into(), vaapi: None };
        let a = transcode_args(&Job { encoder: &av1, ..job(Colour::KeepPq) }).join(" ");
        assert!(a.contains("-pix_fmt p010le") && !a.contains("main10"), "{a}");
        let vaapi = Encoder { name: "hevc_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) };
        let v = transcode_args(&Job { encoder: &vaapi, ..job(Colour::KeepHlg) }).join(" ");
        assert!(v.contains("-vf scale=1920:1080,format=p010le,hwupload -c:v hevc_vaapi"), "{v}");
        assert!(!v.contains("-pix_fmt"), "{v}");
    }

    #[test]
    fn a_tone_mapped_copy_is_eight_bit_bt709() {
        let enc = Encoder { name: "libx264".into(), vaapi: None };
        let job = Job { src: "s", dst: "d", encoder: &enc, width: 1280, height: 720, bitrate: 1, fps: None, colour: Colour::ToSdr };
        let a = transcode_args(&job).join(" ");
        assert!(a.contains(&format!("-vf scale=1280:720,{TONE_MAP} -c:v libx264")), "{a}");
        assert!(a.contains("-pix_fmt yuv420p"), "{a}");
        assert!(a.contains("-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv"), "{a}");
        assert!(!a.contains("main10"), "{a}");
        let qsv = Encoder { name: "hevc_qsv".into(), vaapi: None };
        let q = transcode_args(&Job { encoder: &qsv, ..job }).join(" ");
        assert!(q.contains("-pix_fmt nv12"), "{q}");
        let vaapi = Encoder { name: "h264_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) };
        let v = transcode_args(&Job { encoder: &vaapi, ..job }).join(" ");
        assert!(v.contains(&format!("scale=1280:720,{TONE_MAP},format=nv12,hwupload -c:v h264_vaapi")), "{v}");
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
        let job = Job { src: "/a.mov", dst: "/b.mp4", encoder: &enc, width: 1280, height: 720, bitrate: 3_000_000, fps: Some(30.0), colour: Colour::Sdr };
        let a = transcode_args(&job).join(" ");
        assert!(a.contains("-noautorotate -i /a.mov"), "{a}");
        assert!(a.contains("-map 0:v:0 -map 0:a:0?"), "{a}");
        assert!(a.contains("-vf scale=1280:720 -c:v libx264 -b:v 3000000"), "{a}");
        assert!(a.contains("-pix_fmt yuv420p"), "{a}");
        assert!(a.contains("-r 30.000"), "{a}");
        assert!(a.ends_with("-progress pipe:1 /b.mp4"), "{a}");
    }

    #[test]
    fn a_copy_keeps_the_sources_quicktime_tags_without_its_brands() {
        let enc = Encoder { name: "hevc_nvenc".into(), vaapi: None };
        let job = Job { src: "/a.mov", dst: "/b.mp4", encoder: &enc, width: 1920, height: 1080, bitrate: 1, fps: None, colour: Colour::KeepPq };
        let a = transcode_args(&job);
        let text = a.join(" ");
        assert!(text.contains("-movflags +faststart+use_metadata_tags -progress pipe:1 /b.mp4"), "{text}");
        assert!(!text.contains("-map_metadata"), "the first input's tags go over by default, without its creation_time");
        for brand in ["major_brand=", "minor_version=", "compatible_brands="] {
            let at = a.iter().position(|s| s == brand).unwrap_or_else(|| panic!("{brand} missing: {text}"));
            assert_eq!(a[at - 1], "-metadata");
        }
        let out = a.iter().position(|s| s == "/b.mp4").unwrap();
        assert!(a.iter().position(|s| s == "major_brand=").unwrap() < out, "an output option");
    }

    #[test]
    fn a_vaapi_transcode_uploads_its_frames_to_the_card() {
        let enc = Encoder { name: "hevc_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) };
        let job = Job { src: "s", dst: "d", encoder: &enc, width: 1920, height: 1080, bitrate: 1, fps: None, colour: Colour::Sdr };
        let a = transcode_args(&job).join(" ");
        assert!(a.contains("-vaapi_device /dev/dri/renderD128 -i s"), "{a}");
        assert!(a.contains("-vf scale=1920:1080,format=nv12,hwupload -c:v hevc_vaapi"), "{a}");
        assert!(a.contains("-tag:v hvc1"), "{a}");
        assert!(!a.contains("-pix_fmt"), "{a}");
        assert!(!a.contains(" -r "), "{a}");
    }

    #[test]
    fn an_encoder_is_tried_on_a_test_picture() {
        let a = trial_args(&Encoder { name: "h264_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) }, false).join(" ");
        assert!(a.contains("-vaapi_device /dev/dri/renderD128 -f lavfi"), "{a}");
        assert!(a.ends_with("-c:v h264_vaapi -b:v 1000000 -f null -"), "{a}");
        let ten = trial_args(&Encoder { name: "hevc_nvenc".into(), vaapi: None }, true).join(" ");
        assert!(ten.contains("-pix_fmt p010le -c:v hevc_nvenc -profile:v main10"), "{ten}");
        let ten_vaapi = trial_args(&Encoder { name: "av1_vaapi".into(), vaapi: Some("/dev/dri/renderD128".into()) }, true).join(" ");
        assert!(ten_vaapi.contains("-vf format=p010le,hwupload -c:v av1_vaapi -b:v"), "{ten_vaapi}");
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
