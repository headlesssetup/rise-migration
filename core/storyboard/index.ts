// Storyboard rendering — Rise → docx EXPORT direction only
// (docs/rise-storyboard-format.md): archived course → SBDOC/prose docx bytes.
//
// The SD-docx → Rise IMPORT direction was dropped (2026-08-16): client docx is
// too unreliable to serve as deterministic input without an AI cleanup stage.
// Doc → Rise now goes through the Creator AI-paste flow (core/creator/):
// external AI chat → Course Blueprint JSON → validate → compile.
// `map.ts` (blueprint intents → donor-backed Rise blocks) stays here as the
// compiler's mapper; `docx.ts`/`xml.ts` stay as the docx-writer test oracle.

export * from './render';