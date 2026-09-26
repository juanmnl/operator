// THE PORT `npm run dev`'s own Vite renderer listens on, decided in one place for scripts/dev.mjs and
// vite.config.ts (both keep `strictPort`, so a taken port fails loudly instead of drifting).
//
//   1. OPERATOR_ELECTRON_PORT   set explicitly for this dev build;
//   2. OPERATOR_DEV_PORT        the port Operator leased to the lane running this build. Without it,
//                               two lanes each starting a dev build both reached for 1610 and the
//                               second failed (review-xproject-devports, B1);
//   3. 1610                     outside every lane window (src/main/port-ranges.ts,
//                               DEV_RENDERER_DEFAULT_PORT).
//
// A value that is not a port number is skipped, not used.

export const DEV_RENDERER_FALLBACK_PORT = 1610

/** @param {Record<string, string | undefined>} env @returns {number} */
export function rendererPort(env) {
  for (const key of ['OPERATOR_ELECTRON_PORT', 'OPERATOR_DEV_PORT']) {
    const raw = (env[key] ?? '').trim()
    const n = Number(raw)
    if (/^\d+$/.test(raw) && n >= 1 && n <= 65535) return n
  }
  return DEV_RENDERER_FALLBACK_PORT
}
