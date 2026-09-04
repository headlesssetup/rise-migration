// Donor-verbatim Rise block `settings` objects used by the Creator mapper
// (split out of map.ts, v0.9.10). Provenance per constant: the editor's own
// CREATE_BLOCKS payloads (capture_creation4aug) and real exported blocks from
// the operator's archives — see map.ts's file header. Never improvise a value
// here; add a constant only with a named donor.

// Donor-verbatim settings (see file header for provenance).
export const TEXT_SETTINGS = {};
export const LIST_SETTINGS = { paddingTop: 0 };
export const INTERACTIVE_SETTINGS = {
  audioPosition: 'bottom',
  markerColorContrast: 'AUTO',
  paddingBottom: 3,
  paddingLinked: true,
  paddingTop: 0,
  snippetColorContrast: 'AUTO',
  v: 2,
  zoomOnClick: true,
};
export const FLASHCARD_SETTINGS = { paddingTop: 0 };
export const SORTING_SETTINGS = {
  backgroundColor: '#f5f5f5',
  markerColorContrast: 'AUTO',
  mediaWidth: '1',
  paddingBottom: 3,
  paddingLinked: true,
  paddingTop: 3,
  quotesInline: false,
  snippetColorContrast: 'AUTO',
  zoomOnClick: true,
};
export const TIMELINE_SETTINGS = {
  attachedToNextBlock: false,
  audioPosition: 'bottom',
  backgroundType: 'LIGHT',
  markerColorContrast: 'AUTO',
  mediaWidth: '1',
  paddingBottom: 0,
  paddingLinked: true,
  paddingTop: 0,
  quotesInline: false,
  snippetColorContrast: 'AUTO',
  v: 2,
  zoomOnClick: true,
};
export const KC_SETTINGS = {};
// Donor: operator's hand-made export (QLklxuftEPP… "Quick Test", 2026-08-10).
export const NOTE_SETTINGS = {
  paddingTop: 3,
  quotesInline: false,
  audioPosition: 'bottom',
  paddingBottom: 3,
  paddingLinked: true,
  markerColorContrast: 'AUTO',
  snippetColorContrast: 'AUTO',
};
export const BUTTON_STACK_SETTINGS = {
  paddingTop: 3,
  quotesInline: false,
  paddingBottom: 3,
  paddingLinked: true,
  markerColorContrast: 'AUTO',
  snippetColorContrast: 'AUTO',
};
export const VIDEO_SETTINGS = {
  accentColor: null,
  backgroundColor: null,
  backgroundType: 'ACCENT',
  cardMode: 'WHITE',
  customBackgroundColorContrast: 'AUTO',
  customPaddingBottom: 3,
  customPaddingLinked: false,
  customPaddingTop: 2,
  entranceAnimation: true,
  markerColorContrast: 'AUTO',
  paddingBottom: 3,
  paddingLinked: false,
  paddingTop: 2,
  snippetColorContrast: 'AUTO',
  v: 2,
};

// Donor: the 4 pristine labeled-graphic blocks in the rise-dump archive that
// still sit on Rise's own default image (assets/rise/assets/map-balloon.jpg) —
// identical settings on all four.
export const LABELED_GRAPHIC_SETTINGS = {
  backgroundColor: '#ffffff',
  entranceAnimation: true,
  mediaWidth: '1',
  paddingBottom: 3,
  paddingTop: 3,
  zoomOnClick: true,
};
