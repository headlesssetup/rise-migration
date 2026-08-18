import { describe, expect, it } from 'vitest';
import { goldenBlueprint } from '../golden-blueprint.fixture';
import {
  blueprintErrorReport,
  unwrapPastedJson,
  validateBlueprint,
} from './validate';

function goldenJson(): string {
  return JSON.stringify(goldenBlueprint(), null, 2);
}

/** Parse golden JSON, apply a mutation, re-serialize. */
function mutated(fn: (root: any) => void): string {
  const root = JSON.parse(goldenJson());
  fn(root);
  return JSON.stringify(root);
}

describe('unwrapPastedJson', () => {
  it('passes plain JSON through', () => {
    expect(unwrapPastedJson('{"a":1}')).toBe('{"a":1}');
  });

  it('extracts a ```json fence with surrounding chat prose', () => {
    const text = 'Here is your course:\n```json\n{"a":1}\n```\nHope this helps!';
    expect(unwrapPastedJson(text)).toBe('{"a":1}');
  });

  it('extracts a bare ``` fence', () => {
    expect(unwrapPastedJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('trims prose before and after braces without a fence', () => {
    expect(unwrapPastedJson('Sure! {"a":1} Done.')).toBe('{"a":1}');
  });

  it('keeps a truncated tail so the parse error is honest', () => {
    expect(unwrapPastedJson('Sure! {"a": [1, 2')).toBe('{"a": [1, 2');
  });
});

describe('validateBlueprint', () => {
  it('accepts the golden blueprint (ready, no errors)', () => {
    const v = validateBlueprint(goldenJson());
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(v.ready).toBe(true);
    expect(v.blueprint?.title).toBe(goldenBlueprint().title);
  });

  it('accepts the golden blueprint wrapped in chat prose and a fence', () => {
    const v = validateBlueprint(`Here you go:\n\n\`\`\`json\n${goldenJson()}\n\`\`\`\n\nAnything else?`);
    expect(v.ready).toBe(true);
  });

  it('normalizes missing block notes to []', () => {
    const v = validateBlueprint(mutated((r) => delete r.lessons[0].blocks[0].notes));
    expect(v.ready).toBe(true);
    expect(v.blueprint?.lessons[0]?.blocks[0]?.notes).toEqual([]);
  });

  it('flags truncated JSON with the re-emit hint', () => {
    const v = validateBlueprint(goldenJson().slice(0, 500));
    expect(v.ready).toBe(false);
    expect(v.issues.some((i) => i.code === 'truncated')).toBe(true);
  });

  it('rejects a wrong format/version and bails early', () => {
    const v = validateBlueprint(mutated((r) => (r.formatVersion = 99)));
    expect(v.ready).toBe(false);
    expect(v.issues[0]?.code).toBe('format');
  });

  it('rejects unknown root fields (closed schema)', () => {
    const v = validateBlueprint(mutated((r) => (r.extra = 1)));
    expect(v.issues.some((i) => i.code === 'unknown-field' && i.path === 'blueprint.extra')).toBe(true);
  });

  it('rejects an unknown intent kind with a path-addressed error', () => {
    const v = validateBlueprint(mutated((r) => (r.lessons[0].blocks[0].intent.kind = 'carousel')));
    const hit = v.issues.find((i) => i.code === 'unknown-kind');
    expect(hit?.path).toBe('blueprint.lessons[0].blocks[0].intent.kind');
  });

  it('rejects unknown fields inside an intent', () => {
    const v = validateBlueprint(mutated((r) => (r.lessons[0].blocks[0].intent.color = 'red')));
    expect(v.issues.some((i) => i.code === 'unknown-field')).toBe(true);
  });

  it('rejects a KC with no correct option, pointing at unresolved[]', () => {
    const v = validateBlueprint(
      mutated((r) => {
        const kc = r.lessons
          .flatMap((l: any) => l.blocks)
          .find((b: any) => b.intent.kind === 'knowledge-check');
        for (const o of kc.intent.questions[0].options) o.correct = false;
      }),
    );
    const hit = v.issues.find((i) => i.code === 'kc' && /unresolved/.test(i.message));
    expect(hit).toBeTruthy();
  });

  it('rejects a sorting card with an out-of-range pile index', () => {
    const v = validateBlueprint(
      mutated((r) => {
        const s = r.lessons
          .flatMap((l: any) => l.blocks)
          .find((b: any) => b.intent.kind === 'sorting');
        s.intent.cards[0].pile = 99;
      }),
    );
    expect(v.issues.some((i) => i.code === 'sorting')).toBe(true);
  });

  it('rejects non-empty assets (chat paste carries no binaries)', () => {
    const v = validateBlueprint(
      mutated((r) => r.assets.push({ kind: 'local-asset', path: 'assets/x.png' })),
    );
    expect(v.issues.some((i) => i.code === 'assets')).toBe(true);
  });

  it('rejects disallowed HTML and javascript: URLs', () => {
    const script = validateBlueprint(
      mutated((r) => (r.lessons[0].blocks[0].intent.paragraphs = ['<p><script>x()</script></p>'])),
    );
    expect(script.issues.some((i) => i.code === 'html')).toBe(true);

    const js = validateBlueprint(
      mutated((r) => {
        const links = r.lessons
          .flatMap((l: any) => l.blocks)
          .find((b: any) => b.intent.kind === 'links');
        links.intent.buttons[0].destination = 'javascript:alert(1)';
      }),
    );
    expect(js.issues.some((i) => i.code === 'html')).toBe(true);
  });

  it('rejects an invalid origin value', () => {
    const v = validateBlueprint(mutated((r) => (r.lessons[0].blocks[0].origin = 'guessed')));
    expect(v.issues.some((i) => i.code === 'origin')).toBe(true);
  });

  it('rejects an empty course and empty lessons', () => {
    expect(validateBlueprint(mutated((r) => (r.lessons = []))).ready).toBe(false);
    expect(validateBlueprint(mutated((r) => (r.lessons[0].blocks = []))).ready).toBe(false);
  });
});

describe('blueprintErrorReport', () => {
  it('lists every error with its path, ready to paste back into the chat', () => {
    const v = validateBlueprint(mutated((r) => (r.lessons[0].blocks[0].intent.kind = 'carousel')));
    const report = blueprintErrorReport(v.issues);
    expect(report).toContain('failed validation');
    expect(report).toContain('blueprint.lessons[0].blocks[0].intent.kind');
  });
});
