/** Fuso padrão do DocPay. O Brasil não tem horário de verão desde 2019. */
export const DEFAULT_TIME_ZONE = 'America/Sao_Paulo';

/** A data de hoje (AAAA-MM-DD) num fuso horário. */
export function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** O instante (UTC) de uma data e hora local num fuso: zonedTime('2026-11-10T23:59:59', 'America/Sao_Paulo'). */
export function zonedTime(localDateTime: string, timeZone: string): Date {
  const asIfUtc = new Date(`${localDateTime}Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(asIfUtc)
      .map((part) => [part.type, part.value]),
  );
  const shownInZone = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  // A diferença entre o que o fuso mostra e o instante é o deslocamento do fuso.
  return new Date(asIfUtc.getTime() - (shownInZone - asIfUtc.getTime()));
}

/** Data AAAA-MM-DD real (não aceita 30 de fevereiro). */
export function isRealDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
