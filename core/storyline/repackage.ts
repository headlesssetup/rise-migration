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

/** Loose match for ANY robots meta tag — the exact-string replace above only
 *  removes the byte-exact web-export form, so this catches a drifted variant
 *  (attribute order, spacing) that the replace silently missed. */
const ROBOTS_META_LOOSE = /<meta[^>]*\bname\s*=\s*"robots"/i;

/**
 * Convert a Storyline `story.html` from Rise web-export form to Review-360
 * manual-upload form. Idempotent: re-running on an already-converted file is a
 * no-op (neither source substring is present). CRLF line endings are preserved.
 *
 * LOUD on drift: the transform is two exact-string replaces, so a new Rise/
 * Storyline player version with slightly different markup would make both
 * silently no-op — and we'd upload a story.html still referencing the web
 * export's `../../lib/player-interface.js`, reported as success. So the result
 * is asserted to actually be in Review-360 form ({@link isReview360StoryHtml})
 * with no web-export markers left; anything else aborts the package.
 * @throws when the output is not verifiably Review-360 form.
 */
export function webStoryHtmlToReview360(html: string): string {
  const out = html.replace(ROBOTS_META, '').replace(PLAYER_SCRIPT, PLAYER_MARKER);
  const problems: string[] = [];
  if (!isReview360StoryHtml(out)) {
    problems.push(
      out.includes(PLAYER_SCRIPT)
        ? 'the web-export player-interface script tag survived'
        : `the "${PLAYER_MARKER}" player marker is missing`,
    );
  }
  if (ROBOTS_META_LOOSE.test(out)) problems.push('a robots meta tag survived');
  if (problems.length) {
    throw new Error(
      `Rise export format changed — the story.html repackage transform no longer matches: ${problems.join('; ')}. ` +
        'Compare this export against tests/fixtures/storyline/ and update repackage.ts.',
    );
  }
  return out;
}

/** True if `story.html` is in (or already in) Review-360 form. */
export function isReview360StoryHtml(html: string): boolean {
  return html.includes(PLAYER_MARKER) && !html.includes(PLAYER_SCRIPT);
}
