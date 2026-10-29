import { PAYERS, PROVIDER_FEES, ledgerAccountFor } from '../ledger/accounts.js';
import type { LedgerEntry, NewLedgerTransaction } from '../ledger/types.js';
import { formatBRL } from '../money/cents.js';
import type { ProviderPayment } from '../providers/types.js';
import type { Charge, Divergence } from './types.js';

/**
 * Lançamento da baixa de uma cobrança paga, com o que o parceiro de fato
 * executou. O beneficiário recebe o valor inteiro e repassa a parte de cada
 * destinatário: assim o extrato dele mostra o que ele cobrou e o que repassou.
 * A tarifa sai do beneficiário.
 */
export function settlementTransaction(charge: Charge, payment: ProviderPayment): NewLedgerTransaction {
  const { beneficiary } = charge.rule;
  const beneficiaryAccount = ledgerAccountFor(beneficiary);

  const entries: LedgerEntry[] = [
    { account: PAYERS, amountCents: -payment.paidAmountCents, memo: 'Pagamento recebido' },
    { account: beneficiaryAccount, amountCents: payment.paidAmountCents, memo: 'Pagamento recebido' },
  ];
  for (const { account, amountCents } of payment.transfers) {
    if (amountCents === 0) continue;
    entries.push(
      { account: beneficiaryAccount, amountCents: -amountCents, memo: `Repasse para ${account}` },
      { account: ledgerAccountFor(account), amountCents, memo: `Repasse de ${beneficiary}` },
    );
  }
  if (payment.feeCents > 0) {
    entries.push(
      { account: beneficiaryAccount, amountCents: -payment.feeCents, memo: 'Tarifa do parceiro' },
      { account: PROVIDER_FEES, amountCents: payment.feeCents, memo: 'Tarifa do parceiro' },
    );
  }

  return {
    idempotencyKey: `settlement:${charge.id}`,
    description: `Baixa da cobrança ${charge.id}`,
    entries,
    metadata: {
      chargeId: charge.id,
      provider: charge.provider,
      providerChargeId: charge.providerChargeId,
      method: payment.method,
      paidAt: payment.paidAt,
    },
  };
}

/** Compara o que o DocPay previu na emissão com o que o parceiro executou no pagamento. */
export function findDivergences(charge: Charge, payment: ProviderPayment): Divergence[] {
  const divergences: Divergence[] = [];

  if (payment.paidAmountCents !== charge.amountCents) {
    divergences.push({
      code: 'PAID_AMOUNT_DIFFERS',
      message: `Valor pago (${formatBRL(payment.paidAmountCents)}) diferente do valor da cobrança (${formatBRL(charge.amountCents)}).`,
    });
  }

  const expected = new Map<string, number>();
  for (const share of charge.expectedShares) {
    if (share.role === 'recipient') expected.set(share.account, share.grossCents);
  }
  const executed = new Map<string, number>();
  for (const { account, amountCents } of payment.transfers) {
    executed.set(account, (executed.get(account) ?? 0) + amountCents);
  }

  for (const account of new Set([...expected.keys(), ...executed.keys()])) {
    const planned = expected.get(account) ?? 0;
    const done = executed.get(account) ?? 0;
    if (planned !== done) {
      divergences.push({
        code: 'TRANSFER_DIFFERS',
        message: `Repasse para ${account}: previsto ${formatBRL(planned)}, executado ${formatBRL(done)}.`,
      });
    }
  }

  return divergences;
}
