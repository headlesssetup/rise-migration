import type { NoveltyReport } from '@/core/census/novelty';

export function NoveltyView({ novelty }: { novelty: NoveltyReport }) {
  const nothingNew =
    novelty.newVariants.length === 0 && novelty.newFields.length === 0;
  return (
    <div className="census">
      <p>
        {novelty.variantCount} variant(s) · {novelty.newVariants.length} new ·{' '}
        {novelty.newFields.length} new field(s)
      </p>
      {nothingNew && (
        <p className="hint">
          Nothing new vs the catalog. Field profiles written to catalog.csv/json.
        </p>
      )}
      {novelty.newVariants.length > 0 && (
        <>
          <h3>new variants</h3>
          <table>
            <thead>
              <tr>
                <th>family/variant</th>
                <th>instances</th>
                <th>courses</th>
                <th>fields</th>
              </tr>
            </thead>
            <tbody>
              {novelty.newVariants.map((v) => (
                <tr key={v.key}>
                  <td>{v.key}</td>
                  <td>{v.instances}</td>
                  <td>{v.courseCount}</td>
                  <td>{v.fieldCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {novelty.newFields.length > 0 && (
        <>
          <h3>new fields (known variants)</h3>
          <table>
            <thead>
              <tr>
                <th>family/variant</th>
                <th>field</th>
                <th>presence</th>
              </tr>
            </thead>
            <tbody>
              {novelty.newFields.slice(0, 50).map((f) => (
                <tr key={`${f.key}:${f.path}`}>
                  <td>{f.key}</td>
                  <td>{f.path}</td>
                  <td>{Math.round(f.presence * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
