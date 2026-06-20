import type { Census } from '@/core/census/aggregate';

export function CensusView({ census }: { census: Census }) {
  return (
    <div className="census">
      <p>
        {census.courseCount} course(s) · {census.variants.length} distinct
        family/variant · {census.refs.length} ref shape(s)
      </p>
      <h3>family / variant</h3>
      <table>
        <thead>
          <tr>
            <th>key</th>
            <th>count</th>
            <th>courses</th>
          </tr>
        </thead>
        <tbody>
          {census.variants.map((v) => (
            <tr key={v.key}>
              <td>{v.key}</td>
              <td>{v.count}</td>
              <td>{v.courseCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>reference shapes</h3>
      <table>
        <thead>
          <tr>
            <th>kind</th>
            <th>count</th>
            <th>courses</th>
          </tr>
        </thead>
        <tbody>
          {census.refs.map((r) => (
            <tr key={r.kind}>
              <td>{r.kind}</td>
              <td>{r.count}</td>
              <td>{r.courseCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {census.versions.length > 0 && (
        <p className="hint">
          versions: {census.versions.map((v) => v.signal).join(', ')}
        </p>
      )}
    </div>
  );
}
