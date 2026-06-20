// Question-bank detection + field profiling (API ref §9). Reusable question
// banks are separate from course content — draw-from-bank blocks reference a
// bank id — so migrating those blocks needs the banks too. This module is
// tolerant of the exact response shapes (not yet captured), mirroring the
// content/search approach: pull questions wherever they are, profile fields by
// question `type`, and let a live run's diagnostics confirm the schema.

import { toCsv } from '@/core/util/csv';
import { scanRefs } from './scan';
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

export interface BankMediaRef {
  kind: string;
  count: number;
  bankCount: number;
  examples: string[];
}

export interface BankCatalog {
  generatedAt: string;
  bankCount: number;
  questionCount: number;
  byType: { type: string; count: number }[];
  profiles: QuestionTypeProfile[];
  /** Media / cross-refs found in bank questions (e.g. images under
   *  rise/questionBanks/{id}/…) — banks carry their own assets, like courses. */
  mediaRefs: BankMediaRef[];
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
  const media = new Map<string, { count: number; banks: Set<string>; examples: string[] }>();
  let questionCount = 0;

  for (const bank of banks) {
    // Media / cross-refs carried by this bank (snake_case keys under
    // rise/questionBanks/{id}/… are detected by the shared scanner).
    for (const ref of scanRefs(bank.doc, bank.id)) {
      const m = media.get(ref.kind) ?? { count: 0, banks: new Set(), examples: [] };
      m.count += 1;
      m.banks.add(bank.id);
      if (m.examples.length < 3 && !m.examples.includes(ref.value)) {
        m.examples.push(ref.value);
      }
      media.set(ref.kind, m);
    }

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

  const mediaRefs: BankMediaRef[] = [...media.entries()]
    .map(([kind, m]) => ({
      kind,
      count: m.count,
      bankCount: m.banks.size,
      examples: m.examples,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    generatedAt: now.toISOString(),
    bankCount: banks.length,
    questionCount,
    byType: profiles.map((p) => ({ type: p.type, count: p.count })),
    profiles,
    mediaRefs,
  };
}

// ---------------------------------------------------------------------------
// Per-bank inventory — the decision table ("which banks to migrate"). Mirrors
// the course inventory (core/census/inventory.ts): one row per bank with the
// metadata a decision-maker needs (size, location, usage, owner, status).
// ---------------------------------------------------------------------------

export interface BankInventoryRow {
  id: string;
  title: string;
  folderPath: string;
  questionCount: number;
  /** Per-type breakdown, e.g. `MULTIPLE_CHOICE:5 MATCHING:2`. */
  types: string;
  /** Uploaded-media references carried by the bank (assets to migrate). */
  mediaCount: number;
  /** How many exported courses reference this bank (draw-from-bank). */
  usedByCourses: number;
  exampleCourseIds: string[];
  deleted: boolean;
  /** Rise exposes no created_at — only updated_at. */
  updatedAt: string;
  version: string;
  author: string;
  authorEmail: string;
  lastEditedBy: string;
  folderId: string;
}

export interface BankUsage {
  courseCount: number;
  courseIds: string[];
}

export interface BankInventoryOptions {
  /** Top-level `profiles` from the banks index (author/email resolution). */
  profiles?: unknown;
  /** Bank-folder id → resolved name-path (e.g. `shared / Team A`). */
  folderPaths?: Record<string, string>;
  /** bankId → which courses reference it (from collectBankReferences). */
  usage?: Record<string, BankUsage>;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Build id → { name, email } from the index `profiles` (shape tolerant). */
function buildProfileMap(profiles: unknown): Map<string, { name: string; email: string }> {
  const map = new Map<string, { name: string; email: string }>();
  for (const p of asObjArray(profiles)) {
    const id = p.id ?? p.user_id ?? p.userId ?? p.sub ?? p.principal_id;
    if (typeof id !== 'string') continue;
    const name =
      [p.first_name, p.last_name].filter((x) => typeof x === 'string').join(' ').trim() ||
      str(p.name) ||
      str(p.display_name);
    map.set(id, { name, email: str(p.email) });
  }
  return map;
}

/**
 * Recursively collect bank ids referenced by a course doc — every
 * `questionBankId` (tolerant of `bankId` / `question_bank_id`) string value
 * (draw-from-bank blocks). De-duplicated.
 */
export function collectBankReferences(courseDoc: unknown): string[] {
  const out = new Set<string>();
  const keys = new Set(['questionBankId', 'bankId', 'question_bank_id']);
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const c of node) walk(c);
    } else if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (keys.has(k) && typeof v === 'string') out.add(v);
        else walk(v);
      }
    }
  };
  walk(courseDoc);
  return [...out];
}

