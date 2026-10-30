/**
 * Expressão SQL que devolve uma data em ISO 8601 (UTC, com milissegundos),
 * igual em qualquer driver: "2026-10-29T12:00:00.000Z".
 */
export function isoTimestamp(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}
