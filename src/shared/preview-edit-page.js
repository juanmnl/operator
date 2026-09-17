// CSS controls (v1), the in-page half. Injected into the Preview iframe after preview-inspector.js
// and preview-overlay.js (electron/src/main/preview-inspect.ts). The pure functions it uses arrive as
// `window.__operatorEditFns` (electron/src/main/edit-fns.ts, from src/shared/preview-edit.ts).
//
//   select(el, meta)  the inspector calls this on a pick: the element is tagged `data-op-edit=<uid>`
//                     and its computed values are recorded as BEFORE.
//   commands          from the parent window only (`event.source === window.parent`), tagged
//                     `__operatorEditCmd`: set, undo, reset, resetAll, deselect, capture, refresh.
//   state             posted to the parent after every change, tagged `__operatorEdit`.
//
// Edits live in one <style id="__op_edits">, rules on `[data-op-edit="<uid>"]` (see editRules).
// Nothing is persisted: a reload returns the page to its source, which is what "reset" means once
// the changes have been sent and made in code.
//
// DRAG HANDLES on the picked element's box: one bar per side for padding (inside the border edge) and
// one per side for margin (outside it). They are the only things here that take the pointer, and only
// while an element is selected.
(function () {
  if (window.__operatorEdit) return;
  var F = window.__operatorEditFns;
  if (!F) return;
  var STATE = '__operatorEdit', CMD = '__operatorEditCmd';
  var raf = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : function (f) { return setTimeout(f, 16); };
  var caf = window.cancelAnimationFrame ? window.cancelAnimationFrame.bind(window) : clearTimeout;
  var PROPS = ['margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'width', 'height', 'background-color', 'color', 'border-color', 'border-radius', 'opacity'];
  var edits = {}, order = [], active = null, seq = 0, styleEl = null, tokenCache = null;
  var host = null, layer = null, capturing = false, drag = null, frame = 0, justDragged = false;

  function uidNew() { seq += 1; return 'e' + Date.now().toString(36) + seq; }
  function elOf(uid) { return document.querySelector('[data-op-edit="' + uid + '"]'); }
  function snapshot(el) {
    var cs = getComputedStyle(el), o = {};
    for (var i = 0; i < PROPS.length; i++) o[PROPS[i]] = cs.getPropertyValue(PROPS[i]).trim();
    return o;
  }
  function write() {
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.getElementById('__op_edits') || document.createElement('style');
      styleEl.id = '__op_edits';
      (document.head || document.documentElement).appendChild(styleEl);
    }
    styleEl.textContent = F.editRules(order.map(function (u) { return { uid: u, values: edits[u].values }; }));
  }

  /** Every `--*` custom property on :root whose value resolves to a colour. Resolved through a probe
   *  element, so `--brand: var(--blue-500)` compares as the colour it ends up as. */
  function tokens() {
    if (tokenCache) return tokenCache;
    var out = [], seen = {};
    var probe = document.createElement('span');
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
    document.documentElement.appendChild(probe);
    try {
      var cs = getComputedStyle(document.documentElement);
      for (var i = 0; i < cs.length && out.length < 400; i++) {
        var name = cs[i];
        if (name.indexOf('--') !== 0 || seen[name]) continue;
        seen[name] = true;
        probe.style.color = '';
        probe.style.color = 'var(' + name + ')';
        var raw = cs.getPropertyValue(name).trim();
        if (!raw) continue;
        var got = getComputedStyle(probe).color;
        // A token that is not a colour leaves the probe at its inherited colour; only keep those whose
        // raw value looks like a colour or a reference to one.
        if (!/^(#|rgb|hsl|oklch|oklab|lab|lch|color\(|var\()/i.test(raw) && !/^[a-z]+$/i.test(raw)) continue;
        out.push({ name: name, value: got });
      }
    } catch (e) { /* no tokens */ }
    probe.remove();
    tokenCache = out;
    return out;
  }

  function fiberOf(el) {
    for (var k in el) if (k.indexOf('__reactFiber$') === 0) return el[k];
    return null;
  }
  /** React 19 has no `_debugSource`; its `_debugStack` still names the file (no reliable line). */
  function fallbackSource(el) {
    var f = fiberOf(el), n = 0;
    while (f && n++ < 40) {
      if (f._debugStack && f._debugStack.stack) {
        var s = F.sourceFromDebugStack(f._debugStack.stack);
        if (s) return s;
      }
      f = f._debugOwner || f.return;
    }
    return null;
  }

  function info(uid) {
    var e = edits[uid], el = elOf(uid), r = el ? el.getBoundingClientRect() : null;
    return {
      uid: uid, label: e.label, component: e.component, source: e.source, selector: e.selector,
      route: location.pathname, before: e.before, values: e.values,
      current: el ? snapshot(el) : null, history: e.history.length,
      box: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null,
    };
  }
  function post() {
    var m = {}; m[STATE] = 'state';
    m.data = JSON.stringify({ active: active && edits[active] ? info(active) : null, count: order.length, tokens: tokens() });
    try { window.parent.postMessage(m, '*'); } catch (e) { /* no parent */ }
  }

  function select(el, meta) {
    if (!el || el.nodeType !== 1) return;
    var uid = el.getAttribute('data-op-edit');
    if (!uid || !edits[uid]) {
      uid = uid || uidNew();
      el.setAttribute('data-op-edit', uid);
      var ins = window.__operatorInspector;
      edits[uid] = {
        uid: uid,
        selector: (meta && meta.selector) || (ins && ins.selector ? ins.selector(el) : ''),
        label: (meta && (meta.component || meta.tag)) || el.tagName.toLowerCase(),
        component: (meta && meta.component) || null,
        source: (meta && meta.source) || fallbackSource(el),
        before: snapshot(el), values: {}, history: [],
      };
      order.push(uid);
    }
    active = uid;
    ensureHandles();
    tick();
    post();
  }

  function set(uid, prop, value, live) {
    var e = edits[uid];
    if (!e || PROPS.indexOf(prop) < 0) return;
    if (!live) e.history.push({ prop: prop, prev: drag && drag.uid === uid && drag.prop === prop ? drag.start : e.values[prop] });
    if (value == null || value === '') delete e.values[prop]; else e.values[prop] = String(value);
    write();
    if (!live) post();
  }
  function undo(uid) {
    var e = edits[uid];
    if (!e || !e.history.length) return;
    var h = e.history.pop();
    if (h.prev == null) delete e.values[h.prop]; else e.values[h.prop] = h.prev;
    write(); post();
  }
  function reset(uid) {
    var e = edits[uid];
    if (!e) return;
    e.values = {}; e.history = [];
    write(); post();
  }
  function resetAll() {
    for (var i = 0; i < order.length; i++) { var el = elOf(order[i]); if (el) el.removeAttribute('data-op-edit'); }
    edits = {}; order = []; active = null;
    write(); post();
  }

  // ── handles ──────────────────────────────────────────────────────────────────────────────────
  function ensureHandles() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.setAttribute('data-operator-edit', '');
    host.style.cssText = 'position:fixed;inset:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483644';
    var root = host.attachShadow({ mode: 'open' });
    layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    root.appendChild(layer);
    document.documentElement.appendChild(host);
    tick();
  }
  var SIDES = ['top', 'right', 'bottom', 'left'];
  function px(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function draw() {
    if (!layer) return;
    layer.textContent = '';
    var el = active && elOf(active);
    if (!el || capturing) return;
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    var outline = document.createElement('div');
    outline.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;border:1px dashed #2fe39a;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
    layer.appendChild(outline);
    for (var i = 0; i < 4; i++) {
      var side = SIDES[i];
      bar('padding-' + side, side, r, px(cs.getPropertyValue('border-' + side + '-width')) + px(cs.getPropertyValue('padding-' + side)), true, '#2fe39a');
      bar('margin-' + side, side, r, px(cs.getPropertyValue('margin-' + side)), false, '#ffb454');
    }
  }
  /** One handle: a short bar across the middle of a side, at the padding's inner edge (inside) or the
   *  margin's outer edge (outside). Dragging it away from the content grows the value. */
  function bar(prop, side, r, dist, inside, colour) {
    var b = document.createElement('div'), L = 22, T = 6;
    var horiz = side === 'top' || side === 'bottom';
    var x, y;
    if (side === 'top') { x = r.left + r.width / 2 - L / 2; y = inside ? r.top + dist - T / 2 : r.top - dist - T / 2; }
    else if (side === 'bottom') { x = r.left + r.width / 2 - L / 2; y = inside ? r.bottom - dist - T / 2 : r.bottom + dist - T / 2; }
    else if (side === 'left') { x = inside ? r.left + dist - T / 2 : r.left - dist - T / 2; y = r.top + r.height / 2 - L / 2; }
    else { x = inside ? r.right - dist - T / 2 : r.right + dist - T / 2; y = r.top + r.height / 2 - L / 2; }
    b.title = prop;
    b.style.cssText = 'position:absolute;pointer-events:auto;border-radius:3px;background:' + colour + ';box-shadow:0 0 0 1px rgba(0,0,0,0.35);'
      + 'left:' + x + 'px;top:' + y + 'px;width:' + (horiz ? L : T) + 'px;height:' + (horiz ? T : L) + 'px;cursor:' + (horiz ? 'ns-resize' : 'ew-resize');
    b.addEventListener('mousedown', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      var el = elOf(active);
      if (!el) return;
      var start = edits[active].values[prop];
      drag = { uid: active, prop: prop, side: side, inside: inside, x: ev.clientX, y: ev.clientY, base: px(getComputedStyle(el).getPropertyValue(prop)), start: start };
    }, true);
    layer.appendChild(b);
  }
  function onMove(ev) {
    if (!drag) return;
    ev.preventDefault(); ev.stopPropagation();
    var d = drag.side === 'top' ? ev.clientY - drag.y : drag.side === 'bottom' ? drag.y - ev.clientY
      : drag.side === 'left' ? ev.clientX - drag.x : drag.x - ev.clientX;
    // Padding grows as its handle moves INTO the box; margin grows as its handle moves away from it.
    var delta = drag.inside ? d : -d;
    var next = Math.max(drag.prop.indexOf('padding') === 0 ? 0 : -9999, Math.round(drag.base + delta));
    set(drag.uid, drag.prop, next + 'px', true);
  }
  function onUp(ev) {
    if (!drag) return;
    ev.preventDefault(); ev.stopPropagation();
    var e = edits[drag.uid], value = e && e.values[drag.prop];
    if (e && value !== drag.start) {
      // One history entry for the whole drag, restoring what was set before it began.
      e.history.push({ prop: drag.prop, prev: drag.start });
    }
    drag = null;
    // The click that ends a drag must not reach the inspector, which would pick whatever is under it.
    justDragged = true;
    setTimeout(function () { justDragged = false; }, 0);
    post();
  }
  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('mouseup', onUp, true);
  window.addEventListener('click', function (ev) {
    if (!justDragged && !(ev.target && ev.target.hasAttribute && ev.target.hasAttribute('data-operator-edit'))) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
  }, true);
  // The handles follow the element through scroll, resize and layout changes; a frame loop only runs
  // while something is selected.
  function tick() {
    caf(frame);
    frame = raf(function loop() {
      draw();
      if (active) frame = raf(loop);
    });
  }

  // ── HMR re-tag ───────────────────────────────────────────────────────────────────────────────
  var pending = false;
  new MutationObserver(function () {
    if (pending || !order.length) return;
    pending = true;
    raf(function () {
      pending = false;
      var back = F.retagEdits(document, order.map(function (u) { return { uid: u, selector: edits[u].selector }; }));
      if (styleEl && !styleEl.isConnected) write();
      if (back.length && active && back.indexOf(active) >= 0) post();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── commands ─────────────────────────────────────────────────────────────────────────────────
  window.addEventListener('message', function (ev) {
    if (ev.source !== window.parent) return;
    var d = ev.data;
    if (!d || typeof d !== 'object' || typeof d[CMD] !== 'string') return;
    var uid = typeof d.uid === 'string' ? d.uid : active;
    switch (d[CMD]) {
      case 'set': if (typeof d.prop === 'string') set(uid, d.prop, d.value == null ? '' : String(d.value), false); break;
      case 'undo': undo(uid); break;
      case 'reset': reset(uid); break;
      case 'resetAll': resetAll(); break;
      case 'deselect': active = null; draw(); post(); break;
      case 'capture': {
        capturing = d.on === true;
        var card = document.getElementById('__op_compose');
        if (card) card.style.visibility = capturing ? 'hidden' : '';
        draw();
        break;
      }
      case 'refresh': tokenCache = null; post(); break;
    }
  });

  window.__operatorEdit = { select: select, state: function () { return { active: active, count: order.length }; } };
})();