export function buildBankInventory(
  banks: { id: string; doc: unknown }[],
  opts: BankInventoryOptions = {},
): BankInventoryRow[] {
  const profileMap = buildProfileMap(opts.profiles);
  const folderPaths = opts.folderPaths ?? {};
  const usage = opts.usage ?? {};
  const nameOf = (id: unknown): string =>
    (typeof id === 'string' ? profileMap.get(id)?.name : '') || str(id);

  return banks
    .map((b): BankInventoryRow => {
      const doc = isObj(b.doc) ? b.doc : {};
      const questions = extractQuestions(doc);
      const byType = new Map<string, number>();
      for (const q of questions) {
        const t = typeof q.type === 'string' ? q.type : 'UNKNOWN';
        byType.set(t, (byType.get(t) ?? 0) + 1);
      }
      const types = [...byType.entries()]
        .sort((a, b2) => b2[1] - a[1] || a[0].localeCompare(b2[0]))
        .map(([t, n]) => `${t}:${n}`)
        .join(' ');
      const mediaCount = scanRefs(doc, b.id).filter((r) =>
        r.kind.startsWith('media-'),
      ).length;
      const u = usage[b.id];
      const folderId = str(doc.folder_id);
      const authorId = doc.author_id;
      return {
        id: b.id,
        title: str(doc.title),
        folderPath: folderPaths[folderId] ?? '',
        questionCount: questions.length,
        types,
        mediaCount,
        usedByCourses: u?.courseCount ?? 0,
        exampleCourseIds: u?.courseIds.slice(0, 3) ?? [],
        deleted: doc.deleted === true,
        updatedAt: str(doc.updated_at),
        version: str(doc.version),
        author: nameOf(authorId),
        authorEmail:
          (typeof authorId === 'string' ? profileMap.get(authorId)?.email : '') || '',
        lastEditedBy: nameOf(doc.last_edited_by),
        folderId,
      };
    })
    .sort(
      (a, b) =>
        b.usedByCourses - a.usedByCourses ||
        b.questionCount - a.questionCount ||
        a.title.localeCompare(b.title),
    );
}

const BANK_INVENTORY_COLUMNS: (keyof BankInventoryRow)[] = [
  'id',
  'title',
  'folderPath',
  'questionCount',
  'types',
  'mediaCount',
  'usedByCourses',
  'exampleCourseIds',
  'deleted',
  'updatedAt',
  'version',
  'author',
  'authorEmail',
  'lastEditedBy',
  'folderId',
];

export function bankInventoryToJson(rows: BankInventoryRow[]): string {
  return JSON.stringify(rows, null, 2);
}

export function bankInventoryToCsv(rows: BankInventoryRow[]): string {
  return toCsv(
    BANK_INVENTORY_COLUMNS as string[],
    rows.map((r) =>
      BANK_INVENTORY_COLUMNS.map((c) => {
        const v = r[c];
        if (Array.isArray(v)) return v.join(' ');
        if (typeof v === 'boolean') return v ? 'yes' : 'no';
        return v ?? '';
      }),
    ),
  );
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
