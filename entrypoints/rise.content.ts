// Content script (US + EU Rise planes): session-presence ping + reads the
// logged-in account name from the page header (the avatar's aria-label/alt,
// e.g. "INTEA Team") so the panel shows which account the tab is on. The bearer
// token itself is captured by the background webRequest observer, not here.

import type { ContentMessage } from '@/shared/messaging';

// Prefer the header account-menu avatar; fall back to any avatar with a label.
function readAccountName(): string | null {
  const scopes = [
    '#account-dropdown-button',
    '[aria-label="Open Account menu"]',
    '.user-info',
    'header',
  ];
  for (const sel of scopes) {
    const root = document.querySelector(sel);
    if (!root) continue;
    const labelled = root.querySelector('[arc-avatar][aria-label]');
    const aria = labelled?.getAttribute('aria-label')?.trim();
    if (aria) return aria;
    const img = root.querySelector<HTMLImageElement>('[arc-avatar] img[alt]');
    const alt = img?.getAttribute('alt')?.trim();
    if (alt) return alt;
  }
  const any = document.querySelector('[arc-avatar][aria-label]');
  return any?.getAttribute('aria-label')?.trim() || null;
}

export default defineContentScript({
  // Keep in sync with RISE_TAB_GLOBS (shared/hosts.ts) — US + EU Rise planes.
  matches: ['https://rise.articulate.com/*', 'https://rise.eu.articulate.com/*'],
  main() {
    const send = (msg: ContentMessage) =>
      browser.runtime.sendMessage(msg).catch(() => {});

    send({ type: 'RISE_PRESENT' });

    // The header renders asynchronously and can change on account switch, so
    // poll and report whenever the name appears or changes.
    let lastName = '';
    const tick = () => {
      const name = readAccountName();
      if (name && name !== lastName) {
        lastName = name;
        send({ type: 'RISE_ACCOUNT', name });
      }
    };
    tick();
    const timer = setInterval(tick, 2000);

    window.addEventListener('pagehide', () => {
      clearInterval(timer);
      send({ type: 'RISE_GONE' });
    });
  },
});
