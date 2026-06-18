import { defineConfig } from 'wxt';

// WXT config — MV3, side panel + content script + background.
// Phase 0 is read-only: only the permissions/hosts needed to capture the
// session token and read the Rise catalog/course documents.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Rise Migration — Explorer (Phase 0)',
    description:
      'Read-only Rise exploration: identity, course census, raw GET_COURSE export.',
    permissions: ['sidePanel', 'storage', 'webRequest'],
    host_permissions: [
      'https://rise.articulate.com/*',
      'https://id.articulate.com/*',
    ],
    // Clicking the toolbar icon opens the side panel.
    action: {},
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
