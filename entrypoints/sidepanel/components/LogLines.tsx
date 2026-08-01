import { memo } from 'react';
import { logLineClass } from '../log-lines';

/** The log body. Memoized on the line array because App re-renders once a second
 *  while a countdown is live and this list is unvirtualized — without the memo
 *  every tick re-rendered thousands of lines (visible jank on a long run). */
export const LogLines = memo(function LogLines({ lines }: { lines: string[] }) {
  return (
    <>
      {lines.map((line, i) =>
        line === '' ? (
          <div key={i} className="log-line log-gap" />
        ) : (
          <div key={i} className={logLineClass(line)}>
            {line}
          </div>
        ),
      )}
    </>
  );
});
