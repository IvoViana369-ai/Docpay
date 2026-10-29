import { describe, expect, it } from 'vitest';
import type { SplitRecipient, SplitRule } from './types.js';
import { validateSplitRule } from './validate-rule.js';

function codes(rule: SplitRule): string[] {
  return validateSplitRule(rule).map((issue) => issue.code);
}

function withRecipients(...recipients: SplitRecipient[]): SplitRule {
  return { beneficiary: 'vendedor', recipients };
}

describe('validateSplitRule', () => {
  it('aceita uma regra válida', () => {
    const rule: SplitRule = {
      beneficiary: 'vendedor',
      recipients: [
        { account: 'parceiro', percentBps: 4_000 },
        { account: 'indicador', fixedCents: 500 },
        { account: 'plataforma', percentBps: 100, fixedCents: 50 },
      ],
      feePolicy: { kind: 'single', payer: 'parceiro' },
    };
    expect(validateSplitRule(rule)).toEqual([]);
  });

  it('aceita regra sem destinatários: o beneficiário fica com tudo', () => {
    expect(codes(withRecipients())).toEqual([]);
  });

  it('aceita percentuais que somam exatamente 100%', () => {
    const rule = withRecipients(
      { account: 'a', percentBps: 6_000 },
      { account: 'b', percentBps: 4_000 },
    );
    expect(codes(rule)).toEqual([]);
  });

  it('exige a conta beneficiária', () => {
    expect(codes({ beneficiary: '', recipients: [] })).toEqual(['MISSING_BENEFICIARY']);
    expect(codes({ beneficiary: '   ', recipients: [] })).toEqual(['MISSING_BENEFICIARY']);
  });

  it('exige a conta de cada destinatário', () => {
    expect(codes(withRecipients({ account: '', percentBps: 1_000 }))).toEqual(['MISSING_ACCOUNT']);
  });

  it('não aceita o beneficiário como destinatário', () => {
    expect(codes(withRecipients({ account: 'vendedor', percentBps: 1_000 }))).toEqual([
      'BENEFICIARY_AS_RECIPIENT',
    ]);
  });

  it('não aceita a mesma conta duas vezes', () => {
    const rule = withRecipients(
      { account: 'parceiro', percentBps: 1_000 },
      { account: 'parceiro', fixedCents: 500 },
    );
    expect(codes(rule)).toEqual(['DUPLICATE_ACCOUNT']);
  });

  it('exige percentual ou valor fixo maior que zero', () => {
    const empty: SplitRecipient[] = [
      { account: 'a' },
      { account: 'b', percentBps: 0 },
      { account: 'c', fixedCents: 0 },
      { account: 'd', percentBps: 0, fixedCents: 0 },
    ];
    expect(codes(withRecipients(...empty))).toEqual([
      'EMPTY_SHARE',
      'EMPTY_SHARE',
      'EMPTY_SHARE',
      'EMPTY_SHARE',
    ]);
  });

  it('recusa percentual fora de 0% a 100% ou com fração', () => {
    for (const percentBps of [-1, 10_001, 12.5, Number.NaN]) {
      expect(codes(withRecipients({ account: 'a', percentBps }))).toEqual(['INVALID_PERCENT']);
    }
  });

  it('recusa valor fixo negativo ou com fração de centavo', () => {
    for (const fixedCents of [-1, 10.5, Number.NaN]) {
      expect(codes(withRecipients({ account: 'a', fixedCents }))).toEqual(['INVALID_FIXED']);
    }
  });

  it('recusa percentuais que somam mais de 100%', () => {
    const issues = validateSplitRule(
      withRecipients({ account: 'a', percentBps: 6_000 }, { account: 'b', percentBps: 5_000 }),
    );
    expect(issues.map((issue) => issue.code)).toEqual(['PERCENT_OVER_100']);
    expect(issues[0]?.message).toContain('110,00%');
  });

  it('aceita o beneficiário ou um destinatário como pagador da tarifa', () => {
    const recipients = [{ account: 'parceiro', percentBps: 1_000 }];
    for (const payer of ['vendedor', 'parceiro']) {
      const rule: SplitRule = {
        beneficiary: 'vendedor',
        recipients,
        feePolicy: { kind: 'single', payer },
      };
      expect(codes(rule)).toEqual([]);
    }
    expect(
      codes({ beneficiary: 'vendedor', recipients, feePolicy: { kind: 'proportional' } }),
    ).toEqual([]);
  });

  it('exige que quem paga a tarifa participe da divisão', () => {
    const rule: SplitRule = {
      beneficiary: 'vendedor',
      recipients: [{ account: 'parceiro', percentBps: 1_000 }],
      feePolicy: { kind: 'single', payer: 'desconhecido' },
    };
    expect(codes(rule)).toEqual(['UNKNOWN_FEE_PAYER']);
  });

  it('recusa política de tarifa desconhecida', () => {
    const rule = {
      beneficiary: 'vendedor',
      recipients: [],
      feePolicy: { kind: 'metade' },
    } as unknown as SplitRule;
    expect(codes(rule)).toEqual(['INVALID_FEE_POLICY']);
  });

  it('lista todos os problemas, cada um com o campo e uma explicação', () => {
    const issues = validateSplitRule(
      withRecipients(
        { account: 'a', percentBps: 4_000 },
        { account: 'b', percentBps: 12.5 },
        { account: 'a', fixedCents: -5 },
      ),
    );
    expect(issues.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'INVALID_PERCENT', path: 'recipients[1].percentBps' },
      { code: 'DUPLICATE_ACCOUNT', path: 'recipients[2].account' },
      { code: 'INVALID_FIXED', path: 'recipients[2].fixedCents' },
    ]);
    expect(issues[0]?.message).toBe(
      'Destinatário 2: percentual inválido (12.5). Use pontos-base inteiros de 0 a 10000 (10000 = 100%).',
    );
  });
});
