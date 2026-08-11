// Integration: run a REAL INTEA SD docx end-to-end (parse → plan → archive).
// Gated on SD_DOCX (path to the .docx) so CI/normal runs skip it; the operator
// runs it against the client's document:
//   SD_DOCX="/path/to/SD.docx" pnpm vitest run core/storyboard/real-docx
// Optional: SD_OUT=/dir writes planned.json / course.json / production.md there.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildArchiveCourse } from './archive';
import { parseSdDocx } from './docx';
import { parseStoryboard } from './parse';

const path = process.env.SD_DOCX;

describe.skipIf(!path)('real SD docx end-to-end', () => {
  it('parses, plans and builds a clean archive course', () => {
    const bytes = new Uint8Array(readFileSync(path!));
    const sd = parseSdDocx(bytes);
    const planned = parseStoryboard(sd);
    const built = buildArchiveCourse(planned, '2026-08-10T00:00:00Z');

    // Shape sanity — loud, but not tied to one document's exact numbers.
    expect(planned.title.length).toBeGreaterThan(0);
    expect(planned.lessons.length).toBeGreaterThan(0);
    expect(built.blockCount).toBeGreaterThan(0);

    const summary = {
      title: planned.title,
      lessons: planned.lessons.map((l) => ({
        title: l.title,
        blocks: l.blocks.map((b) => ({
          slide: b.provenance.slideNo,
          kind: b.intent.kind,
          notes: b.notes.length,
        })),
      })),
      unparsed: planned.unparsed.map((u) => ({
        slide: u.provenance.slideNo,
        reason: u.reason,
        experience: u.provenance.experience.slice(0, 60),
      })),
      production: planned.production.length,
      blockCount: built.blockCount,
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    const out = process.env.SD_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'planned.json'), built.planJson);
      writeFileSync(join(out, 'course.json'), built.raw);
      writeFileSync(join(out, 'production.md'), built.productionMd);
      writeFileSync(join(out, 'notes.txt'), built.notes.join('\n'));
    }
  });
});
