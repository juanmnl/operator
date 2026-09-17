/** The `name` of the Preview's <iframe>. The Electron main process finds the preview page among the
 *  window's frames by it (a direct child of the top frame with this name), to draw redlines, the grid
 *  and the inspector inside the page the user is already looking at. */
export const PREVIEW_FRAME_NAME = 'operator-preview'

/** The `postMessage` tag the injected page scripts use to reach the renderer (picks, anchor state). */
export const PREVIEW_MESSAGE_TAG = '__operatorPreview'

export type PreviewFrameMessage =
  | { [PREVIEW_MESSAGE_TAG]: 'pick'; data: string }
  | { [PREVIEW_MESSAGE_TAG]: 'anchor'; value: boolean }

/** Parse a `message` event's data into a preview message, or `null` for anything else. Pure. */
export function previewFrameMessage(data: unknown): PreviewFrameMessage | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d[PREVIEW_MESSAGE_TAG] === 'pick' && typeof d.data === 'string') return { [PREVIEW_MESSAGE_TAG]: 'pick', data: d.data }
  if (d[PREVIEW_MESSAGE_TAG] === 'anchor' && typeof d.value === 'boolean') return { [PREVIEW_MESSAGE_TAG]: 'anchor', value: d.value }
  return null
}

/** The page → renderer bridge, run in the preview page's main world before the inspector and the
 *  overlay. The shared inspector reports a pick through `window.__operatorBeacon`, and the overlay
 *  reports its anchor through `__operatorAnchorBridge`; both post to the parent (Operator's
 *  renderer), which accepts them only from its own preview iframe. */
export const PREVIEW_BRIDGE_JS = `
;(function () {
  var tag = ${JSON.stringify(PREVIEW_MESSAGE_TAG)};
  function post(msg) { try { window.parent.postMessage(msg, '*'); return true } catch (e) { return false } }
  window.__operatorPickBridge = function (json) {
    var m = {}; m[tag] = 'pick'; m.data = String(json);
    if (!post(m)) throw new Error('no parent');
  };
  window.__operatorAnchorBridge = function (value) {
    var m = {}; m[tag] = 'anchor'; m.value = value === true;
    post(m);
  };
  window.__operatorBeacon = function (data, onOk, onFail) {
    try { window.__operatorPickBridge(JSON.stringify(data)); onOk && onOk() }
    catch (e) { onFail && onFail() }
  };
})();
`
