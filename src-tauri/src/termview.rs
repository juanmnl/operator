// Phase 2 — native terminal: live pty → alacritty grid → glyphon render.
//
// The pty bytes that used to base64→event→xterm now also feed an
// `alacritty_terminal::Term` here; we render its grid with glyphon into the
// wgpu NSView that Phase 0 proved composites under the WKWebView. Keyboard input
// still flows through a headless xterm in the webview (NativeTerminalPane) →
// `terminal_write`, so we don't re-implement xterm's key encoder yet.
//
// Cols/rows are derived from the surface pixel size and the font metrics (which
// live HERE now, not in a JS FitAddon), so this module also drives the pty
// resize. Per-glyph Buffers are cached so a streaming TUI doesn't reshape every
// cell every frame; renders are throttled to ~60fps.
//
// Everything that touches the NSView / wgpu / Term runs on the AppKit main
// thread (via run_on_main_thread). Per-cell backgrounds + cursor are still
// deferred (need a solid-quad pipeline); Phase 2 clears to the theme bg.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once a native view attaches, so the pty reader thread skips the
/// main-thread hop entirely for users who never enable the native terminal.
#[cfg(target_os = "macos")]
static NATIVE_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Called from the pty reader thread for every chunk. No-op (one atomic load)
/// unless a native view is attached.
pub fn on_pty_output(app: &tauri::AppHandle, id: &str, bytes: &[u8]) {
    #[cfg(target_os = "macos")]
    {
        if !NATIVE_ACTIVE.load(Ordering::Relaxed) {
            return;
        }
        let app2 = app.clone();
        let id = id.to_string();
        let data = bytes.to_vec();
        let _ = app.run_on_main_thread(move || imp::feed(&app2, &id, &data));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id, bytes);
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use alacritty_terminal::grid::{Dimensions, Scroll};
    use alacritty_terminal::index::{Column, Point, Side};
    use alacritty_terminal::selection::{Selection, SelectionRange, SelectionType};
    use alacritty_terminal::term::cell::Flags;
    use alacritty_terminal::term::{viewport_to_point, Config, Term, TermMode};
    use alacritty_terminal::vte::ansi::{Color as AnsiColor, NamedColor, Processor};
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;
    use glyphon::{
        Attrs, Buffer, Cache, Color, Family, FontSystem, Metrics, Resolution, Shaping, SwashCache,
        TextArea, TextAtlas, TextBounds, TextRenderer, Viewport, Weight,
    };
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAutoresizingMaskOptions, NSView, NSWindow, NSWindowOrderingMode};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tauri::{Emitter, Manager};
    use wgpu::util::DeviceExt;

    // Solid-color instanced quads — cell backgrounds + the cursor. Corners are
    // generated from the vertex index; each instance supplies a pixel-space rect
    // (top-left origin) + rgba, converted to NDC against the surface resolution.
    const QUAD_WGSL: &str = r#"
