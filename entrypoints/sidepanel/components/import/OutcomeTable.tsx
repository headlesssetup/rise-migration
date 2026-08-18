// Per-course outcome table for step C — split out of ImportView.tsx (v0.9.0).

import { summarizeFlags } from '@/core/import';
import type { CourseImportOutcome } from '../../orchestrator';

export function OutcomeTable({ outcomes }: { outcomes: CourseImportOutcome[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>course</th>
          <th>status</th>
          <th>lessons</th>
          <th>blocks</th>
          <th>uploads</th>
          <th>flags</th>
          <th>survivingKeys</th>
          <th>parity</th>
        </tr>
      </thead>
      <tbody>
        {outcomes.map((o) => {
          // imported/planned neutral; partial+stopped are resumable (amber); failed red.
          const color =
            o.status === 'failed'
              ? '#b00'
              : o.status === 'partial' || o.status === 'stopped'
                ? '#b67400'
                : undefined;
          const orphanNote = o.orphanedCourseId
            ? `orphaned shell left in place: ${o.orphanedCourseId}`
            : undefined;
          return (
          <tr key={o.courseId}>
            <td>{o.title ?? o.courseId}</td>
            <td style={{ color, fontWeight: 600 }} title={orphanNote}>
              {o.status}
            </td>
            <td>{o.report.planned.lessons}</td>
            <td>{o.report.planned.blocks}</td>
            <td>{o.report.planned.uploads}</td>
            <td title={o.report.flags.map((f) => f.detail).join('\n')}>
              {o.report.flags.length === 0 ? '0' : summarizeFlags(o.report.flags)}
            </td>
            <td style={{ color: o.report.survivingSourceKeys.length ? '#b00' : undefined }}>
              {o.report.survivingSourceKeys.length}
            </td>
            <td
              style={
                o.parity && !o.parity.ok ? { color: '#b00', fontWeight: 600 } : undefined
              }
            >
              {o.parity ? (o.parity.ok ? '✓' : `${o.parity.issues.length} diff`) : '—'}
            </td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}
