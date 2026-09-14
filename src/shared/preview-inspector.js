(function () {
  if (window.__operatorInspector) return;
  // The page-side API. `selector` is shared with preview-overlay.js (it re-finds a redline anchor
  // after HMR); `configure` is how Operator switches the inspector on and off and hands it the
  // palette. Function declarations, so they exist here already.
  window.__operatorInspector = { selector: selector, configure: configure, label: label };
  var box, label;
  // Off when the native view is only hosting redlines or the grid (Interact mode): no hover outline,
  // and clicks reach the app. A shell that never calls `configure` (Tauri) keeps it on.
  var enabled = true;
  // The page's emulated scale (the stage's scale). The card and the label are counter-scaled by it so
  // they stay their real size on screen when a wide device preset is scaled down to fit.
  var scale = 1;
  // Colours. These defaults are the inspector's original palette, kept for a shell that never
  // configures it; Operator passes its own resolved tokens.
  var C = {
    line: '#7ee787', lineSoft: 'rgba(126,231,135,0.4)', fill: 'rgba(126,231,135,0.12)', ink: '#7ee787',
    ground: '#0b0d10', edge: '#2a2a35', field: '#15171c', fg: '#e6e6e6', dim: '#8a8f98',
  };
  function configure(o) {
    if (!o) return;
    if (typeof o.scale === 'number' && o.scale > 0) scale = o.scale;
    if (o.colors) {
      var t = o.colors;
      C = {
        line: t.measure, lineSoft: 'color-mix(in srgb, ' + t.measure + ' 40%, transparent)',
        fill: 'color-mix(in srgb, ' + t.measure + ' 12%, transparent)', ink: t.measureInk,
        ground: t.surface, edge: t.border, field: 'color-mix(in srgb, ' + t.fg + ' 6%, ' + t.surface + ')',
        fg: t.fg, dim: 'color-mix(in srgb, ' + t.fg + ' 72%, ' + t.surface + ')',
      };
      paint();
    }
    if (typeof o.enabled === 'boolean') {
      enabled = o.enabled;
      if (!enabled) { hide(); removeCompose(); }
    }
  }
  function paint() {
    if (!box) return;
    box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:' + (2 / scale) + 'px solid ' + C.line + ';background:' + C.fill + ';border-radius:2px;display:none;transition:all 45ms ease-out';
    label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;background:' + C.ground + ';color:' + C.ink + ';padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.4);transform:scale(' + (1 / scale) + ');transform-origin:top left';
  }
  function mk() {
    box = document.createElement('div');
    label = document.createElement('div');
    paint();
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(label);
  }
  function hide() { if (box) { box.style.display = 'none'; label.style.display = 'none'; } }
  /** Redlines draw their own outline of the hovered element; two outlines on one element is noise. */
  function redlinesDrawing() { return !!(window.__operatorOverlay && window.__operatorOverlay.redlinesOn()); }
  function name(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (el.className && typeof el.className === 'string') {
      var c = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (c.length) s += '.' + c.join('.');
    }
    return s;
  }
  function selector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var t = el.tagName.toLowerCase(), sib = el, nth = 1;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) nth++;
      parts.unshift(t + ':nth-of-type(' + nth + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function fiber(el) {
    for (var k in el) if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return el[k];
    return null;
  }
  function source(el) {
    var f = fiber(el), comp = null, src = null;
    while (f) {
      if (!src && f._debugSource) src = f._debugSource;
      if (!comp && typeof f.type === 'function') comp = f.type.displayName || f.type.name || null;
      if (src && comp) break;
      f = f._debugOwner || f.return;
    }
    return { component: comp, source: src ? (src.fileName + ':' + src.lineNumber) : null };
  }
  /** What a note calls an element: its React component when there is one, else tag#id.class. The
   *  overlay names a redline anchor with it. */
  function label(el) { return source(el).component || name(el); }
  // Send the picked element + note back to Operator. A remote embedded webview can't route command
  // IPC (the ACL denies it) — but a request to our registered custom scheme is never ACL-gated. So
  // we beacon via an <img> to operatorpick://, URL-safe-base64-encoding the JSON payload.
  function b64(str) { return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function beacon(data, onOk, onFail) {
    // A HOST-PROVIDED CHANNEL WINS. Under Tauri there is none and the image beacon below is the
    // only way out of a remote embedded webview (command IPC is ACL-denied there). Electron's
    // embedded view gets a preload, so it installs `__operatorBeacon` and this defers to it.
    if (typeof window.__operatorBeacon === 'function') { window.__operatorBeacon(data, onOk, onFail); return; }
    try {
      var im = new Image();
      im.onload = onOk; im.onerror = onFail;
      im.src = 'operatorpick://ipc?d=' + b64(JSON.stringify(data)) + '&t=' + Date.now();
    } catch (e) { onFail(); }
  }
  // ---- Floating compose card next to the clicked element (annotate-style, not a bottom bar).
  var composing = false;
  function removeCompose() { var c = document.getElementById('__op_compose'); if (c) c.remove(); composing = false; }
  function showCompose(el) {
    removeCompose(); composing = true;
    hide();
    var s = source(el), r = el.getBoundingClientRect();
    var data = {
      selector: selector(el), tag: el.tagName.toLowerCase(),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      component: s.component, source: s.source, route: location.pathname, message: '',
    };
    // A REDLINE ANCHOR goes into the note, so "make this gap 24" arrives with the gap it has now.
    // Only in Electron, where the overlay and its functions exist; only for an element other than
    // the anchor itself.
    var ov = window.__operatorOverlay, fns = window.__operatorOverlayFns;
    var an = ov && typeof ov.anchorInfo === 'function' ? ov.anchorInfo() : null;
    if (an && an.node !== el && fns && typeof fns.describeRelation === 'function') {
      data.measurement = fns.describeRelation({ left: r.left, top: r.top, right: r.right, bottom: r.bottom }, an.box, an.name);
    }
    var card = document.createElement('div');
    card.id = '__op_compose';
    // Scaled by 1/scale so the card keeps its size on screen in a zoomed-out page. Its footprint in
    // page px is then W and H times 1/scale, which is what the edge clamps below use.
    var k = 1 / scale, W = 288, H = data.measurement ? 148 : 130;
    var left = Math.min(Math.max(8, r.left), window.innerWidth - W * k - 8);
    var top = r.bottom + 8; if (top > window.innerHeight - H * k) top = Math.max(8, r.top - H * k);
    card.style.cssText = 'position:fixed;left:' + left + 'px;top:' + top + 'px;width:' + W + 'px;z-index:2147483647;box-sizing:border-box;background:' + C.ground + ';border:1px solid ' + C.edge + ';border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,0.55);transform:scale(' + k + ');transform-origin:top left';
    var chip = document.createElement('div');
    chip.textContent = '⧉ ' + (data.component || data.tag) + (data.source ? ' @ ' + data.source.split('/').pop() : '');
    chip.title = data.source || data.selector;
    chip.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace;color:' + C.ink;
    var inp = document.createElement('textarea');
    inp.placeholder = 'What should change about this element?';
    inp.rows = 2;
    inp.style.cssText = 'width:100%;box-sizing:border-box;resize:none;font:13px ui-sans-serif,system-ui;background:' + C.field + ';color:' + C.fg + ';border:1px solid ' + C.edge + ';border-radius:6px;outline:none;padding:6px 8px';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px';
    // Both buttons are transparent; the primary one has the full-strength edge. An accent-filled
    // button needs the ground colour as its label, which fails contrast on some palettes.
    function mkBtn(txt, primary) {
      var b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'font:600 11px ui-sans-serif;border-radius:6px;padding:6px 10px;cursor:pointer;background:transparent;color:' + C.ink + ';border:1px solid ' + (primary ? C.line : C.lineSoft);
      return b;
    }
    var toConsole = mkBtn('→ Console', false);
    var toTasks = mkBtn('→ Tasks', true);
    var spacer = document.createElement('span'); spacer.style.cssText = 'flex:1';
    var cancel = document.createElement('button');
    cancel.textContent = '✕';
    cancel.style.cssText = 'color:' + C.dim + ';background:transparent;border:none;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px';
    function submit(target) {
      data.message = inp.value.trim(); data.target = target;
      toConsole.disabled = toTasks.disabled = true;
      beacon(data,
        function () { removeCompose(); },
        function () { chip.textContent = '✗ could not reach Operator'; chip.style.color = '#ff6b6b'; toConsole.disabled = toTasks.disabled = false; });
    }
    toConsole.onclick = function () { submit('console'); };
    toTasks.onclick = function () { submit('tasks'); };
    cancel.onclick = removeCompose;
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit('tasks'); }
      else if (ev.key === 'Escape') { ev.preventDefault(); removeCompose(); }
    });
    row.appendChild(toConsole); row.appendChild(toTasks); row.appendChild(spacer); row.appendChild(cancel);
    card.appendChild(chip);
    if (data.measurement) {
      var meas = document.createElement('div');
      meas.setAttribute('data-op-measurement', '');
      meas.textContent = data.measurement;
      meas.title = data.measurement;
      meas.style.cssText = 'margin-top:-4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 10.5px ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;color:' + C.dim;
      card.appendChild(meas);
    }
    card.appendChild(inp); card.appendChild(row);
    document.documentElement.appendChild(card);
    inp.focus();
  }
  if (document.body) mk(); else document.addEventListener('DOMContentLoaded', mk);
  document.addEventListener('mousemove', function (e) {
    if (!box || composing) return;
    if (!enabled || redlinesDrawing()) { hide(); return; }
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label) { hide(); return; }
    var r = el.getBoundingClientRect();
    box.style.display = 'block'; box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    label.textContent = name(el); label.style.borderColor = ''; label.style.color = C.ink;
    label.style.display = 'block'; label.style.left = r.left + 'px'; label.style.top = Math.max(0, r.top - 20 / scale) + 'px';
  }, true);
  // Click SELECTS the element (doesn't activate the app) and opens the in-window compose bar.
  document.addEventListener('click', function (e) {
    if (!box || composing || !enabled) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === label) return;
    e.preventDefault(); e.stopPropagation();
    showCompose(el);
  }, true);
})();