struct U { res: vec2<f32> };
@group(0) @binding(0) var<uniform> u: U;
struct VsOut { @builtin(position) pos: vec4<f32>, @location(0) color: vec4<f32> };
@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4<f32>, @location(1) color: vec4<f32>) -> VsOut {
    var corners = array<vec2<f32>, 6>(
        vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
        vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0));
    let px = rect.xy + corners[vi] * rect.zw;
    let ndc = vec2<f32>(px.x / u.res.x * 2.0 - 1.0, 1.0 - px.y / u.res.y * 2.0);
    var o: VsOut;
    o.pos = vec4<f32>(ndc, 0.0, 1.0);
    o.color = color;
    return o;
}
@fragment
fn fs(i: VsOut) -> @location(0) vec4<f32> { return i.color; }
"#;

    fn f32_bytes(v: &[f32]) -> &[u8] {
        unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
    }

    use super::NATIVE_ACTIVE;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Guards a single pending trailing render (so a throttled burst still draws
    /// its final frame ~20ms later without scheduling one per chunk).
    static TRAILING: AtomicBool = AtomicBool::new(false);

    /// Last theme palette pushed from JS, applied to the FIRST frame of a freshly
    /// built state — so a Light-theme session renders light immediately (no dark
    /// flash) when set_theme is called before attach.
    static PENDING_THEME: Mutex<Option<Palette>> = Mutex::new(None);

    /// Grid sizing passed to alacritty's `Term::new` / `Term::resize`.
    #[derive(Clone, Copy)]
    struct Size {
        cols: usize,
        lines: usize,
    }
    impl Dimensions for Size {
        fn total_lines(&self) -> usize { self.lines }
        fn screen_lines(&self) -> usize { self.lines }
        fn columns(&self) -> usize { self.cols }
    }

    #[derive(Clone)]
    struct NoopListener;
    impl alacritty_terminal::event::EventListener for NoopListener {}

    /// One terminal's parse state + grid. Cheap; lives even when not the active
    /// (drawn) terminal, so background sessions keep streaming.
    struct TermCore {
        term: Term<NoopListener>,
        parser: Processor,
        cols: usize,
        lines: usize,
        // Rolling ANSI-stripped tail + last-seen dev port, for sniffing the
        // "Local: http://localhost:PORT" banner (the native path has no JS xterm).
        tail: String,
        dev_port: Option<u16>,
    }

    pub struct TermState {
        // Shared GPU / main-thread render resources (one NSView + surface, reused
        // for whichever terminal is active).
        view: Retained<NSView>,
        device: wgpu::Device,
        queue: wgpu::Queue,
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
        font_system: FontSystem,
        swash_cache: SwashCache,
        atlas: TextAtlas,
        viewport: Viewport,
        text_renderer: TextRenderer,
        // One shaped Buffer per (glyph, bold) — reused across cells/frames/terminals.
        glyph_cache: HashMap<(char, bool), Buffer>,
        quad_pipeline: wgpu::RenderPipeline,
        quad_uniform: wgpu::Buffer,
        quad_bind: wgpu::BindGroup,
        cell_w: f32,
        cell_h: f32,
        font_px: f32,
        palette: Palette,
        last_render: Instant,
        // Per-terminal grids, and which one is currently drawn.
        terms: HashMap<String, TermCore>,
        active: Option<String>,
    }
    // Touched only on the main thread (NSView is the lone hard-!Send field).
    unsafe impl Send for TermState {}

    #[derive(Default)]
    pub struct PocTerminal(pub Mutex<Option<TermState>>);

    /// Terminal colors. Defaults to an approximate Mission Control (dark) palette;
    /// `poc_set_theme` overwrites it from the active JS theme.
    #[derive(Clone)]
    struct Palette {
        ansi: [(u8, u8, u8); 16],
        fg: (u8, u8, u8),
        bg: (u8, u8, u8),
        cursor: (u8, u8, u8),
        selection: (u8, u8, u8),
    }
    impl Default for Palette {
        fn default() -> Self {
            Palette {
                ansi: [
                    (40, 42, 46), (255, 107, 107), (63, 208, 127), (240, 200, 100),
                    (110, 160, 255), (200, 130, 230), (90, 200, 210), (200, 202, 206),
                    (90, 92, 96), (255, 140, 140), (120, 230, 160), (250, 220, 140),
                    (150, 190, 255), (220, 160, 240), (130, 220, 230), (240, 242, 246),
                ],
                fg: (230, 231, 233),
                bg: (11, 13, 16),
                cursor: (230, 231, 233),
                selection: (60, 70, 90),
            }
        }
    }

    fn cube(i: u8) -> u8 { if i == 0 { 0 } else { 55 + i * 40 } }

    fn indexed_rgb(p: &Palette, i: u8) -> (u8, u8, u8) {
        match i {
            0..=15 => p.ansi[i as usize],
            16..=231 => { let i = i - 16; (cube(i / 36), cube((i / 6) % 6), cube(i % 6)) }
            _ => { let v = 8 + (i - 232) * 10; (v, v, v) }
        }
    }

    fn named_rgb(p: &Palette, n: NamedColor) -> (u8, u8, u8) {
        use NamedColor::*;
        match n {
            Black => p.ansi[0], Red => p.ansi[1], Green => p.ansi[2], Yellow => p.ansi[3],
            Blue => p.ansi[4], Magenta => p.ansi[5], Cyan => p.ansi[6], White => p.ansi[7],
            BrightBlack => p.ansi[8], BrightRed => p.ansi[9], BrightGreen => p.ansi[10],
            BrightYellow => p.ansi[11], BrightBlue => p.ansi[12], BrightMagenta => p.ansi[13],
            BrightCyan => p.ansi[14], BrightWhite => p.ansi[15],
            Background => p.bg,
            _ => p.fg,
        }
    }

    fn raw_rgb(p: &Palette, c: AnsiColor) -> (u8, u8, u8) {
        match c {
            AnsiColor::Spec(rgb) => (rgb.r, rgb.g, rgb.b),
            AnsiColor::Named(n) => named_rgb(p, n),
            AnsiColor::Indexed(i) => indexed_rgb(p, i),
        }
    }

    /// Resolve a cell to (foreground glyph color, optional background fill).
    /// Handles INVERSE (swap fg/bg, with the screen colors as defaults) and DIM.
    fn cell_colors(p: &Palette, fg: AnsiColor, bg: AnsiColor, flags: Flags) -> (Color, Option<(f32, f32, f32)>) {
        let mut fg_rgb = raw_rgb(p, fg);
        let mut bg_rgb = match bg {
            AnsiColor::Named(NamedColor::Background) => None,
            other => Some(raw_rgb(p, other)),
        };
        if flags.contains(Flags::INVERSE) {
            let prev_fg = fg_rgb;
            fg_rgb = bg_rgb.unwrap_or(p.bg);
            bg_rgb = Some(prev_fg);
        }
        if flags.contains(Flags::DIM) {
            fg_rgb = ((fg_rgb.0 as f32 * 0.62) as u8, (fg_rgb.1 as f32 * 0.62) as u8, (fg_rgb.2 as f32 * 0.62) as u8);
        }
        let bg_f = bg_rgb.map(|(r, g, b)| (r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0));
        (Color::rgb(fg_rgb.0, fg_rgb.1, fg_rgb.2), bg_f)
    }

    fn norm(c: (u8, u8, u8)) -> (f32, f32, f32) {
        (c.0 as f32 / 255.0, c.1 as f32 / 255.0, c.2 as f32 / 255.0)
    }

    fn parse_hex(s: &str) -> Option<(u8, u8, u8)> {
        let s = s.trim_start_matches('#');
        if s.len() < 6 { return None; }
        let r = u8::from_str_radix(&s[0..2], 16).ok()?;
        let g = u8::from_str_radix(&s[2..4], 16).ok()?;
        let b = u8::from_str_radix(&s[4..6], 16).ok()?;
        Some((r, g, b))
    }

    /// Is a grid point inside the (line-ordered) selection range?
    fn in_sel(p: Point, r: &SelectionRange) -> bool {
        if r.is_block {
            p.line >= r.start.line && p.line <= r.end.line && p.column >= r.start.column && p.column <= r.end.column
        } else if p.line < r.start.line || p.line > r.end.line {
            false
        } else if p.line == r.start.line && p.column < r.start.column {
            false
        } else {
            !(p.line == r.end.line && p.column > r.end.column)
        }
    }

    fn set_clipboard(text: &str) {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        unsafe { pb.setString_forType(&NSString::from_str(text), NSPasteboardTypeString) };
    }

    /// SGR mouse report bytes (CSI < b ; col ; row M/m), 1-based. Empty if the app
    /// negotiated only legacy X10 mouse (rare for modern TUIs) or an unknown kind.
    fn sgr_mouse(kind: &str, button: u8, col: usize, row: usize, sgr: bool) -> Vec<u8> {
        if !sgr {
            return Vec::new();
        }
        let (b, suffix) = match kind {
            "down" => (button, 'M'),
            "up" => (button, 'm'),
            "move" => (button + 32, 'M'),
            _ => return Vec::new(),
        };
        format!("\x1b[<{};{};{}{}", b, col + 1, row + 1, suffix).into_bytes()
    }

    fn family() -> Family<'static> { Family::Name("SF Mono") }

    /// Glyphs meant to TILE — box-drawing, block elements, and Symbols for Legacy
    /// Computing (Claude Code's crab logo). These are designed to fill their whole
    /// cell so neighbours form a continuous image; drawn at the text size inside a
    /// 1.2× line-height cell they'd leave seams. We rasterize them at the full cell
    /// height so they fill vertically and tile. (Procedural quad drawing later will
    /// make this exact in both axes.)
    fn is_fill_glyph(ch: char) -> bool {
        matches!(ch as u32,
            0x2500..=0x259F      // Box Drawing + Block Elements
            | 0x1FB00..=0x1FBFF  // Symbols for Legacy Computing
            | 0x1CC00..=0x1CEBF) // …Supplement
    }

    fn ensure_glyph(
        cache: &mut HashMap<(char, bool), Buffer>,
        fs: &mut FontSystem,
        ch: char,
        bold: bool,
        cell_w: f32,
        cell_h: f32,
        font_px: f32,
    ) {
        if cache.contains_key(&(ch, bold)) {
            return;
        }
        let weight = if bold { Weight::BOLD } else { Weight::NORMAL };
        let attrs = Attrs::new().family(family()).weight(weight);
        // Tiling glyphs fill the full cell height; text uses the normal size.
        let size = if is_fill_glyph(ch) { cell_h } else { font_px };
        let mut buffer = Buffer::new(fs, Metrics::new(size, cell_h));
        buffer.set_size(fs, Some(cell_w * 2.0), Some(cell_h));
        buffer.set_text(fs, &ch.to_string(), &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(fs, false);
        cache.insert((ch, bold), buffer);
    }

    fn render(st: &mut TermState) {
        let Some(id) = st.active.clone() else { return };
        let (cw, ch_px) = (st.cell_w, st.cell_h);
        // 1. One grid pass → background quads + text placements (immutable borrow
        //    of the active TermCore).
        let mut cells: Vec<(f32, f32, char, bool, Color)> = Vec::new();
        let mut quads: Vec<f32> = Vec::new(); // 8 f32 per quad: rect(4) + rgba(4)
        {
            let Some(core) = st.terms.get(&id) else { return };
            let lines = core.lines;
            let pal = &st.palette;
            let sel_color = norm(pal.selection);
            let sel_range = core.term.selection.as_ref().and_then(|s| s.to_range(&core.term));
            let mut push_quad = |x: f32, y: f32, w: f32, h: f32, c: (f32, f32, f32)| {
                quads.extend_from_slice(&[x, y, w, h, c.0, c.1, c.2, 1.0]);
            };
            for indexed in core.term.grid().display_iter() {
                let cell = indexed.cell;
                let line = indexed.point.line.0;
                if line < 0 || line as usize >= lines {
                    continue;
                }
                let col = indexed.point.column.0;
                let left = col as f32 * cw;
                let top = line as f32 * ch_px;
                let (fg, bg) = cell_colors(pal, cell.fg, cell.bg, cell.flags);
                let selected = sel_range.as_ref().is_some_and(|r| in_sel(indexed.point, r));
                if selected {
                    push_quad(left, top, cw, ch_px, sel_color);
                } else if let Some(bg) = bg {
                    push_quad(left, top, cw, ch_px, bg);
                }
                let glyph = cell.c;
                if glyph == ' ' || glyph == '\0' || cell.flags.contains(Flags::WIDE_CHAR_SPACER) {
                    continue;
                }
                let bold = cell.flags.intersects(Flags::BOLD | Flags::DIM_BOLD);
                cells.push((left, top, glyph, bold, fg));
            }
            // Cursor: a bar at the left of the cursor cell (block style later).
            let cursor = core.term.grid().cursor.point;
            if cursor.line.0 >= 0 && (cursor.line.0 as usize) < lines {
                let x = cursor.column.0 as f32 * cw;
                let y = cursor.line.0 as f32 * ch_px;
                push_quad(x, y, (cw * 0.12).max(1.0), ch_px, norm(pal.cursor));
            }
        }

        // 2. Ensure a shaped Buffer exists for each (glyph, bold).
        for &(_, _, glyph, bold, _) in &cells {
            ensure_glyph(&mut st.glyph_cache, &mut st.font_system, glyph, bold, st.cell_w, st.cell_h, st.font_px);
        }

        // 3. Prepare text + draw.
        st.viewport.update(&st.queue, Resolution { width: st.config.width, height: st.config.height });
        let areas = cells.iter().map(|&(left, top, ch, bold, color)| TextArea {
            buffer: &st.glyph_cache[&(ch, bold)],
            left,
            top,
            scale: 1.0,
            bounds: TextBounds::default(),
            default_color: color,
            custom_glyphs: &[],
        });
        if let Err(e) = st.text_renderer.prepare(
            &st.device, &st.queue, &mut st.font_system, &mut st.atlas, &st.viewport, areas, &mut st.swash_cache,
        ) {
            eprintln!("[termview] prepare: {e:?}");
            return;
        }

        // Background/cursor quads: upload resolution + build this frame's instances.
        st.queue.write_buffer(&st.quad_uniform, 0, f32_bytes(&[st.config.width as f32, st.config.height as f32, 0.0, 0.0]));
        let n_quads = (quads.len() / 8) as u32;
        let inst_buf = (n_quads > 0).then(|| {
            st.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("term-quads"),
                contents: f32_bytes(&quads),
                usage: wgpu::BufferUsages::VERTEX,
            })
        });

        let cb = norm(st.palette.bg);
        let clear = wgpu::Color { r: cb.0 as f64, g: cb.1 as f64, b: cb.2 as f64, a: 1.0 };
        let frame = match st.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f) | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            _ => return,
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor::default());
        let mut enc = st.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: None,
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(clear), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            // Backgrounds + cursor first, text on top.
            if let Some(buf) = &inst_buf {
                pass.set_pipeline(&st.quad_pipeline);
                pass.set_bind_group(0, &st.quad_bind, &[]);
                pass.set_vertex_buffer(0, buf.slice(..));
                pass.draw(0..6, 0..n_quads);
            }
            let _ = st.text_renderer.render(&st.atlas, &st.viewport, &mut pass);
        }
        st.queue.submit([enc.finish()]);
        frame.present();
        st.atlas.trim();
        st.last_render = Instant::now();
    }

    fn grid_dims(width: u32, height: u32, cell_w: f32, cell_h: f32) -> (usize, usize) {
        let cols = (width as f32 / cell_w).floor().max(1.0) as usize;
        let lines = (height as f32 / cell_h).floor().max(1.0) as usize;
        (cols, lines)
    }

    fn resize_pty(app: &tauri::AppHandle, id: &str, cols: usize, lines: usize) {
        let mgr = app.state::<Arc<crate::PtyManager>>();
        mgr.resize_pty(id, cols as u16, lines as u16);
    }

    fn flip_rect(content_h: f64, x: f64, y: f64, w: f64, h: f64) -> NSRect {
        NSRect::new(NSPoint::new(x, content_h - (y + h)), NSSize::new(w, h))
    }

    /// First attach builds the shared render resources (NSView + wgpu + glyphon +
    /// quad pipeline); thereafter `activate` just binds/draws a terminal into them.
    fn build_state(app: &tauri::AppHandle, x: f64, y: f64, w: f64, h: f64, scale: f64) -> Option<TermState> {
        let mtm = MainThreadMarker::new()?;
        let window = app.get_webview_window("main")?;
        let win_ptr = match window.ns_window() { Ok(p) => p as *mut NSWindow, Err(e) => { eprintln!("[termview] ns_window: {e}"); return None; } };
        let webview_ptr = match window.ns_view() { Ok(p) => p as *mut NSView, Err(e) => { eprintln!("[termview] ns_view: {e}"); return None; } };
        let ns_window: &NSWindow = unsafe { &*win_ptr };
        let webview_view: &NSView = unsafe { &*webview_ptr };
        let content = ns_window.contentView()?;
        let content_h = content.frame().size.height;

        let view = NSView::initWithFrame(mtm.alloc(), flip_rect(content_h, x, y, w, h));
        view.setWantsLayer(true);
        view.setAutoresizingMask(NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable);
        content.addSubview_positioned_relativeTo(&view, NSWindowOrderingMode::Below, Some(webview_view));

        let mut idesc = wgpu::InstanceDescriptor::new_without_display_handle();
        idesc.backends = wgpu::Backends::METAL;
        let instance = wgpu::Instance::new(idesc);
        let view_ptr = Retained::as_ptr(&view) as *mut std::ffi::c_void;
        let Some(nn) = core::ptr::NonNull::new(view_ptr) else { return None };
        let raw_window = raw_window_handle::RawWindowHandle::AppKit(raw_window_handle::AppKitWindowHandle::new(nn));
        let raw_display = raw_window_handle::RawDisplayHandle::AppKit(raw_window_handle::AppKitDisplayHandle::new());
        let surface = match unsafe {
            instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                raw_display_handle: Some(raw_display),
                raw_window_handle: raw_window,
            })
        } { Ok(s) => s, Err(e) => { eprintln!("[termview] surface: {e}"); return None; } };
        let adapter = match pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::default(),
            force_fallback_adapter: false,
            compatible_surface: Some(&surface),
        })) { Ok(a) => a, Err(e) => { eprintln!("[termview] adapter: {e}"); return None; } };
        let (device, queue) = match pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default())) {
            Ok(dq) => dq, Err(e) => { eprintln!("[termview] device: {e}"); return None; }
        };

        let caps = surface.get_capabilities(&adapter);
        let format = caps.formats[0];
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: ((w * scale) as u32).max(1),
            height: ((h * scale) as u32).max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let cache = Cache::new(&device);
        let mut atlas = TextAtlas::new(&device, &queue, &cache, format);
        let viewport = Viewport::new(&device, &cache);
        let text_renderer = TextRenderer::new(&mut atlas, &device, wgpu::MultisampleState::default(), None);

        // Solid-quad pipeline (cell backgrounds + cursor).
        let quad_uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("term-quad-uniform"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let quad_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: None,
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None },
                count: None,
            }],
        });
        let quad_bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &quad_bgl,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: quad_uniform.as_entire_binding() }],
        });
        let quad_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("term-quad"),
            source: wgpu::ShaderSource::Wgsl(QUAD_WGSL.into()),
        });
        let quad_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&quad_bgl)],
            immediate_size: 0,
        });
        let quad_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("term-quad-pipeline"),
            layout: Some(&quad_layout),
            vertex: wgpu::VertexState {
                module: &quad_shader,
                entry_point: Some("vs"),
                buffers: &[wgpu::VertexBufferLayout {
                    array_stride: 32,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &[
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 0, shader_location: 0 },
                        wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x4, offset: 16, shader_location: 1 },
                    ],
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &quad_shader,
                entry_point: Some("fs"),
                targets: &[Some(format.into())],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let mut font_system = FontSystem::new();
        let swash_cache = SwashCache::new();

        let font_px = (13.0 * scale) as f32;
        let cell_h = (13.0 * 1.2 * scale).round() as f32;
        // Measure the monospace advance once.
        let cell_w = {
            let mut b = Buffer::new(&mut font_system, Metrics::new(font_px, cell_h));
            b.set_text(&mut font_system, "0", &Attrs::new().family(family()), Shaping::Advanced, None);
            b.shape_until_scroll(&mut font_system, false);
            b.layout_runs().next().and_then(|r| r.glyphs.first().map(|g| g.w)).filter(|w| *w > 0.0).unwrap_or(font_px * 0.6)
        };

        Some(TermState {
            view, device, queue, surface, config,
            font_system, swash_cache, atlas, viewport, text_renderer,
            glyph_cache: HashMap::new(),
            quad_pipeline,
            quad_uniform,
            quad_bind,
            cell_w, cell_h, font_px,
            // Use the theme already pushed from JS, so the first frame is themed.
            palette: PENDING_THEME.lock().unwrap().clone().unwrap_or_default(),
            last_render: Instant::now(),
            terms: HashMap::new(),
            active: None,
        })
    }

    fn reposition(st: &mut TermState, app: &tauri::AppHandle, x: f64, y: f64, w: f64, h: f64, scale: f64) {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(p) = window.ns_window() {
                let ns_window: &NSWindow = unsafe { &*(p as *mut NSWindow) };
                if let Some(c) = ns_window.contentView() {
                    st.view.setFrame(flip_rect(c.frame().size.height, x, y, w, h));
                }
            }
        }
        st.config.width = ((w * scale) as u32).max(1);
        st.config.height = ((h * scale) as u32).max(1);
        st.surface.configure(&st.device, &st.config);
    }

    fn new_core(cols: usize, lines: usize) -> TermCore {
        TermCore {
            term: Term::new(Config::default(), &Size { cols, lines }, NoopListener),
            parser: Processor::new(),
            cols,
            lines,
            tail: String::new(),
            dev_port: None,
        }
    }

    /// A dev server's local port from the rolling tail. Matches a localhost URL
    /// directly (`//localhost:PORT`) rather than anchoring on a "Local:" banner —
    /// Claude Code collapses dev-server output and often only prints the URL in its
    /// own prose ("Dev server is running: http://localhost:5273/"). Requiring the
    /// `//` keeps it to actual URLs, not prose like "listening on localhost port".
    fn find_local_port(tail: &str) -> Option<u16> {
        for marker in ["//localhost:", "//127.0.0.1:", "//[::1]:"] {
            let mut from = 0;
            while let Some(rel) = tail[from..].find(marker) {
                let i = from + rel + marker.len();
                let digits: String = tail[i..].chars().take_while(|c| c.is_ascii_digit()).collect();
                if let Ok(p) = digits.parse::<u16>() {
                    if p > 0 {
                        return Some(p);
                    }
                }
                from = i;
            }
        }
        None
    }

    /// The URL under a grid point, if any — for opt+click. Works in COLUMN space
    /// (one char per cell): the click is a cell column, not a byte offset, so a
    /// String + byte-index `find` would desync on any non-ASCII earlier in the row.
    fn url_at(core: &TermCore, point: Point) -> Option<String> {
        use alacritty_terminal::index::{Column, Line};
        let grid = core.term.grid();
        let row = &grid[Line(point.line.0)];
        let click = point.column.0;
        // Prefer an OSC-8 hyperlink attribute on the clicked cell (the visible text
        // may be a label, not the URL).
        if let Some(link) = row[Column(click.min(core.cols.saturating_sub(1)))].hyperlink() {
            return Some(link.uri().to_string());
        }
        let chars: Vec<char> = (0..core.cols).map(|c| row[Column(c)].c).collect();
        let n = chars.len();
        let starts_with = |i: usize, pat: &str| pat.chars().enumerate().all(|(k, pc)| chars.get(i + k) == Some(&pc));
        let mut i = 0;
        while i < n {
            if starts_with(i, "http://") || starts_with(i, "https://") {
                let mut end = i;
                while end < n && !chars[end].is_whitespace() && !"\"'<>()[]`".contains(chars[end]) {
                    end += 1;
                }
                if click >= i && click < end {
                    let url: String = chars[i..end].iter().collect();
                    return Some(url.trim_end_matches(['.', ',', ')', ']']).to_string());
                }
                i = end;
            } else {
                i += 1;
            }
        }
        None
    }

    /// Attach = ensure the render resources exist, then make `id` the active
    /// (drawn) terminal at the given rect. Called on mount and on every tab switch.
    pub fn attach(app: &tauri::AppHandle, id: String, x: f64, y: f64, w: f64, h: f64, scale: f64) {
        {
            let state = app.state::<PocTerminal>();
            let mut guard = state.0.lock().unwrap();
            if guard.is_none() {
                match build_state(app, x, y, w, h, scale) {
                    Some(st) => *guard = Some(st),
                    None => return,
                }
                NATIVE_ACTIVE.store(true, Ordering::Relaxed);
            }
        }

        let state = app.state::<PocTerminal>();
        let mut guard = state.0.lock().unwrap();
        let Some(st) = guard.as_mut() else { return };
        reposition(st, app, x, y, w, h, scale);
        let (cols, lines) = grid_dims(st.config.width, st.config.height, st.cell_w, st.cell_h);
        match st.terms.get_mut(&id) {
            Some(core) if core.cols != cols || core.lines != lines => {
                core.term.resize(Size { cols, lines });
                core.cols = cols;
                core.lines = lines;
            }
            Some(_) => {}
            None => { st.terms.insert(id.clone(), new_core(cols, lines)); }
        }
        resize_pty(app, &id, cols, lines);
        st.active = Some(id);
        render(st);
    }

    pub fn set_rect(app: &tauri::AppHandle, id: String, x: f64, y: f64, w: f64, h: f64, scale: f64) {
        let state = app.state::<PocTerminal>();
        let mut guard = state.0.lock().unwrap();
        let Some(st) = guard.as_mut() else { return };
        // Only the active terminal drives geometry (hidden panes share the rect).
        if st.active.as_deref() != Some(id.as_str()) {
            return;
        }
        reposition(st, app, x, y, w, h, scale);
        let (cols, lines) = grid_dims(st.config.width, st.config.height, st.cell_w, st.cell_h);
        if let Some(core) = st.terms.get_mut(&id) {
            if core.cols != cols || core.lines != lines {
                core.term.resize(Size { cols, lines });
                core.cols = cols;
                core.lines = lines;
                resize_pty(app, &id, cols, lines);
            }
        }
        render(st);
    }

    pub fn feed(app: &tauri::AppHandle, id: &str, bytes: &[u8]) {
        let state = app.state::<PocTerminal>();
        let mut guard = state.0.lock().unwrap();
        let Some(st) = guard.as_mut() else { return };
        if !st.terms.contains_key(id) {
            // Output arrived before this terminal attached — size it to the surface.
            let (cols, lines) = grid_dims(st.config.width, st.config.height, st.cell_w, st.cell_h);
            st.terms.insert(id.to_string(), new_core(cols, lines));
        }
        if let Some(core) = st.terms.get_mut(id) {
            core.parser.advance(&mut core.term, bytes);
            // Sniff a dev-server banner from a rolling RAW tail (raw, not ANSI-
            // stripped, so an OSC-8 hyperlink — URL inside the escape — still matches).
            core.tail.push_str(&String::from_utf8_lossy(bytes));
            if core.tail.len() > 768 {
                let cut = core.tail.len() - 768;
                let cut = (cut..=core.tail.len()).find(|&i| core.tail.is_char_boundary(i)).unwrap_or(core.tail.len());
                core.tail = core.tail.split_off(cut);
            }
            if let Some(port) = find_local_port(&core.tail) {
                if core.dev_port != Some(port) {
                    core.dev_port = Some(port);
                    let _ = app.emit("terminal:devport", serde_json::json!({ "id": id, "port": port }));
                }
            }
        }
        // Only the visible terminal needs to redraw; background grids just parse.
        if st.active.as_deref() != Some(id) {
            return;
        }
        // Throttle to ~60fps under heavy streaming; schedule one trailing render so
        // the final frame of a burst still lands when output goes quiet.
        if st.last_render.elapsed() >= Duration::from_millis(16) {
            render(st);
        } else if !TRAILING.swap(true, Ordering::Relaxed) {
            let app2 = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(20));
                let app3 = app2.clone();
                let _ = app2.run_on_main_thread(move || {
                    TRAILING.store(false, Ordering::Relaxed);
                    let state = app3.state::<PocTerminal>();
                    let mut guard = state.0.lock().unwrap();
                    if let Some(st) = guard.as_mut() {
                        render(st);
                    }
                });
            });
        }
    }

    fn palette_from(t: &super::ThemeColors) -> Palette {
        let mut p = Palette::default();
        let set = |dst: &mut (u8, u8, u8), src: &Option<String>| {
            if let Some(c) = src.as_deref().and_then(parse_hex) { *dst = c; }
        };
        set(&mut p.fg, &t.foreground);
        set(&mut p.bg, &t.background);
        set(&mut p.cursor, &t.cursor);
        set(&mut p.selection, &t.selection_background);
        let names = [
            &t.black, &t.red, &t.green, &t.yellow, &t.blue, &t.magenta, &t.cyan, &t.white,
            &t.bright_black, &t.bright_red, &t.bright_green, &t.bright_yellow,
            &t.bright_blue, &t.bright_magenta, &t.bright_cyan, &t.bright_white,
        ];
        for (i, n) in names.iter().enumerate() {
            set(&mut p.ansi[i], n);
        }
        p
    }

    pub fn set_theme(app: &tauri::AppHandle, t: &super::ThemeColors) {
        let p = palette_from(t);
        *PENDING_THEME.lock().unwrap() = Some(p.clone());
        let state = app.state::<PocTerminal>();
        let mut guard = state.0.lock().unwrap();
        if let Some(st) = guard.as_mut() {
            st.palette = p;
            render(st);
        }
    }

    pub fn scroll(app: &tauri::AppHandle, id: &str, lines: i32) {
        let state = app.state::<PocTerminal>();
        let mut guard = state.0.lock().unwrap();
        let Some(st) = guard.as_mut() else { return };
        if st.active.as_deref() != Some(id) {
            return;
        }
        if let Some(core) = st.terms.get_mut(id) {
            core.term.scroll_display(Scroll::Delta(lines));
        }
        render(st);
    }

    pub fn mouse(app: &tauri::AppHandle, id: &str, kind: &str, x: f64, y: f64, scale: f64, button: u8, alt: bool) {
        let state = app.state::<PocTerminal>();
        let mut guard = state.0.lock().unwrap();
        let Some(st) = guard.as_mut() else { return };
        if st.active.as_deref() != Some(id) {
            return;
        }
        let (cw, chp) = (st.cell_w as f64, st.cell_h as f64);
        let px = x * scale;
        let py = y * scale;
        let Some(core) = st.terms.get_mut(id) else { return };
        let col = ((px / cw).max(0.0) as usize).min(core.cols.saturating_sub(1));
        let row = ((py / chp).max(0.0) as usize).min(core.lines.saturating_sub(1));
        let mode = *core.term.mode();
        let point = viewport_to_point(core.term.grid().display_offset(), Point::new(row, Column(col)));

        // Opt/Alt+click opens a link under the pointer — even when the app grabbed
        // the mouse (mirrors iTerm). Handled on press.
        if alt && kind == "down" {
            if let Some(url) = url_at(core, point) {
                let _ = app.emit("terminal:open-url", url);
            }
            return;
        }

        // When the app grabbed the mouse, forward an SGR report instead of selecting.
        if mode.intersects(TermMode::MOUSE_MODE) {
            let bytes = sgr_mouse(kind, button, col, row, mode.contains(TermMode::SGR_MOUSE));
            drop(guard);
            if !bytes.is_empty() {
                app.state::<Arc<crate::PtyManager>>().write_pty(id, &bytes);
            }
            return;
        }

        let side = if (px % cw) < cw / 2.0 { Side::Left } else { Side::Right };
        let mut do_copy = None;
        match kind {
            "down" => core.term.selection = Some(Selection::new(SelectionType::Simple, point, side)),
            "move" => { if let Some(sel) = core.term.selection.as_mut() { sel.update(point, side); } }
            "up" => { do_copy = core.term.selection_to_string(); }
            _ => {}
        }
        render(st);
        if let Some(text) = do_copy {
            if !text.is_empty() {
                set_clipboard(&text);
            }
        }
    }

    pub fn detach(app: &tauri::AppHandle, id: &str) {
        let state = app.state::<PocTerminal>();
        let mut guard = state.0.lock().unwrap();
        let Some(st) = guard.as_mut() else { return };
        st.terms.remove(id);
        if st.active.as_deref() == Some(id) {
            st.active = None;
        }
    }
}

