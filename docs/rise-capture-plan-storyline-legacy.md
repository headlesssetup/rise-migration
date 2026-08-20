# Capture plan — legacy Storyline web → Review 360 packages

> **STATUS (2026-08-15): TODO — capture required before implementation.**
> Do not weaken `webStoryHtmlToReview360`, insert `<!-- 360 -->` into a legacy
> file, or mark a legacy package complete until a donor pair proves the exact
> Review 360 form. Unknown package generations remain loud per-course failures.

## Why this capture is required

The first full account-wide Storyline export found two genuine published-player
generations. The zip container is not the incompatibility; `story.html` is.

- Run: 153 courses containing Storyline blocks.
- Completed: 101 courses (89 newly packaged + 12 resumed/skipped).
- Failed: 52 courses.
  - 51 failed the modern `story.html` repackage assertion.
  - 1 separately failed `build/raw` with HTTP 404 — since root-caused, see the
    closing note at the bottom.
- Every one of the 51 format-failure courses contains at least one legacy
  Storyline package: versions 3.9 or 3.26–3.34, or a mixed course containing one
  of those versions. Newer blocks in the same mixed course do not make the
  course safe because the exporter commits its manifest only after every leaf
  has been repackaged.
- Observed modern controls at 3.42, 3.48, 3.60/3.61, and 3.98 pass the existing
  transform when no legacy leaf is present.

Representative source donors already archived locally:

| Cohort | Course | Course id | Storyline version | Observed `story.html` |
|---|---|---|---:|---|
| legacy | Swedbank Fire Safety DEMO | `UD_3RaHl-NFbFOu00Zvei4IGeDHVOi4i` | 3.26.18601.0 | router shell; launches `story_html5.html`; no 360 player-interface hook |
| legacy | JYSK matrači | `uuS2C9sObubTybbprBuGzL0TXulKUwOZ` | 3.31.19951.0 | same legacy router generation |
| legacy boundary | JYSK blanket/pillow cohort | multiple | 3.32/3.34 | format assertion fails |
| modern control | JYSK Customer service | `6_gIezXfnJtzvxNY45axFhSi2_1GMHpt` | 3.42.22792.0 | modern shell; current transform passes |
| modern control | TEST | `n2LVb8gwT83cdSUs8zeG8auC2J_pGcl9` | 3.48.24159.0 | modern shell; current transform passes |

The current implementation was proven from only one modern donor pair (the two
sample zips represented by `tests/fixtures/storyline/web-story.html` and
`r360-story.html`, Storyline 3.95). It removes the web robots meta tag and swaps
the web player-interface script for the Review 360 `<!-- 360 -->` marker. That
contract is valid for the modern fixture but is not universal.

The current error text, “Rise export format changed,” is therefore too broad.
This run did not show a mid-run Articulate change; it exposed historical package
generations that our two-sample contract never covered.

## Supporting official history (not sufficient protocol proof)

