// Content script (rise.articulate.com): minimal session-presence ping so the
// side panel can show "Rise tab detected". The token itself is captured by the
// background webRequest observer, not here.

import type { ContentMessage } from '@/shared/messaging';

export default defineContentScript({
  matches: ['https://rise.articulate.com/*'],
  main() {
    const send = (msg: ContentMessage) =>
      browser.runtime.sendMessage(msg).catch(() => {});

    send({ type: 'RISE_PRESENT' });
    window.addEventListener('pagehide', () => send({ type: 'RISE_GONE' }));
  },
});
