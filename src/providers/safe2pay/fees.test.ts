import { describe, expect, it } from 'vitest';
import { feeFor, parseFee } from './fees.js';

describe('parseFee', () => {
  it('lê valor fixo, percentual ou os dois', () => {
    expect(parseFee('100')).toEqual({ fixedCents: 100, percentBps: 0 });
    expect(parseFee('1,99%')).toEqual({ fixedCents: 0, percentBps: 199 });
    expect(parseFee('1.5%')).toEqual({ fixedCents: 0, percentBps: 150 });
    expect(parseFee(' 100 + 0,99% ')).toEqual({ fixedCents: 100, percentBps: 99 });
    expect(parseFee('99%')).toEqual({ fixedCents: 0, percentBps: 9_900 });
    expect(parseFee('100%')).toEqual({ fixedCents: 0, percentBps: 10_000 });
    expect(parseFee('0')).toEqual({ fixedCents: 0, percentBps: 0 });
  });

  it('recusa o que não faz sentido', () => {
    for (const text of ['', 'abc', '1,999%', '-1', '101%', '199%', '100 1%', 'R$ 1,00', '+1%']) {
      expect(() => parseFee(text), text).toThrow('Tarifa');
    }
  });
});

describe('feeFor', () => {
  it('soma o fixo e o percentual sobre o valor pago, arredondando para baixo', () => {
    expect(feeFor({ fixedCents: 100, percentBps: 0 }, 13_500)).toBe(100);
    // 0,99% de R$ 135,00 = R$ 1,3365
    expect(feeFor({ fixedCents: 0, percentBps: 99 }, 13_500)).toBe(133);
    expect(feeFor({ fixedCents: 50, percentBps: 99 }, 13_500)).toBe(183);
  });
});
