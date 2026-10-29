import { describe, expect, it } from 'vitest';
import type { ProviderPayment } from '../providers/types.js';
import { findDivergences, settlementTransaction } from './settlement.js';
import type { Charge } from './types.js';

function chargeFixture(): Charge {
  return {
    id: 'ch_1',
    idempotencyKey: 'docline-fatura-1',
    status: 'pending',
    amountCents: 100_000,
    dueDate: '2026-11-10',
    payer: { name: 'Maria Silva', document: '529.982.247-25' },
    rule: { beneficiary: 'vendedor', recipients: [{ account: 'parceiro', percentBps: 4_000 }] },
    expectedShares: [
      { account: 'vendedor', role: 'beneficiary', grossCents: 60_000, feeCents: 0, netCents: 60_000 },
      { account: 'parceiro', role: 'recipient', grossCents: 40_000, feeCents: 0, netCents: 40_000 },
    ],
    provider: 'simulated',
    providerChargeId: 'sim_ch_000001',
    digitableLine: '999',
    pixCopyPaste: 'SIMULADO-PIX-sim_ch_000001',
    divergences: [],
    createdAt: '2026-10-29T12:00:00.000Z',
  };
}

const payment: ProviderPayment = {
  paidAt: '2026-11-05T15:00:00.000Z',
  method: 'pix',
  paidAmountCents: 100_000,
  feeCents: 240,
  transfers: [{ account: 'parceiro', amountCents: 40_000 }],
};

describe('settlementTransaction', () => {
  it('lança o pagamento, o repasse e a tarifa, somando zero', () => {
    const transaction = settlementTransaction(chargeFixture(), payment);

    expect(transaction.idempotencyKey).toBe('settlement:ch_1');
    expect(transaction.entries).toEqual([
      { account: 'external:payers', amountCents: -100_000, memo: 'Pagamento recebido' },
      { account: 'account:vendedor', amountCents: 100_000, memo: 'Pagamento recebido' },
      { account: 'account:vendedor', amountCents: -40_000, memo: 'Repasse para parceiro' },
      { account: 'account:parceiro', amountCents: 40_000, memo: 'Repasse de vendedor' },
      { account: 'account:vendedor', amountCents: -240, memo: 'Tarifa do parceiro' },
      { account: 'external:provider-fees', amountCents: 240, memo: 'Tarifa do parceiro' },
    ]);
    expect(transaction.entries.reduce((sum, entry) => sum + entry.amountCents, 0)).toBe(0);
    expect(transaction.metadata).toEqual({
      chargeId: 'ch_1',
      provider: 'simulated',
      providerChargeId: 'sim_ch_000001',
      method: 'pix',
      paidAt: '2026-11-05T15:00:00.000Z',
    });
  });

  it('sem tarifa, não lança partida de tarifa', () => {
    const transaction = settlementTransaction(chargeFixture(), { ...payment, feeCents: 0 });
    expect(transaction.entries.map((entry) => entry.memo)).not.toContain('Tarifa do parceiro');
  });
});

describe('findDivergences', () => {
  it('não acusa nada quando o parceiro fez o previsto', () => {
    expect(findDivergences(chargeFixture(), payment)).toEqual([]);
  });

  it('acusa valor pago diferente do valor da cobrança', () => {
    expect(findDivergences(chargeFixture(), { ...payment, paidAmountCents: 101_000 })).toEqual([
      {
        code: 'PAID_AMOUNT_DIFFERS',
        message: 'Valor pago (R$ 1.010,00) diferente do valor da cobrança (R$ 1.000,00).',
      },
    ]);
  });

  it('acusa repasse diferente, faltando ou inesperado', () => {
    const divergences = findDivergences(chargeFixture(), {
      ...payment,
      transfers: [{ account: 'desconhecido', amountCents: 100 }],
    });

    expect(divergences).toEqual([
      {
        code: 'TRANSFER_DIFFERS',
        message: 'Repasse para parceiro: previsto R$ 400,00, executado R$ 0,00.',
      },
      {
        code: 'TRANSFER_DIFFERS',
        message: 'Repasse para desconhecido: previsto R$ 0,00, executado R$ 1,00.',
      },
    ]);
  });
});
