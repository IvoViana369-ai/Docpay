import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { allocateProportionally } from './allocate.js';

describe('allocateProportionally', () => {
  it('divide igualmente e dá o centavo extra a quem vem primeiro', () => {
    expect(allocateProportionally(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('dá os centavos que sobram a quem tem o maior resto', () => {
    // 199 × 60% = 119,4 e 199 × 40% = 79,6: o centavo que sobra vai para o segundo.
    expect(allocateProportionally(199, [6_000, 4_000])).toEqual([119, 80]);
  });

  it('nunca dá nada a peso zero', () => {
    expect(allocateProportionally(10, [0, 1, 0])).toEqual([0, 10, 0]);
  });

  it('rateia zero', () => {
    expect(allocateProportionally(0, [1, 2])).toEqual([0, 0]);
    expect(allocateProportionally(0, [0, 0])).toEqual([0, 0]);
  });

  it('recusa ratear um valor quando todos os pesos são zero', () => {
    expect(() => allocateProportionally(10, [0, 0])).toThrow(RangeError);
  });

  it('recusa entradas inválidas', () => {
    expect(() => allocateProportionally(-1, [1])).toThrow(RangeError);
    expect(() => allocateProportionally(10.5, [1])).toThrow(RangeError);
    expect(() => allocateProportionally(10, [])).toThrow(RangeError);
    expect(() => allocateProportionally(10, [-1, 2])).toThrow(RangeError);
    expect(() => allocateProportionally(10, [1.5])).toThrow(RangeError);
  });

  it('não perde precisão em valores muito altos', () => {
    const parts = allocateProportionally(Number.MAX_SAFE_INTEGER, [1, 1]);
    expect(parts).toEqual([4_503_599_627_370_496, 4_503_599_627_370_495]);
  });

  describe('propriedades', () => {
    const scenario = fc.record({
      amount: fc.integer({ min: 0, max: 10_000_000_000 }),
      weights: fc
        .array(fc.integer({ min: 0, max: 1_000_000_000 }), { minLength: 1, maxLength: 10 })
        .filter((weights) => weights.some((weight) => weight > 0)),
    });

    it('a soma das partes é sempre o valor', () => {
      fc.assert(
        fc.property(scenario, ({ amount, weights }) => {
          const parts = allocateProportionally(amount, weights);
          expect(parts.reduce((sum, part) => sum + part, 0)).toBe(amount);
        }),
      );
    });

    it('cada parte fica a menos de um centavo da proporção exata', () => {
      fc.assert(
        fc.property(scenario, ({ amount, weights }) => {
          const parts = allocateProportionally(amount, weights);
          const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
          weights.forEach((weight, index) => {
            const floor = (BigInt(amount) * BigInt(weight)) / total;
            const part = BigInt(parts[index]!);
            expect(part === floor || part === floor + 1n).toBe(true);
            if (weight === 0) expect(part).toBe(0n);
          });
        }),
      );
    });
  });
});
