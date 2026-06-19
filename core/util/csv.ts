// Minimal CSV serialization shared by the census/inventory exporters.

export function csvEscape(value: string): string {
  // Quote if the value contains a comma, quote, or newline; double inner quotes.
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(
  headers: string[],
  rows: (string | number)[][],
): string {
  const line = (cells: (string | number)[]) =>
    cells.map((c) => csvEscape(String(c))).join(',');
  return [line(headers), ...rows.map(line)].join('\n');
}
