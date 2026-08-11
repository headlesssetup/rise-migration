import { defineConfig } from 'wxt';

// WXT config — MV3, side panel + content script + background.
// Phase 0 is read-only: only the permissions/hosts needed to capture the
// session token and read the Rise catalog/course documents.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Rise Migration',
    description:
      'Export a Rise account (courses, question banks, folders, assets, account extras) and re-import it into another account. Export is read-only; Import (write mode) is gated.',
    // `cookies` lets us read the bearer straight from the `_articulate_rise_`
    // cookie (it IS the access token) — no need to observe a request or have the
    // operator open a course to grab the token.
    permissions: ['sidePanel', 'storage', 'webRequest', 'scripting', 'cookies'],
    // US plane: rise|api|id|….articulate.com. EU plane hosts are TWO labels deep
    // (rise.eu.articulate.com) — `*.articulate.com` does NOT match those, so the
    // EU pattern must be listed separately or webRequest/cookies/scripting miss
    // the whole plane (and webRequest.addListener can refuse to register).
    // articulateusercontent.{com,eu} are separate apex domains that serve
    // uploaded media (public-read by key) — Phase 2 downloads asset bytes from
    // them (US = .com, EU = .eu). Both are needed for plane-aware export.
    host_permissions: [
      'https://*.articulate.com/*',
      'https://*.eu.articulate.com/*',
      'https://articulateusercontent.com/*',
      'https://articulateusercontent.eu/*',
      // S3 upload buckets (presigned PUT). Listing them here exempts the side
      // panel's direct upload fetch from CORS, so large assets PUT straight from
      // the panel (raw bytes) instead of riding a 64MB chrome.runtime message via
      // the background/tab. Covers global (`bucket.s3.amazonaws.com`) and regional
      // (`bucket.s3.<region>.amazonaws.com`) S3 endpoints, US + EU planes.
      'https://*.amazonaws.com/*',
    ],
    // Clicking the toolbar icon opens the side panel.
    action: {},
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
