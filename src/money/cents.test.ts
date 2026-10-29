import { describe, expect, it } from 'vitest';
import { formatBRL, formatPercent, isBasisPoints, isCents, percentOf } from './cents.js';

describe('isCents', () => {
  it('aceita inteiros não negativos', () => {
    expect([0, 1, 199, Number.MAX_SAFE_INTEGER].every(isCents)).toBe(true);
  });

  it('recusa negativos, frações de centavo e valores que não são número', () => {
    const invalid = [-1, 10.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '100', null];
    expect(invalid.some(isCents)).toBe(false);
  });
});

describe('isBasisPoints', () => {
  it('aceita de 0% a 100%', () => {
    expect([0, 1, 4_000, 10_000].every(isBasisPoints)).toBe(true);
  });

  it('recusa fora da faixa ou com fração', () => {
    expect([-1, 10_001, 12.5, Number.NaN].some(isBasisPoints)).toBe(false);
  });
});

describe('percentOf', () => {
  it('aplica o percentual e arredonda para baixo', () => {
    expect(percentOf(100_000, 4_000)).toBe(40_000);
    // 999 × 33,33% = 332,97 centavos
    expect(percentOf(999, 3_333)).toBe(332);
  });

  it('não perde precisão em valores muito altos', () => {
    const amount = Number.MAX_SAFE_INTEGER;
    const expected = Number((BigInt(amount) * 9_999n) / 10_000n);
    expect(percentOf(amount, 9_999)).toBe(expected);
  });
});

describe('formatBRL', () => {
  it('formata no padrão brasileiro', () => {
    expect(formatBRL(0)).toBe('R$ 0,00');
    expect(formatBRL(5)).toBe('R$ 0,05');
    expect(formatBRL(199)).toBe('R$ 1,99');
    expect(formatBRL(123_456)).toBe('R$ 1.234,56');
    expect(formatBRL(100_000_000)).toBe('R$ 1.000.000,00');
  });

  it('formata negativos e BigInt', () => {
    expect(formatBRL(-199)).toBe('-R$ 1,99');
    expect(formatBRL(12_345_678_901_234_567_890n)).toBe('R$ 123.456.789.012.345.678,90');
  });
});

describe('formatPercent', () => {
  it('formata pontos-base como percentual', () => {
    expect(formatPercent(4_050)).toBe('40,50%');
    expect(formatPercent(1)).toBe('0,01%');
    expect(formatPercent(12_000)).toBe('120,00%');
  });
});
