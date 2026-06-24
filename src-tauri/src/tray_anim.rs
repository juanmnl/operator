//! Animated menu-bar tray icon. The icon IS the brand mark — the dot-circle
//! "twinkle" (see src/renderer/components/LogoMark.tsx + sidebar/StatusWave.tsx):
//! a 7×7 disc of dots that breathe (scale 0.5→1, opacity 0.3→peak) on an eased,
//! desynced cycle. We rasterize that animation to a macOS *template* image
//! (black + alpha; the system tints it for the menu bar) and cycle frames,
//! driven by the aggregate session signal the transcript tailer computes:
//!
//!   BUSY      (any alive session "running")  → lively twinkle      ("working")
//!   YOUR_TURN (else any alive "waiting")     → slow unison pulse    ("your turn")
//!   IDLE      (no alive sessions)            → static mark
//!
//! The tailer writes the current state into `TrayState`; this module's thread
//! reads it ~12fps and repaints. `set_icon` marshals to the main thread itself.

use std::sync::atomic::{AtomicU8, Ordering};
use std::time::Duration;

use tauri::image::Image;
use tauri::Manager;

pub const IDLE: u8 = 0;
pub const BUSY: u8 = 1;
pub const YOUR_TURN: u8 = 2;

/// Aggregate tray signal — written by the transcript tailer, read by the animator.
#[derive(Default)]
pub struct TrayState(AtomicU8);

impl TrayState {
    pub fn set(&self, v: u8) {
        self.0.store(v, Ordering::Relaxed);
    }
    pub fn get(&self) -> u8 {
        self.0.load(Ordering::Relaxed)
    }
}

const SIZE: usize = 44; // matches icons/tray.png (22pt @2x)
const CENTER: f64 = 3.5; // grid centre in dot-centre coords: (7-1)/2 + 0.5
const DISC: f64 = 3.4; // disc radius in cell units (StatusWave RADIUS)
const DOT_R: f64 = 0.5; // dot radius in cell units
// Fit the 7-cell mark into a 40px disc with 2px padding so the rendered icon
// matches the visible size of the static tray.png (whose opaque box is 40×40 in
// the 44×44 canvas). Without the inset the disc filled the whole canvas and read
// slightly larger than the old icon.
const MARK: f64 = 40.0; // visible mark diameter in px
const INSET: f64 = (SIZE as f64 - MARK) / 2.0; // px padding on each side
const PX: f64 = MARK / 7.0; // pixels per cell (7 cells across the mark)

struct Dot {
    cx: f64,
    cy: f64,
    v: f64,   // size/brightness weight (LogoMark static)
    dur: f64, // breathing period (busy)
    off: f64, // phase offset (desync)
}

// Frozen pseudo-random matching the renderer's rand(): frac(sin(seed·k)·m).
fn rand(seed: f64) -> f64 {
    let x = (seed * 12.9898).sin() * 43758.5453;
    x - x.floor()
}

// Dots inside the disc, in the same c-outer/r-inner order as LogoMark/StatusWave
// so the per-index pseudo-random weights line up with the brand mark.
fn build_dots() -> Vec<Dot> {
    let max = DISC * DISC * 1.04;
    let mut out: Vec<Dot> = Vec::new();
    for c in 0..7 {
        for r in 0..7 {
            let cx = c as f64 + 0.5;
            let cy = r as f64 + 0.5;
            let dx = cx - CENTER;
            let dy = cy - CENTER;
            if dx * dx + dy * dy <= max {
                let i = out.len() as f64;
                out.push(Dot {
                    cx,
                    cy,
                    v: rand(i + 11.0),
                    dur: 1.4 + rand(i + 1.0) * 1.2, // 1.4–2.6s, the running tempo
                    off: rand(i + 7.0),
                });
            }
        }
    }
    out
}

// Anti-aliased filled disc into the alpha channel (black + alpha = template).
// Overlapping dots take the max alpha so seams don't double-darken.
fn paint_dot(buf: &mut [u8], cx: f64, cy: f64, scale: f64, op: f64) {
    let pcx = INSET + cx * PX;
    let pcy = INSET + cy * PX;
    let rad = scale * DOT_R * PX;
    let x0 = (pcx - rad - 1.0).floor().max(0.0) as usize;
    let x1 = (pcx + rad + 1.0).ceil().min(SIZE as f64) as usize;
    let y0 = (pcy - rad - 1.0).floor().max(0.0) as usize;
    let y1 = (pcy + rad + 1.0).ceil().min(SIZE as f64) as usize;
    for y in y0..y1 {
        for x in x0..x1 {
            let dx = x as f64 + 0.5 - pcx;
            let dy = y as f64 + 0.5 - pcy;
            let dist = (dx * dx + dy * dy).sqrt();
            let cov = (rad - dist + 0.5).clamp(0.0, 1.0); // ~1px AA edge
            if cov <= 0.0 {
                continue;
            }
            let a = (cov * op * 255.0) as u8;
            let idx = (y * SIZE + x) * 4 + 3; // alpha byte
            if a > buf[idx] {
                buf[idx] = a;
            }
        }
    }
}

