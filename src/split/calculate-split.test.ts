import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { calculateSplit } from './calculate-split.js';
import { SplitError, type SplitIssueCode } from './errors.js';
import type { FeePolicy, SplitInput, SplitRule } from './types.js';

function rejectionCodes(input: SplitInput): SplitIssueCode[] {
  try {
    calculateSplit(input);
  } catch (error) {
    if (error instanceof SplitError) return error.issues.map((issue) => issue.code);
    throw error;
  }
  throw new Error('Esperava que a divisão fosse recusada, mas ela foi calculada.');
}

const partnerAt40: SplitRule = {
  beneficiary: 'vendedor',
  recipients: [{ account: 'parceiro', percentBps: 4_000 }],
};

describe('calculateSplit', () => {
  it('repassa o percentual ao destinatário e o restante ao beneficiário', () => {
    const result = calculateSplit({ amountCents: 100_000, rule: partnerAt40 });

    expect(result).toEqual({
      amountCents: 100_000,
      feeCents: 0,
      shares: [
        { account: 'vendedor', role: 'beneficiary', grossCents: 60_000, feeCents: 0, netCents: 60_000 },
        { account: 'parceiro', role: 'recipient', grossCents: 40_000, feeCents: 0, netCents: 40_000 },
      ],
    });
  });

  it('soma valor fixo e percentual no mesmo destinatário', () => {
    const result = calculateSplit({
      amountCents: 10_000,
      rule: {
        beneficiary: 'vendedor',
        recipients: [{ account: 'parceiro', percentBps: 1_000, fixedCents: 500 }],
      },
    });

    expect(result.shares.map((share) => share.grossCents)).toEqual([8_500, 1_500]);
  });

  it('arredonda os percentuais para baixo e deixa os centavos de sobra com o beneficiário', () => {
    const result = calculateSplit({
      amountCents: 10_000,
      rule: {
        beneficiary: 'vendedor',
        recipients: [
          { account: 'a', percentBps: 3_333 },
          { account: 'b', percentBps: 3_333 },
          { account: 'c', percentBps: 3_334 },
        ],
      },
    });

    expect(result.shares.map((share) => share.grossCents)).toEqual([0, 3_333, 3_333, 3_334]);

    const odd = calculateSplit({
      amountCents: 1_001,
      rule: {
        beneficiary: 'vendedor',
        recipients: [
          { account: 'a', percentBps: 5_000 },
          { account: 'b', percentBps: 5_000 },
        ],
      },
    });
    // 50% de R$ 10,01 é R$ 5,005: cada um recebe R$ 5,00 e o beneficiário fica com R$ 0,01.
    expect(odd.shares.map((share) => share.grossCents)).toEqual([1, 500, 500]);
  });

  it('cobra a tarifa do beneficiário quando a regra não diz nada', () => {
    const result = calculateSplit({ amountCents: 100_000, feeCents: 199, rule: partnerAt40 });

    expect(result.shares).toEqual([
      { account: 'vendedor', role: 'beneficiary', grossCents: 60_000, feeCents: 199, netCents: 59_801 },
      { account: 'parceiro', role: 'recipient', grossCents: 40_000, feeCents: 0, netCents: 40_000 },
    ]);
  });

  it('cobra a tarifa de um destinatário quando a regra manda', () => {
    const result = calculateSplit({
      amountCents: 100_000,
      feeCents: 199,
      rule: { ...partnerAt40, feePolicy: { kind: 'single', payer: 'parceiro' } },
    });

    expect(result.shares.map(({ feeCents, netCents }) => ({ feeCents, netCents }))).toEqual([
      { feeCents: 0, netCents: 60_000 },
      { feeCents: 199, netCents: 39_801 },
    ]);
  });

  it('divide a tarifa na proporção do que cada conta recebe', () => {
    const result = calculateSplit({
      amountCents: 10_000,
      feeCents: 199,
      rule: { ...partnerAt40, feePolicy: { kind: 'proportional' } },
    });

    // 60% de R$ 1,99 é R$ 1,194 e 40% é R$ 0,796: o centavo que sobra vai para o maior resto.
    expect(result.shares.map(({ feeCents, netCents }) => ({ feeCents, netCents }))).toEqual([
      { feeCents: 119, netCents: 5_881 },
      { feeCents: 80, netCents: 3_920 },
    ]);
  });

  it('recusa repasses maiores que o valor', () => {
    const input: SplitInput = {
      amountCents: 10_000,
      rule: { beneficiary: 'vendedor', recipients: [{ account: 'parceiro', fixedCents: 15_000 }] },
    };

    expect(rejectionCodes(input)).toEqual(['SPLIT_EXCEEDS_AMOUNT']);
    expect(() => calculateSplit(input)).toThrow(
      'Os repasses somam R$ 150,00, mais que o valor de R$ 100,00.',
    );
  });

  it('recusa quando a tarifa é maior que a parte de quem paga', () => {
    const input: SplitInput = {
      amountCents: 1_000,
      feeCents: 199,
      rule: {
        beneficiary: 'vendedor',
        recipients: [{ account: 'parceiro', percentBps: 100 }],
        feePolicy: { kind: 'single', payer: 'parceiro' },
      },
    };

    expect(rejectionCodes(input)).toEqual(['FEE_EXCEEDS_SHARE']);
    expect(() => calculateSplit(input)).toThrow(
      'A conta parceiro recebe R$ 0,10, menos que a tarifa de R$ 1,99.',
    );
  });

  it('recusa tarifa maior que o valor', () => {
    expect(rejectionCodes({ amountCents: 100, feeCents: 199, rule: partnerAt40 })).toEqual([
      'FEE_EXCEEDS_AMOUNT',
    ]);
  });

  it('recusa valor zero, negativo ou com fração de centavo', () => {
    for (const amountCents of [0, -100, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(rejectionCodes({ amountCents, rule: partnerAt40 })).toEqual(['INVALID_AMOUNT']);
    }
  });

  it('recusa tarifa negativa ou com fração de centavo', () => {
    for (const feeCents of [-1, 1.5]) {
      expect(rejectionCodes({ amountCents: 1_000, feeCents, rule: partnerAt40 })).toEqual([
        'INVALID_FEE',
      ]);
    }
  });

  it('junta os problemas da regra e dos valores num único erro', () => {
    const codes = rejectionCodes({
      amountCents: 0,
      feeCents: -1,
      rule: { beneficiary: '', recipients: [{ account: 'parceiro' }] },
    });

    expect(codes).toEqual(['MISSING_BENEFICIARY', 'EMPTY_SHARE', 'INVALID_AMOUNT', 'INVALID_FEE']);
  });

  it('não perde precisão em valores muito altos', () => {
    const amountCents = Number.MAX_SAFE_INTEGER;
    const result = calculateSplit({
      amountCents,
      rule: { beneficiary: 'vendedor', recipients: [{ account: 'parceiro', percentBps: 9_999 }] },
    });

    const partner = (BigInt(amountCents) * 9_999n) / 10_000n;
    expect(result.shares.map((share) => BigInt(share.grossCents))).toEqual([
      BigInt(amountCents) - partner,
      partner,
    ]);
  });

  describe('propriedades', () => {
    // Regras válidas: no máximo metade do valor em percentuais e metade em valores fixos.
    const scenario = fc
      .tuple(fc.integer({ min: 1, max: 10_000_000_000 }), fc.integer({ min: 0, max: 6 }))
      .chain(([amountCents, count]) => {
        const maxPercent = Math.floor(5_000 / Math.max(count, 1));
        const maxFixed = Math.floor(amountCents / (2 * Math.max(count, 1)));
        const recipients = fc
          .array(
            fc.record({
              percentBps: fc.integer({ min: 0, max: maxPercent }),
              fixedCents: fc.integer({ min: 0, max: maxFixed }),
            }),
            { minLength: count, maxLength: count },
          )
          .map((list) =>
            list.map(({ percentBps, fixedCents }, index) => ({
              account: `parceiro-${index + 1}`,
              percentBps: percentBps === 0 && fixedCents === 0 ? 1 : percentBps,
              fixedCents,
            })),
          );
        const feePolicy: fc.Arbitrary<FeePolicy | undefined> = fc.oneof(
          fc.constant(undefined),
          fc.constant({ kind: 'proportional' as const }),
          fc.integer({ min: 0, max: count }).map((index) => ({
            kind: 'single' as const,
            payer: index === 0 ? 'vendedor' : `parceiro-${index}`,
          })),
        );
        return fc.record({
          amountCents: fc.constant(amountCents),
          feeCents: fc.integer({ min: 0, max: amountCents }),
          recipients,
          feePolicy,
        });
      });

    it('fecha o valor e a tarifa centavo por centavo, sem conta negativa', () => {
      fc.assert(
        fc.property(scenario, ({ amountCents, feeCents, recipients, feePolicy }) => {
          const rule: SplitRule = { beneficiary: 'vendedor', recipients, feePolicy };
          const withoutFee = calculateSplit({ amountCents, rule });

          const payer =
            feePolicy === undefined ? 'vendedor' : feePolicy.kind === 'single' ? feePolicy.payer : undefined;
          const payerShare = withoutFee.shares.find((share) => share.account === payer);
          if (payerShare && payerShare.grossCents < feeCents) {
            expect(rejectionCodes({ amountCents, feeCents, rule })).toEqual(['FEE_EXCEEDS_SHARE']);
            return;
          }

          const result = calculateSplit({ amountCents, feeCents, rule });
          const total = (key: 'grossCents' | 'feeCents' | 'netCents') =>
            result.shares.reduce((sum, share) => sum + share[key], 0);

          expect(total('grossCents')).toBe(amountCents);
          expect(total('feeCents')).toBe(feeCents);
          expect(total('netCents')).toBe(amountCents - feeCents);
          // A tarifa não muda a parte de ninguém, só quanto cada um recebe de fato.
          expect(result.shares.map((share) => share.grossCents)).toEqual(
            withoutFee.shares.map((share) => share.grossCents),
          );
          for (const share of result.shares) {
            expect(share.feeCents).toBeGreaterThanOrEqual(0);
            expect(share.netCents).toBe(share.grossCents - share.feeCents);
            expect(share.netCents).toBeGreaterThanOrEqual(0);
          }
        }),
        { numRuns: 500 },
      );
    });

    it('cada destinatário recebe o fixo mais o percentual, a menos de um centavo do exato', () => {
      fc.assert(
        fc.property(scenario, ({ amountCents, recipients }) => {
          const result = calculateSplit({
            amountCents,
            rule: { beneficiary: 'vendedor', recipients },
          });

          recipients.forEach(({ percentBps, fixedCents }, index) => {
            const share = result.shares[index + 1]!;
            const percentPart = BigInt(share.grossCents - fixedCents) * 10_000n;
            const exact = BigInt(amountCents) * BigInt(percentBps);
            expect(percentPart <= exact && exact < percentPart + 10_000n).toBe(true);
          });
        }),
        { numRuns: 500 },
      );
    });

    it('na tarifa proporcional, cada conta paga a menos de um centavo da proporção exata', () => {
      fc.assert(
        fc.property(scenario, ({ amountCents, feeCents, recipients }) => {
          const result = calculateSplit({
            amountCents,
            feeCents,
            rule: { beneficiary: 'vendedor', recipients, feePolicy: { kind: 'proportional' } },
          });

          for (const share of result.shares) {
            const floor = (BigInt(feeCents) * BigInt(share.grossCents)) / BigInt(amountCents);
            const fee = BigInt(share.feeCents);
            expect(fee === floor || fee === floor + 1n).toBe(true);
          }
        }),
        { numRuns: 500 },
      );
    });
  });
});
