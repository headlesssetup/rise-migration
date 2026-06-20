import { defineConfig } from 'wxt';

// WXT config — MV3, side panel + content script + background.
// Phase 0 is read-only: only the permissions/hosts needed to capture the
// session token and read the Rise catalog/course documents.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Rise Migration — Exporter',
    description:
      'Export a Rise account (courses, question banks, folders, assets, account extras) for migration.',
    permissions: ['sidePanel', 'storage', 'webRequest', 'scripting'],
    // Covers both Rise planes (rise.articulate.com / rise.eu.articulate.com),
    // the auth host (id[.eu].articulate.com), and any other Articulate subdomain
    // — needed for in-tab fetch injection, token capture, and refresh.
    // articulateusercontent.com is a separate apex domain that serves uploaded
    // media (public-read by key) — Phase 2 downloads asset bytes from it.
    host_permissions: [
      'https://*.articulate.com/*',
      'https://articulateusercontent.com/*',
    ],
    // Clicking the toolbar icon opens the side panel.
    action: {},
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
