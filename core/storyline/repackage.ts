// Repackage a Storyline bundle from Rise "Publish to Web" form into the
// Review-360 manual-upload form.
//
// Why: the storyline embedded-asset migration carries a block's published
// package from the source course into the target via Review 360 (the only
// ingest Rise exposes — see docs/rise-import-protocol.md §9). The package bytes
// come from a Rise "Publish to Web" export, whose `content/assets/{leaf}/`
// folder is byte-identical to a Review-360 manual-upload package (including
// `threeSixty.json` + `meta.xml`) EXCEPT for `story.html`. Verified against the
// operator's two sample zips: only `story.html` differs, in exactly two spots.
//
// So producing a manual-upload package = apply the `story.html` transform below
// to the web-export folder, then zip the folder's contents at the zip root.
// `repackage.test.ts` asserts the transform reproduces the Review-360 package's
// `story.html` byte-for-byte.

/** Web export adds a robots meta before `</head>`; the Review-360 package omits it. */
const ROBOTS_META = '<meta name="robots" content="noindex, nofollow">';

/** Web export hard-codes the player-interface script (relative path); the
 *  Review-360 package leaves a marker and Review 360 injects
 *  `player-interface.js` itself at serve time (confirmed in the storyline MITM
 *  capture: `GET 360.eu.articulate.com/js/player-interface.js`). */
const PLAYER_SCRIPT =
  '<script id="360-player-interface" type="text/javascript" src="../../lib/player-interface.js"></script>';
const PLAYER_MARKER = '<!-- 360 -->';

/**
 * Convert a Storyline `story.html` from Rise web-export form to Review-360
 * manual-upload form. Idempotent: re-running on an already-converted file is a
 * no-op (neither source substring is present). CRLF line endings are preserved.
 */
export function webStoryHtmlToReview360(html: string): string {
  return html.replace(ROBOTS_META, '').replace(PLAYER_SCRIPT, PLAYER_MARKER);
}

/** True if `story.html` is in (or already in) Review-360 form. */
export function isReview360StoryHtml(html: string): boolean {
  return html.includes(PLAYER_MARKER) && !html.includes(PLAYER_SCRIPT);
}
