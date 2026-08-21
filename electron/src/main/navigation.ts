// THE DROP BACKSTOP'S DECISION, as a pure function.
//
// A file dropped on a webview IS a navigation, and the default answer is yes. Operator has
// already lost a window to that (2026-08-14: a stray Finder drop navigated the WKWebView to
// `file:///…/image.png`, and closing the resulting window killed every lane's pty).
//
// Pure and its own module so it can be tested without booting Electron — the guard that only
// runs inside a window is the guard nobody checks.
import { fileURLToPath } from 'node:url'

/** May the app navigate to `url`?
 *
 *  `devUrl` is the dev server's URL when running from Vite, null when packaged. `appDir` is the
 *  directory the packaged renderer lives in. */
export function isAllowedNavigation(url: string, devUrl: string | null, appDir: string): boolean {
  // Compare ORIGIN, not the prefix. The dev URL carries a page and a query string, so a prefix
  // test would refuse the app's own reload — and would happily allow
  // `http://localhost:1450.evil.test/`, which shares the prefix but not the origin.
  if (devUrl) {
    try { if (new URL(url).origin === new URL(devUrl).origin) return true } catch { return false }
  }
  // Packaged: `file://` INSIDE our own renderer directory is the app itself. This deliberately
  // does not allow file:// generally — that is precisely the hole a dropped image walks through.
  if (url.startsWith('file://')) {
    try {
      const p = fileURLToPath(url)
      // `startsWith` on the directory plus a separator, so `/app/renderer-evil` cannot pass as
      // `/app/renderer`.
      return p === appDir || p.startsWith(appDir.endsWith('/') ? appDir : `${appDir}/`)
    } catch { return false }
  }
  return false
}
