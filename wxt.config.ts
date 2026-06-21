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
    permissions: ['sidePanel', 'storage', 'webRequest', 'scripting'],
    // Covers both Rise planes (rise.articulate.com / rise.eu.articulate.com),
    // the auth host (id[.eu].articulate.com), and any other Articulate subdomain
    // — needed for in-tab fetch injection, token capture, and refresh.
    // articulateusercontent.{com,eu} are separate apex domains that serve
    // uploaded media (public-read by key) — Phase 2 downloads asset bytes from
    // them (US = .com, EU = .eu). Both are needed for plane-aware export.
    host_permissions: [
      'https://*.articulate.com/*',
      'https://articulateusercontent.com/*',
      'https://articulateusercontent.eu/*',
    ],
    // Clicking the toolbar icon opens the side panel.
    action: {},
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
