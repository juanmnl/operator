// Redlines and the layout grid, drawn INSIDE the previewed page by Operator's native inspect view.
// Injected after preview-inspector.js, in Electron only (the Tauri shell never loads it). Nothing
// the renderer draws can paint above that view, so anything shown over the page while the view is
// up has to come from in here.
//
// The math is not in this file. The main process first defines `window.__operatorOverlayFns` from
// the renderer's own functions turned into source (`layoutGrid` from src/shared/layout-grid.ts;
// `measureBetween`, `formatPx`, `placeChip` from src/shared/redlines.ts), so the page and the
// renderer cannot disagree about a column or a distance.
//
// The page is scaled to the stage's scale (device emulation), so it lays out at the device preset and
// getBoundingClientRect reports that layout's CSS px, which are the numbers to show. The lines and
// chips are drawn in the zoomed page too, so every size below is divided by `scale` to stay 1px and
// 10px on screen.
(function () {
  if (window.__operatorOverlay) return;
  var F = window.__operatorOverlayFns;
  if (!F) return;
  var nextFrame = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (f) { return setTimeout(f, 16); };
  var cfg = {
    scale: 1, inspect: false, redlines: false, grid: null,
    tokens: { measure: '#c98bff', measureInk: '#c98bff', grid: '#ff5f56', surface: '#161b21', fg: '#eef1f3', border: '#21272f' },
  };
  var host = null, gridLayer = null, redLayer = null;
  var anchor = null, anchorSel = null, hover = null, lastX = -1, lastY = -1, frame = 0;

  function ensure() {
    if (host && host.isConnected) return true;
    if (!document.documentElement) return false;
    host = document.createElement('div');
    host.setAttribute('data-operator-overlay', '');
    host.style.cssText = 'position:fixed;inset:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483645';
    // A shadow root, so the page's own CSS (a global `div { ... }`) cannot restyle the drawing.
    var root = host.attachShadow({ mode: 'open' });
    gridLayer = document.createElement('div');
    redLayer = document.createElement('div');
    gridLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    redLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    root.appendChild(gridLayer);
    root.appendChild(redLayer);
    document.documentElement.appendChild(host);
    return true;
  }
  /** Screen px → CSS px of the zoomed page. */
  function s(v) { return (v / cfg.scale) + 'px'; }
  function div(layer, css) {
    var d = document.createElement('div');
    d.style.cssText = 'position:absolute;box-sizing:border-box;' + css;
    layer.appendChild(d);
    return d;
  }
  function tint(color, pct) { return 'color-mix(in srgb, ' + color + ' ' + pct + '%, transparent)'; }
  function viewW() { return document.documentElement.clientWidth; }
  function viewH() { return document.documentElement.clientHeight; }

  // ---- The layout grid --------------------------------------------------------------------------
  function drawGrid() {
    if (!ensure()) return;
    gridLayer.textContent = '';
    if (!cfg.grid) return;
    // clientWidth, not innerWidth: the page's own viewport without its scrollbar.
    var g = F.layoutGrid(cfg.grid, viewW());
    if (!g.cols.length) return;
    // The spec's own colour and fill when it has them, the theme's --grid at 10% when not. An
    // older main process that does not define gridInk still draws the theme colour at 10%.
    var ink = F.gridInk ? F.gridInk(cfg.grid, cfg.tokens.grid) : { fill: tint(cfg.tokens.grid, 10), edge: tint(cfg.tokens.grid, 45) };
    for (var i = 0; i < g.cols.length; i++) {
      div(gridLayer, 'top:0;bottom:0;left:' + g.cols[i].left + 'px;width:' + g.cols[i].width + 'px;background:' + ink.fill);
    }
    if (g.clamped) {
      var edge = s(1) + ' dashed ' + ink.edge;
      div(gridLayer, 'top:0;bottom:0;width:0;left:' + g.containerLeft + 'px;border-left:' + edge);
      div(gridLayer, 'top:0;bottom:0;width:0;left:' + (g.containerLeft + g.containerW) + 'px;border-left:' + edge);
    }
  }

  // ---- Redlines ---------------------------------------------------------------------------------
  /** An element to measure, or null for our own UI, the root and body, and the inspector's card. */
  function usable(n) {
    if (n && n.nodeType !== 1) n = n.parentElement;
    if (!n || n === host || n === document.documentElement || n === document.body) return null;
    if (n.closest && n.closest('#__op_compose')) return null;
    return n;
  }
  function boxOf(n) {
    var r = n.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  /** The nearest ancestor whose border box differs from the element's (wrappers of the same size are
   *  skipped), measured to its PADDING-box edge. Nothing qualifies → the viewport. */
  function containerOf(n) {
    var r = boxOf(n);
    for (var p = n.parentElement; p; p = p.parentElement) {
      var q = boxOf(p);
      if (q.left !== r.left || q.top !== r.top || q.right !== r.right || q.bottom !== r.bottom) {
        var cs = getComputedStyle(p);
        return {
          left: q.left + (parseFloat(cs.borderLeftWidth) || 0),
          top: q.top + (parseFloat(cs.borderTopWidth) || 0),
          right: q.right - (parseFloat(cs.borderRightWidth) || 0),
          bottom: q.bottom - (parseFloat(cs.borderBottomWidth) || 0),
        };
      }
    }
    return { left: 0, top: 0, right: viewW(), bottom: viewH() };
  }
  /** A surface chip: the only way a number stays readable over an arbitrary page. */
  function chip(text) {
    var c = div(redLayer,
      'white-space:nowrap;font:600 ' + s(10) + '/1.25 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'font-variant-numeric:tabular-nums;padding:' + s(1) + ' ' + s(4) + ';border-radius:' + s(3) + ';' +
      'border:' + s(1) + ' solid ' + cfg.tokens.measure + ';background:' + cfg.tokens.surface + ';color:' + cfg.tokens.measureInk);
    c.textContent = text;
    var r = c.getBoundingClientRect();
    return { node: c, w: r.width, h: r.height };
  }
  function place(c, left, top) { c.node.style.left = left + 'px'; c.node.style.top = top + 'px'; }

  function outline(n, anchored) {
    var b = boxOf(n);
    div(redLayer,
      'left:' + b.left + 'px;top:' + b.top + 'px;width:' + (b.right - b.left) + 'px;height:' + (b.bottom - b.top) + 'px;' +
      'border:' + s(1) + ' solid ' + cfg.tokens.measure + ';' + (anchored ? 'background:' + tint(cfg.tokens.measure, 8) : ''));
    var c = chip(F.formatPx(b.right - b.left) + ' × ' + F.formatPx(b.bottom - b.top));
    // Above the box's top-left corner, or below the box when there is no room above.
    var top = b.top - c.h - 2 / cfg.scale;
    if (top < 0) top = b.bottom + 2 / cfg.scale;
    place(c, Math.max(0, Math.min(b.left, viewW() - c.w)), Math.max(0, Math.min(top, viewH() - c.h)));
  }

  function segment(g) {
    var t = 1 / cfg.scale, tick = 4 / cfg.scale;
    var horizontal = g.y1 === g.y2;
    var x = Math.min(g.x1, g.x2), y = Math.min(g.y1, g.y2);
    var len = horizontal ? Math.abs(g.x2 - g.x1) : Math.abs(g.y2 - g.y1);
    if (g.value === null) {
      // A dashed extension along the other box's edge, to meet a line that runs past it.
      var dash = t + 'px dashed ' + tint(cfg.tokens.measure, 55);
      if (horizontal) div(redLayer, 'left:' + x + 'px;top:' + (y - t / 2) + 'px;width:' + len + 'px;height:0;border-top:' + dash);
      else div(redLayer, 'left:' + (x - t / 2) + 'px;top:' + y + 'px;width:0;height:' + len + 'px;border-left:' + dash);
      return;
    }
    var ink = 'background:' + cfg.tokens.measure;
    if (horizontal) {
      div(redLayer, 'left:' + x + 'px;top:' + (y - t / 2) + 'px;width:' + len + 'px;height:' + t + 'px;' + ink);
      div(redLayer, 'left:' + (x - t / 2) + 'px;top:' + (y - tick / 2) + 'px;width:' + t + 'px;height:' + tick + 'px;' + ink);
      div(redLayer, 'left:' + (x + len - t / 2) + 'px;top:' + (y - tick / 2) + 'px;width:' + t + 'px;height:' + tick + 'px;' + ink);
    } else {
      div(redLayer, 'left:' + (x - t / 2) + 'px;top:' + y + 'px;width:' + t + 'px;height:' + len + 'px;' + ink);
      div(redLayer, 'left:' + (x - tick / 2) + 'px;top:' + (y - t / 2) + 'px;width:' + tick + 'px;height:' + t + 'px;' + ink);
      div(redLayer, 'left:' + (x - tick / 2) + 'px;top:' + (y + len - t / 2) + 'px;width:' + tick + 'px;height:' + t + 'px;' + ink);
    }
    var c = chip(F.formatPx(g.value));
    var p = F.placeChip(g, c.w, c.h, viewW(), viewH());
    place(c, p.left, p.top);
  }

  function drawRedlines() {
    if (!ensure()) return;
    redLayer.textContent = '';
    if (!cfg.redlines) return;
    // HMR replaces nodes. An anchor that left the document is found again by its selector, or cleared.
    if (anchor && !anchor.isConnected) {
      var again = null;
      try { again = anchorSel ? document.querySelector(anchorSel) : null; } catch (e) { again = null; }
      if (again) anchor = again; else setAnchor(null);
    }
    if (hover && !hover.isConnected) hover = null;
    var other = hover && hover !== anchor ? hover : null;
    var list, i;
    if (anchor && other) {
      outline(anchor, true);
      outline(other, false);
      list = F.measureBetween(boxOf(anchor), boxOf(other));
    } else {
      var n = anchor || hover;
      if (!n) return;
      outline(n, !!anchor);
      list = F.measureBetween(boxOf(n), containerOf(n));
    }
    for (i = 0; i < list.length; i++) segment(list[i]);
  }

  function tick() {
    frame = 0;
    drawRedlines();
    // While anchored the page can move under a still pointer (animation, HMR, late content), so
    // follow it every frame. Not while the page is hidden.
    if (anchor && cfg.redlines && !document.hidden) frame = nextFrame(tick);
  }
  function schedule() { if (!frame) frame = nextFrame(tick); }

  function setAnchor(n) {
    var had = !!anchor;
    anchor = n;
    anchorSel = null;
    var ins = window.__operatorInspector;
    if (n && ins && typeof ins.selector === 'function') {
      try { anchorSel = ins.selector(n); } catch (e) { anchorSel = null; }
    }
    if (had !== !!n && typeof window.__operatorAnchorBridge === 'function') window.__operatorAnchorBridge(!!n);
    schedule();
  }

  window.addEventListener('mousemove', function (e) {
    lastX = e.clientX; lastY = e.clientY;
    if (!cfg.redlines) return;
    hover = usable(e.target);
    schedule();
  }, true);
  document.addEventListener('mouseleave', function () {
    hover = null;
    if (cfg.redlines) schedule();
  });
  window.addEventListener('scroll', function () {
    if (!cfg.redlines) return;
    if (document.elementFromPoint && lastX >= 0) hover = usable(document.elementFromPoint(lastX, lastY));
    schedule();
  }, true);
  window.addEventListener('resize', function () {
    drawGrid();
    if (cfg.redlines) schedule();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && cfg.redlines) schedule();
  });

  // ⌥-CLICK sets the anchor, or clears it (on the anchor itself, or on empty space). The whole press
  // is captured on WINDOW, which runs before the page's own listeners and before the inspector's
  // (on document), so neither the app nor the compose card ever sees it.
  function onAltPress(e) {
    if (!cfg.redlines || !e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    var n = usable(e.target);
    setAnchor(n && n !== anchor ? n : null);
  }
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'dblclick'].forEach(function (type) {
    window.addEventListener(type, onAltPress, true);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || !cfg.redlines || !anchor) return;
    // The inspector's compose card owns Esc while it is open.
    if (e.target && e.target.closest && e.target.closest('#__op_compose')) return;
    e.preventDefault();
    e.stopPropagation();
    setAnchor(null);
  }, true);

  function configure(next) {
    cfg = next;
    if (!cfg.redlines) { hover = null; if (anchor) setAnchor(null); }
    var ins = window.__operatorInspector;
    if (ins && typeof ins.configure === 'function') ins.configure({ enabled: !!cfg.inspect, colors: cfg.tokens, scale: cfg.scale });
    drawGrid();
    drawRedlines();
  }

  window.__operatorOverlay = {
    configure: configure,
    clearAnchor: function () { if (anchor) setAnchor(null); },
    redlinesOn: function () { return !!cfg.redlines; },
    // The anchor, for the note the inspector composes: the node, its box in CSS px of the preset
    // layout, and a name a person would recognise (the component, else tag#id.class).
    anchorInfo: function () {
      if (!cfg.redlines || !anchor || !anchor.isConnected) return null;
      var ins = window.__operatorInspector, nm = null;
      if (ins && typeof ins.label === 'function') { try { nm = ins.label(anchor); } catch (e) { nm = null; } }
      return { node: anchor, box: boxOf(anchor), name: nm || anchor.tagName.toLowerCase() };
    },
    redraw: function () { drawGrid(); drawRedlines(); },
  };
})();
