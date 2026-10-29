/**
 * Dinheiro no DocPay é sempre um número inteiro de centavos de real:
 * R$ 12,34 é 1234. Nunca use números com casas decimais para dinheiro,
 * porque em ponto flutuante 0,1 + 0,2 não dá 0,3.
 */
export type Cents = number;

/** Percentual em pontos-base: 10000 = 100%, 250 = 2,5%, 1 = 0,01%. */
export type BasisPoints = number;

export const ONE_HUNDRED_PERCENT: BasisPoints = 10_000;

/** Centavos válidos: inteiro seguro e não negativo. */
export function isCents(value: unknown): value is Cents {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Percentual válido: inteiro de 0 a 10000 pontos-base (0% a 100%). */
export function isBasisPoints(value: unknown): value is BasisPoints {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= ONE_HUNDRED_PERCENT
  );
}

/**
 * Aplica um percentual a um valor, arredondando para baixo. A conta é feita
 * em BigInt para não perder precisão em valores altos.
 */
export function percentOf(amount: Cents, percent: BasisPoints): Cents {
  return Number((BigInt(amount) * BigInt(percent)) / BigInt(ONE_HUNDRED_PERCENT));
}

/** Formata centavos para exibição: 123456 → "R$ 1.234,56". */
export function formatBRL(cents: Cents | bigint): string {
  const value = BigInt(cents);
  const abs = value < 0n ? -value : value;
  const reais = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const centavos = (abs % 100n).toString().padStart(2, '0');
  return `${value < 0n ? '-' : ''}R$ ${reais},${centavos}`;
}

/** Formata pontos-base para exibição: 4050 → "40,50%". */
export function formatPercent(percent: BasisPoints): string {
  const whole = Math.trunc(percent / 100);
  const fraction = String(Math.abs(percent % 100)).padStart(2, '0');
  return `${whole},${fraction}%`;
}
