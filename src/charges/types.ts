import type { Cents } from '../money/cents.js';
import type { Payer, ProviderPayment } from '../providers/types.js';
import type { SplitRule, SplitShare } from '../split/types.js';

export interface CreateChargeInput {
  /** Chave de quem pede a cobrança. Repetir a chave não cria outra cobrança. */
  idempotencyKey: string;
  amountCents: Cents;
  /** Vencimento, no formato AAAA-MM-DD. */
  dueDate: string;
  payer: Payer;
  rule: SplitRule;
  description?: string;
  /**
   * Chave de acesso da NFS-e ligada à cobrança. O split tributário da reforma,
   * previsto a partir de 2027, vai exigir esse vínculo.
   */
  fiscalDocumentKey?: string;
}

export type ChargeStatus = 'pending' | 'paid';

/** Diferença entre o que o DocPay previu e o que o parceiro executou. */
export interface Divergence {
  code: 'PAID_AMOUNT_DIFFERS' | 'TRANSFER_DIFFERS';
  message: string;
}

export interface ChargePayment extends ProviderPayment {
  /** Lançamento da baixa no razão. */
  ledgerTransactionId: string;
}

export interface Charge {
  id: string;
  idempotencyKey: string;
  status: ChargeStatus;
  amountCents: Cents;
  dueDate: string;
  payer: Payer;
  description?: string;
  fiscalDocumentKey?: string;
  /** Regra usada na emissão, guardada como estava. */
  rule: SplitRule;
  /** Divisão prevista na emissão, antes da tarifa. */
  expectedShares: SplitShare[];
  provider: string;
  providerChargeId: string;
  digitableLine: string;
  pixCopyPaste: string;
  payment?: ChargePayment;
  divergences: Divergence[];
  createdAt: string;
}
