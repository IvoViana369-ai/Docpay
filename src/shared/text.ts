/** Texto preenchido: uma string com algo além de espaços. */
export function isFilled(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
