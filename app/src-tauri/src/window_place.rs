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

//! Where the main window opens: where it was left, while that is still on a screen, and
//! otherwise large and in the middle of the main screen's work area.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

const FILE: &str = "window.json";
/// The share of the work area a first window takes.
const FIRST_SHARE: f64 = 0.8;
/// How much of a remembered window must still be on some screen for it to open there.
const ON_SCREEN: i64 = 120;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Saved {
    /// The window as it was when not maximized, so a maximized one restores to it.
    pub rect: Rect,
    pub maximized: bool,
}

fn overlap(a: &Rect, b: &Rect) -> (i64, i64) {
    let w = (a.x as i64 + a.w as i64).min(b.x as i64 + b.w as i64) - (a.x as i64).max(b.x as i64);
    let h = (a.y as i64 + a.h as i64).min(b.y as i64 + b.h as i64) - (a.y as i64).max(b.y as i64);
    (w, h)
}

/// The rect to open at: the saved one while enough of it is on a screen, else a share
/// of the main work area, no smaller than `least` (and no larger than the area), centred.
pub fn choose(saved: Option<&Saved>, screens: &[Rect], main: Rect, least: (u32, u32)) -> Rect {
    if let Some(s) = saved {
        let seen = screens.iter().any(|sc| {
            let (w, h) = overlap(&s.rect, sc);
            w >= ON_SCREEN && h >= ON_SCREEN
        });
        if seen && s.rect.w > 0 && s.rect.h > 0 {
            return s.rect;
        }
    }
    let w = ((main.w as f64 * FIRST_SHARE) as u32).max(least.0).min(main.w);
    let h = ((main.h as f64 * FIRST_SHARE) as u32).max(least.1).min(main.h);
    Rect { x: main.x + ((main.w - w) / 2) as i32, y: main.y + ((main.h - h) / 2) as i32, w, h }
}

fn load(app: &AppHandle) -> Option<Saved> {
    let dir = crate::secure_store::app_dir(app).ok()?;
    serde_json::from_slice(&std::fs::read(dir.join(FILE)).ok()?).ok()
}

fn save(app: &AppHandle, saved: &Saved) {
    let Ok(dir) = crate::secure_store::app_dir(app) else { return };
    if let Ok(bytes) = serde_json::to_vec(saved) {
        let _ = std::fs::write(dir.join(FILE), bytes);
    }
}

/// Puts a new, still hidden main window in its place, and keeps that place up to date.
pub fn apply(app: &AppHandle, window: &WebviewWindow, least: (f64, f64)) {
    let saved = load(app);
    let screens: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let a = m.work_area();
            Rect { x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height }
        })
        .collect();
    let primary = window.primary_monitor().ok().flatten();
    if let Some(main) = primary.as_ref() {
        let a = main.work_area();
        let scale = main.scale_factor();
        let area = Rect { x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height };
        let least = ((least.0 * scale) as u32, (least.1 * scale) as u32);
        let at = choose(saved.as_ref(), &screens, area, least);
        let _ = window.set_size(PhysicalSize::new(at.w, at.h));
        let _ = window.set_position(PhysicalPosition::new(at.x, at.y));
    }
    if saved.is_some_and(|s| s.maximized) {
        let _ = window.maximize();
    }
    follow(app, window);
}

/// Writes the window's place a moment after it stops moving or resizing.
fn follow(app: &AppHandle, window: &WebviewWindow) {
    static LATEST: Mutex<Option<u64>> = Mutex::new(None);
    let app = app.clone();
    let win = window.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        let ticket = {
            let mut latest = LATEST.lock().unwrap();
            let next = latest.map_or(1, |n| n + 1);
            *latest = Some(next);
            next
        };
        let app = app.clone();
        let win = win.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            if *LATEST.lock().unwrap() != Some(ticket) {
                return;
            }
            // A minimized or hidden window has no place worth keeping.
            if win.is_minimized().unwrap_or(true) || !win.is_visible().unwrap_or(false) {
                return;
            }
            let maximized = win.is_maximized().unwrap_or(false);
            // Maximized, it keeps the size it restores to and only the flag changes.
            let rect = if maximized { load(&app).map(|s| s.rect) } else { current(&win) };
            if let Some(rect) = rect {
                save(&app, &Saved { rect, maximized });
            }
        });
    });
}

fn current(win: &WebviewWindow) -> Option<Rect> {
    let p = win.outer_position().ok()?;
    // The size `set_size` takes back: the outer one carries the resize border too, and a
    // window restored from it would grow by that border at every start.
    let s = win.inner_size().ok()?;
    Some(Rect { x: p.x, y: p.y, w: s.width, h: s.height })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = Rect { x: 0, y: 0, w: 2560, h: 1400 };

    #[test]
    fn first_window_is_large_and_centred() {
        let r = choose(None, &[MAIN], MAIN, (1100, 720));
        assert_eq!((r.w, r.h), (2048, 1120));
        assert_eq!((r.x, r.y), (256, 140));
    }

    #[test]
    fn a_small_screen_still_gets_the_least_size_but_never_more_than_it_has() {
        let small = Rect { x: 0, y: 0, w: 1280, h: 680 };
        let r = choose(None, &[small], small, (1100, 720));
        assert_eq!((r.w, r.h), (1100, 680));
        assert_eq!((r.x, r.y), (90, 0));
    }

    #[test]
    fn a_remembered_place_on_a_screen_is_kept() {
        let s = Saved { rect: Rect { x: 300, y: 200, w: 1400, h: 900 }, maximized: false };
        assert_eq!(choose(Some(&s), &[MAIN], MAIN, (1100, 720)), s.rect);
    }

    #[test]
    fn a_place_on_a_screen_that_is_gone_falls_back_to_the_middle() {
        let s = Saved { rect: Rect { x: 3000, y: 100, w: 1400, h: 900 }, maximized: false };
        let r = choose(Some(&s), &[MAIN], MAIN, (1100, 720));
        assert_eq!((r.x, r.y, r.w, r.h), (256, 140, 2048, 1120));
    }

    #[test]
    fn a_window_mostly_off_screen_is_brought_back() {
        let s = Saved { rect: Rect { x: 2500, y: 100, w: 1400, h: 900 }, maximized: false };
        let r = choose(Some(&s), &[MAIN], MAIN, (1100, 720));
        assert_eq!((r.x, r.y), (256, 140));
    }
}
