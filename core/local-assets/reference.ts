export interface LocalAssetRef {
  kind: 'local-asset';
  path: string;
  mimeType?: string;
  sha256?: string;
  altText?: string;
}

export interface LocalAssetOccurrence {
  path: string;
  assetPath: string;
}

/** Find typed package-local asset references in any JSON-compatible tree. */
export function findLocalAssetRefs(value: unknown): LocalAssetOccurrence[] {
  const found: LocalAssetOccurrence[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const row = node as Record<string, unknown>;
    if (row.kind === 'local-asset' && typeof row.path === 'string') {
      found.push({ path: path || '$', assetPath: row.path });
    }
    for (const [key, child] of Object.entries(row)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  };
  walk(value, '');
  return found;
}