Articulate's official
[Storyline 360 Version History](https://cdn.articulate.com/assets/kb/sl360/en-Storyline-360-Version-History.html)
documents substantial published-player work in the observed gap:

- 3.36.21213.0 (2020-01-21): new accessible player and accessibility changes to
  published slide content;
- 3.41.22450.0 (2020-06-23): the latest accessibility enhancements became
  available when publishing to Review 360;
- 3.42.22792.0 (2020-08-04): our earliest observed passing donor.

This supports the hypothesis that the modern shell arrived in the 3.35–3.42
period. The history does **not** document the `story.html` layout,
`360-player-interface`, or `<!-- 360 -->` injection contract, so it cannot select
a transform or exact version cutoff. That still requires captured bytes.

## Capture question

For a legacy Storyline web package, what exact byte-level changes—if any—turn
the package into a valid Review 360 manual-upload package?

Acceptable outcomes are:

1. Review 360 accepts and serves the legacy web package unchanged (identity
   transform, proven by upload + playback + served-file inspection).
2. Legacy Review publish/manual upload uses a different deterministic
   `story.html` rewrite (capture the exact before/after pair).
3. Review 360 no longer accepts this generation; the migration must retain an
   explicit placeholder/manual-republish outcome rather than inventing bytes.

## Setup

- Use dedicated source/target test accounts and a disposable Review 360 item.
- Use at least two legacy donors: 3.26 and 3.34. Include one modern 3.42+ donor
  as the control.
- Prefer an existing source Review item for the archived legacy block. If an
  original `.story` file and matching historical Storyline build are available,
  publish the same project once to Web and once to Review 360.
- If a historical authoring build is unavailable, use the captured Rise web
  package as input to a disposable Review upload and inspect what Review stores
  and serves. Do not test against a client production item.

## Script

1. **Preserve raw web inputs.** Re-run `build/raw` for each donor and save the
   complete web export zip before repackaging. Extract the exact
   `content/assets/<leaf>/` subtree. Record course id, block id, leaf,
   `meta.version`, zip SHA-256, and `story.html` SHA-256.
2. **Inventory the package.** Save a sorted path/size/hash inventory and the raw
   `story.html`, `threeSixty.json`, and `meta.xml`. Record the shell signature:
   legacy router (`routePlayer`/`story_html5.html`) or modern player-interface.
3. **Obtain the Review form.** Publish/upload the same legacy donor to the
   disposable Review 360 item using the supported UI/API path. Preserve the
   accepted upload zip if available and capture the served Review package.
4. **Diff byte-for-byte.** Compare the full package inventories, then diff each
   changed file. Do not assume `story.html` is still the only changed file for
   the legacy generation.
5. **Playback verification.** Open the disposable Review item and verify first
   slide load, navigation, audio/video where present, completion reporting, and
   browser console/network errors.
6. **Repeat at the boundary.** Run the same capture for a 3.34 donor and the
   3.42 modern control. Record the narrowest proven classifier; do not infer
   behavior for uncaptured versions from the numeric version alone.
7. **Clean up.** Delete only the disposable Review items created for the test.
   Source courses and archived packages remain untouched.

## Repo deliverables

- `tests/fixtures/storyline/legacy-<version>/web/` minimal fixture set;
- `tests/fixtures/storyline/legacy-<version>/review/` proven counterpart;
- full path/hash diff report under `docs/captures/` (large zips stay outside git);
- exact capture notes: accounts/plane, timestamps, item ids, package hashes, and
  playback verdict;
- a package-shell classifier based on captured structure, not title or age;
- separate deterministic transforms for each proven generation;
- regression tests asserting the before/after donor pair byte-for-byte;
- unknown generations remain loud and their raw diagnostic bundle is retained
  locally for the next capture.

## Implementation gate

Only after the donor pair exists:

1. classify `modern-web`, `modern-review`, `legacy-web`, `legacy-review`, or
   `unknown` from structural signatures;
2. apply only the transform proven for that class;
3. assert the result against that class's Review fixture;
4. store the per-leaf generation and transform in the manifest;
5. rerun the 51 failed courses; completed manifests remain skipped.

The one `build/raw` HTTP 404 is a separate investigation and must not be grouped
under this format capture.

> **RESOLVED (2026-08-20, operator-confirmed): `build/raw` 404 = publish-rights
> gating.** On a US account where all 4 storyline courses 404'd identically
> (`{"statusCode":404,"error":"NotFoundError"}` after a successful socket
> `identify`), the Rise UI itself refused to publish the same courses with an
> "owned by …" message. Rise's build route answers 404 for a course the
> logged-in user cannot publish (owned by another seat), while ducks READS of
> the same course still succeed — so content export works and only stage D
> fails. Not plan gating (a stack without Localize answers **500**), not route
> drift, not auth. Remedy: run stage D logged in as the owning user, or have
> ownership transferred, then re-run — the stage is resumable and picks up only
> the failed courses. (Do NOT "send a copy": a copy re-mints course/block ids
> and breaks the storyline-manifest join.)
