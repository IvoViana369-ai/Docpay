import type { AccountId } from '../split/types.js';
import type { LedgerAccountId } from './types.js';

/*
 * O razão do DocPay é um espelho: mostra onde está o dinheiro dentro do
 * parceiro. Cada conta do DocPay tem um saldo, e duas contas externas mostram
 * de onde o dinheiro veio e para onde foram as tarifas.
 */

/** Dinheiro que entrou dos pagadores. Fica negativo: é dinheiro que veio de fora. */
export const PAYERS: LedgerAccountId = 'external:payers';

/** Tarifas cobradas pelo parceiro. */
export const PROVIDER_FEES: LedgerAccountId = 'external:provider-fees';

/** Saldo de uma conta do DocPay (no parceiro, a subconta). */
export function ledgerAccountFor(account: AccountId): LedgerAccountId {
  return `account:${account}`;
}