// --- Public commands --------------------------------------------------------

#[cfg(target_os = "macos")]
pub use imp::PocTerminal;

/// Off-macOS placeholder so lib.rs state registration compiles everywhere.
#[cfg(not(target_os = "macos"))]
#[derive(Default)]
pub struct PocTerminal;

#[tauri::command]
pub fn poc_attach_termview(app: tauri::AppHandle, id: String, x: f64, y: f64, w: f64, h: f64, scale: f64) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || imp::attach(&app2, id, x, y, w, h, scale));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id, x, y, w, h, scale);
}

#[tauri::command]
pub fn poc_set_rect(app: tauri::AppHandle, id: String, x: f64, y: f64, w: f64, h: f64, scale: f64) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || imp::set_rect(&app2, id, x, y, w, h, scale));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id, x, y, w, h, scale);
}

/// Terminal colors from the active JS theme (xterm `ITheme` field names).
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ThemeColors {
    pub foreground: Option<String>,
    pub background: Option<String>,
    pub cursor: Option<String>,
    pub selection_background: Option<String>,
    pub black: Option<String>,
    pub red: Option<String>,
    pub green: Option<String>,
    pub yellow: Option<String>,
    pub blue: Option<String>,
    pub magenta: Option<String>,
    pub cyan: Option<String>,
    pub white: Option<String>,
    pub bright_black: Option<String>,
    pub bright_red: Option<String>,
    pub bright_green: Option<String>,
    pub bright_yellow: Option<String>,
    pub bright_blue: Option<String>,
    pub bright_magenta: Option<String>,
    pub bright_cyan: Option<String>,
    pub bright_white: Option<String>,
}

#[tauri::command]
pub fn poc_set_theme(app: tauri::AppHandle, theme: ThemeColors) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || imp::set_theme(&app2, &theme));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, theme);
}

#[tauri::command]
pub fn poc_scroll(app: tauri::AppHandle, id: String, lines: i32) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || imp::scroll(&app2, &id, lines));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id, lines);
}

#[tauri::command]
pub fn poc_mouse(app: tauri::AppHandle, id: String, kind: String, x: f64, y: f64, scale: f64, button: u8, alt: bool) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || imp::mouse(&app2, &id, &kind, x, y, scale, button, alt));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id, kind, x, y, scale, button, alt);
}

#[tauri::command]
pub fn poc_detach(app: tauri::AppHandle, id: String) {
    #[cfg(target_os = "macos")]
    {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || imp::detach(&app2, &id));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id);
}
