// Rise "planes" we operate on. The tool rides whichever Rise tab is active, so
// requests target the same origin as that tab (US or EU). Add new planes here.
export const RISE_TAB_GLOBS = [
  'https://rise.articulate.com/*', // US
  'https://rise.eu.articulate.com/*', // EU
];
