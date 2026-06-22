#!/usr/bin/env node
// Pick a MINIMAL set of courses that, together, cover the widest surface for a
// live import test: every distinct family/variant, every reference kind
// (media image/video/audio/storyline, cdn, embed, draw-from-bank, storyline
// cross-ref), every question type, every lesson type — plus at least one course
// that carries orphaned media (a known-tricky case).
//
// Runs on YOUR machine against the exported archive folder (the remote build
// environment doesn't have it). Greedy weighted set-cover.
//
//   node scripts/pick-coverage-set.mjs /path/to/archive [--max N]
//
// Classification mirrors core/census/scan.ts (kept deliberately small + inline so
// this is a zero-dependency one-off operator tool). If scan.ts changes its ref
// rules, mirror them here.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const archive = process.argv[2];
const maxIdx = process.argv.indexOf('--max');
const MAX = maxIdx > -1 ? Number(process.argv[maxIdx + 1]) : Infinity;
if (!archive) {
  console.error('usage: node scripts/pick-coverage-set.mjs /path/to/archive [--max N]');
  process.exit(1);
}

const RE_CDN = /cdn\.articulate\.com\//i;
const RE_EMBED = /(?:youtube\.com|youtu\.be|vimeo\.com)/i;
const RE_USERCONTENT = /articulateusercontent\.com\//i;
const RE_RISE_KEY = /(?:^|[/"'\s])rise\/(?:courses|questionBanks)\/[^/\s"']+\//i;
const RE_IMG = /\.(?:jpe?g|png|gif|svg|webp|bmp|avif|tiff?)(?:[?#]|$)/i;
const RE_VID = /\.(?:mp4|webm|mov|m4v|ogv|avi|mkv)(?:[?#]|$)/i;
const RE_AUD = /\.(?:mp3|m4a|wav|ogg|oga|aac|flac)(?:[?#]|$)/i;

function classify(value, path) {
  if (RE_CDN.test(value)) return 'ref:cdn';
  if (RE_EMBED.test(value)) return 'ref:embed';
  if (RE_USERCONTENT.test(value) || RE_RISE_KEY.test(value)) {
    const p = path.toLowerCase();
    if (p.includes('storyline')) return 'ref:media-storyline';
    if (RE_IMG.test(value) || /\bimages?\b/.test(p)) return 'ref:media-image';
    if (RE_VID.test(value) || /\bvideos?\b/.test(p)) return 'ref:media-video';
    if (RE_AUD.test(value) || /\baudios?\b/.test(p)) return 'ref:media-audio';
    return 'ref:media-other';
  }
  return null;
}

// Walk a course payload → the set of coverage features it provides.
function featuresOf(doc) {
  const feats = new Set();
  const lessons = Array.isArray(doc.lessons) ? doc.lessons : [];
  for (const l of lessons) if (l && typeof l.type === 'string') feats.add(`lesson:${l.type}`);

  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === 'string') {
      const k = classify(node, path);
      if (k) feats.add(k);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((c, i) => walk(c, `${path}[${i}]`)); return; }
    if (node.type === 'DRAW_FROM_QUESTION_BANK') feats.add('ref:draw-from-bank');
    if (typeof node.family === 'string' && typeof node.variant === 'string') {
      feats.add(`variant:${node.family}/${node.variant}`);
    }
    if (typeof node.type === 'string' && Array.isArray(node.answers)) feats.add(`q:${node.type}`);
    for (const [key, v] of Object.entries(node)) {
      if (key === 'storyline' && v && typeof v === 'object') feats.add('ref:storyline-crossref');
      walk(v, `${path}.${key}`);
    }
  };
  walk(doc, '$');
  return feats;
}

// --- load courses ----------------------------------------------------------
const coursesDir = join(archive, 'courses');
if (!existsSync(coursesDir)) {
  console.error(`No courses/ dir under ${archive}`);
  process.exit(1);
}
const files = readdirSync(coursesDir).filter(
  (f) => f.endsWith('.json') && !f.endsWith('.assets.json'),
);

const courses = [];
for (const f of files) {
  try {
    const raw = JSON.parse(readFileSync(join(coursesDir, f), 'utf8'));
    const doc = raw.payload ?? raw;
    const id = doc.course?.id ?? f.replace(/\.json$/, '');
    const title = doc.course?.title ?? id;
    courses.push({ id, title, feats: featuresOf(doc) });
  } catch (e) {
    console.error(`skip ${f}: ${e.message}`);
  }
}

// Orphan-bearing courses (a deliberately-tricky case) from assets-summary.json.
const summaryPath = join(archive, '_metadata', 'assets-summary.json');
if (existsSync(summaryPath)) {
  try {
    const s = JSON.parse(readFileSync(summaryPath, 'utf8'));
    const orphanOwners = new Set(
      (s.orphaned ?? []).filter((o) => o.ownerType === 'course').map((o) => o.ownerId),
    );
    for (const c of courses) if (orphanOwners.has(c.id)) c.feats.add('case:orphaned-media');
  } catch { /* ignore */ }
}

// --- greedy weighted set-cover --------------------------------------------
const universe = new Set();
for (const c of courses) for (const f of c.feats) universe.add(f);

const covered = new Set();
const picked = [];
while (covered.size < universe.size && picked.length < MAX) {
  let best = null, bestGain = 0, bestNew = null;
  for (const c of courses) {
    if (picked.includes(c)) continue;
    const fresh = [...c.feats].filter((f) => !covered.has(f));
    if (fresh.length > bestGain) { best = c; bestGain = fresh.length; bestNew = fresh; }
  }
  if (!best || bestGain === 0) break;
  picked.push(best);
  for (const f of bestNew) covered.add(f);
  best._added = bestNew;
}

// --- report ----------------------------------------------------------------
console.log(`\nArchive: ${archive}`);
console.log(`Courses scanned: ${courses.length}`);
console.log(`Coverage features in library: ${universe.size}`);
console.log(`\nMinimal covering set — ${picked.length} course(s):\n`);
for (const [i, c] of picked.entries()) {
  console.log(`${i + 1}. ${c.title}`);
  console.log(`   id: ${c.id}`);
  console.log(`   +${c._added.length} new: ${c._added.sort().join(', ')}`);
  console.log('');
}
const missing = [...universe].filter((f) => !covered.has(f));
if (missing.length) console.log(`Uncovered (capped by --max): ${missing.sort().join(', ')}`);
else console.log('✓ Full coverage of every variant / ref / question / lesson type in the library.');

console.log('\nTip: start the live test with course #1 alone (dry-run → live), then add the rest.');