// One RGBA frame for `state` at time `t` (seconds). RGB stays 0; only alpha
// carries the shape so macOS can tint it for the active menu bar.
fn frame(dots: &[Dot], state: u8, t: f64) -> Vec<u8> {
    let mut buf = vec![0u8; SIZE * SIZE * 4];
    // YOUR_TURN: the whole disc breathes in unison — a calm "your turn" beacon.
    let pulse = (1.0 - (std::f64::consts::TAU * (t / 2.6).fract()).cos()) * 0.5;
    for d in dots {
        let (op, scale) = match state {
            BUSY => {
                let phase = (t / d.dur + d.off).fract();
                let s = (1.0 - (std::f64::consts::TAU * phase).cos()) * 0.5; // 0→1→0
                (0.30 + 0.65 * s, 0.5 + 0.5 * s) // op 0.30→0.95, scale 0.5→1
            }
            YOUR_TURN => (0.35 + 0.40 * pulse, 0.62 + 0.30 * pulse), // gentle, legible
            _ => {
                let w = 0.62 + 0.38 * d.v; // IDLE: LogoMark's static weighting
                (w, w)
            }
        };
        paint_dot(&mut buf, d.cx, d.cy, scale, op);
    }
    buf
}

/// Spawn the repaint loop: read the aggregate signal ~12fps and update the tray.
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let dots = build_dots();
        let mut t = 0.0_f64;
        let mut idle_painted = false;
        // The your-turn pulse is a transient beacon, not a permanent state: after
        // YOUR_TURN_SETTLE seconds it settles to the static idle mark so the menu
        // bar doesn't pulse forever. Entering YOUR_TURN (incl. a fresh turn after
        // BUSY) re-arms it. Mirrors StatusWave's settle in the sidebar.
        const YOUR_TURN_SETTLE: f64 = 6.0;
        let mut prev_state = IDLE;
        let mut yt_elapsed = 0.0_f64;
        loop {
            std::thread::sleep(Duration::from_millis(80)); // ~12.5 fps
            let state = app.state::<TrayState>().get();
            if state == YOUR_TURN && prev_state != YOUR_TURN {
                yt_elapsed = 0.0; // a new your-turn stretch began → re-arm the pulse
            }
            prev_state = state;
            let Some(tray) = app.tray_by_id("operator") else {
                continue;
            };
            // A your-turn that has pulsed long enough renders as idle (static).
            let settled = state == YOUR_TURN && yt_elapsed >= YOUR_TURN_SETTLE;
            if state == IDLE || settled {
                // Static mark — paint once on settling, then rest the loop.
                if !idle_painted {
                    let buf = frame(&dots, IDLE, 0.0);
                    let _ = tray.set_icon_with_as_template(
                        Some(Image::new(&buf, SIZE as u32, SIZE as u32)),
                        true,
                    );
                    idle_painted = true;
                }
                continue;
            }
            idle_painted = false;
            if state == YOUR_TURN {
                yt_elapsed += 0.08;
            }
            t += 0.08;
            let buf = frame(&dots, state, t);
            let _ = tray
                .set_icon_with_as_template(Some(Image::new(&buf, SIZE as u32, SIZE as u32)), true);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rand_is_deterministic_and_in_unit_range() {
        assert_eq!(rand(0.0), 0.0); // sin(0)=0
        for i in 0..50 {
            let v = rand(i as f64 + 0.5);
            assert!((0.0..1.0).contains(&v), "rand out of range: {v}");
            assert_eq!(v, rand(i as f64 + 0.5)); // stable across calls
        }
    }

    #[test]
    fn build_dots_fills_the_disc_deterministically() {
        let dots = build_dots();
        // 7x7 grid clipped to the disc (radius 3.4, 1.04 tolerance) → 37 cells.
        assert_eq!(dots.len(), 37);
        let max = DISC * DISC * 1.04;
        for d in &dots {
            let dx = d.cx - CENTER;
            let dy = d.cy - CENTER;
            assert!(dx * dx + dy * dy <= max, "dot outside disc");
            assert!((1.4..2.6).contains(&d.dur), "dur out of band: {}", d.dur);
            assert!((0.0..1.0).contains(&d.v));
            assert!((0.0..1.0).contains(&d.off));
        }
    }
}
