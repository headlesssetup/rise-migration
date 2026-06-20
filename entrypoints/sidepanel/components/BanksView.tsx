import type { BankCatalog } from '@/core/census/question-banks';

export function BanksView({ banks }: { banks: BankCatalog }) {
  return (
    <div className="census">
      <p>
        {banks.bankCount} bank(s) · {banks.questionCount} question(s) ·{' '}
        {banks.profiles.length} type(s)
      </p>
      {banks.mediaRefs.length > 0 && (
        <p className="hint">
          media: {banks.mediaRefs.map((m) => `${m.kind} ${m.count}`).join(' · ')}
        </p>
      )}
      {banks.profiles.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>question type</th>
              <th>count</th>
              <th>banks</th>
              <th>fields</th>
            </tr>
          </thead>
          <tbody>
            {banks.profiles.map((p) => (
              <tr key={p.type}>
                <td>{p.type}</td>
                <td>{p.count}</td>
                <td>{p.bankCount}</td>
                <td>{p.fields.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
