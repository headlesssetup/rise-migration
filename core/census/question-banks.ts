// Question-bank detection + field profiling (API ref §9). Reusable question
// banks are separate from course content — draw-from-bank blocks reference a
// bank id — so migrating those blocks needs the banks too. This module is
// tolerant of the exact response shapes (not yet captured), mirroring the
// content/search approach: pull questions wherever they are, profile fields by
// question `type`, and let a live run's diagnostics confirm the schema.

import { toCsv } from '@/core/util/csv';
import { keyPaths } from './signature';

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

/** Array or id-keyed object map → array of objects. */
function asObjArray(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isObj);
  if (isObj(v)) return Object.values(v).filter(isObj);
  return [];
}

/** Find the first array reachable under `key` anywhere in the tree. */
function findArrayByKey(root: unknown, key: string): unknown[] | null {
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const c of node) stack.push(c);
    } else if (isObj(node)) {
      if (Array.isArray(node[key])) return node[key] as unknown[];
      for (const v of Object.values(node)) stack.push(v);
    }
  }
  return null;
}

export interface Bank {
  id: string;
  title?: string;
  /** The full bank object from the list (carries `questions` inline). */
  doc: Record<string, unknown>;
}

/** Full bank objects from the list response. The captured shape is
 *  `{ question_banks: [ {id, title, questions:[…], …} ], … }` — questions are
 *  INLINE, so no per-bank fetch is needed. Tolerant of other wrappers. */
export function extractBanks(listDoc: unknown): Bank[] {
  let arr: Record<string, unknown>[] = [];
  if (isObj(listDoc)) {
    for (const k of ['question_banks', 'questionBanks', 'banks', 'content', 'items', 'results', 'data']) {
      const got = asObjArray(listDoc[k]);
      if (got.length) {
        arr = got;
        break;
      }
    }
  }
  if (!arr.length) arr = asObjArray(listDoc);
  return arr
    .filter((o) => typeof o.id === 'string')
    .map((o) => ({
      id: o.id as string,
      title: typeof o.title === 'string' ? o.title : undefined,
      doc: o,
    }));
}

/** Does this bank carry its questions inline (no per-bank fetch needed)? */
export function hasInlineQuestions(doc: Record<string, unknown>): boolean {
  return Array.isArray(doc.questions);
}

/** Question objects from one bank doc (prefer a `questions` array). */
export function extractQuestions(bankDoc: unknown): Record<string, unknown>[] {
  const byKey = findArrayByKey(bankDoc, 'questions');
  if (byKey) return byKey.filter(isObj);
  // Fallback: any array of objects that look like questions.
  const stack: unknown[] = [bankDoc];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      const qs = node.filter(isObj);
      if (qs.length && qs.every((q) => 'type' in q || 'answers' in q)) return qs;
      for (const c of node) stack.push(c);
    } else if (isObj(node)) {
      for (const v of Object.values(node)) stack.push(v);
    }
  }
  return [];
}

export interface QField {
  path: string;
  count: number;
  presence: number;
  core: boolean;
}

export interface QuestionTypeProfile {
  type: string;
  count: number; // questions of this type
  bankCount: number;
  examplePath: string;
  fields: QField[];
}

export interface BankCatalog {
  generatedAt: string;
  bankCount: number;
  questionCount: number;
  byType: { type: string; count: number }[];
  profiles: QuestionTypeProfile[];
}

interface Acc {
  type: string;
  count: number;
  banks: Set<string>;
  examplePath: string;
  fields: Map<string, { count: number }>;
}

export function buildBankCatalog(
  banks: { id: string; doc: unknown }[],
  now: Date = new Date(),
): BankCatalog {
  const map = new Map<string, Acc>();
  let questionCount = 0;

  for (const bank of banks) {
    const questions = extractQuestions(bank.doc);
    questions.forEach((q, i) => {
      questionCount += 1;
      const type = typeof q.type === 'string' ? q.type : 'UNKNOWN';
      let a = map.get(type);
      if (!a) {
        a = {
          type,
          count: 0,
          banks: new Set(),
          examplePath: `${bank.id}/questions[${i}]`,
          fields: new Map(),
        };
        map.set(type, a);
      }
      a.count += 1;
      a.banks.add(bank.id);
      for (const p of keyPaths(q)) {
        const f = a.fields.get(p) ?? { count: 0 };
        f.count += 1;
        a.fields.set(p, f);
      }
    });
  }

  const profiles: QuestionTypeProfile[] = [...map.values()]
    .map((a) => ({
      type: a.type,
      count: a.count,
      bankCount: a.banks.size,
      examplePath: a.examplePath,
      fields: [...a.fields.entries()]
        .map(([path, f]) => ({
          path,
          count: f.count,
          presence: a.count ? Math.round((f.count / a.count) * 100) / 100 : 0,
          core: f.count === a.count,
        }))
        .sort(
          (x, y) =>
            Number(y.core) - Number(x.core) ||
            y.count - x.count ||
            x.path.localeCompare(y.path),
        ),
    }))
    .sort((x, y) => y.count - x.count || x.type.localeCompare(y.type));

  return {
    generatedAt: now.toISOString(),
    bankCount: banks.length,
    questionCount,
    byType: profiles.map((p) => ({ type: p.type, count: p.count })),
    profiles,
  };
}

export function bankCatalogToJson(c: BankCatalog): string {
  return JSON.stringify(c, null, 2);
}

export function bankCatalogToCsv(c: BankCatalog): string {
  const headers = ['type', 'count', 'bankCount', 'field', 'core', 'presencePct'];
  const rows: (string | number)[][] = [];
  for (const p of c.profiles) {
    for (const f of p.fields) {
      rows.push([
        p.type,
        p.count,
        p.bankCount,
        f.path,
        f.core ? 'core' : 'optional',
        Math.round(f.presence * 100),
      ]);
    }
  }
  return toCsv(headers, rows);
}
