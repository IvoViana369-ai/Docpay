import type { Cents } from '../money/cents.js';
import type {
  Payer,
  PaymentMethod,
  ProviderChargeStatus,
  ProviderPayment,
  ProviderStatus,
} from '../providers/types.js';
import type { SplitRule, SplitShare } from '../split/types.js';

export interface CreateChargeInput {
  /** Chave de quem pede a cobrança. Repetir a chave não cria outra cobrança. */
  idempotencyKey: string;
  /** Texto curto que identifica a cobrança no painel do parceiro, como "DOCLINE-123". Padrão: a chave. */
  reference?: string;
  method: PaymentMethod;
  amountCents: Cents;
  /** Vencimento, no formato AAAA-MM-DD. No Pix, a cobrança vale até o fim desse dia. */
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

/**
 * pending: em aberto. paid: paga. expired: vencida e baixada pelo parceiro.
 * canceled: cancelada. failed: recusada pelo parceiro depois de criada.
 */
export type ChargeStatus = ProviderChargeStatus;

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
  reference: string;
  method: PaymentMethod;
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
  /** O status como o parceiro informou na última consulta. */
  providerStatus: ProviderStatus;
  /** Link do boleto ou da imagem do QR do Pix, quando o parceiro devolve. */
  paymentUrl?: string;
  digitableLine?: string;
  pixCopyPaste?: string;
  payment?: ChargePayment;
  divergences: Divergence[];
  createdAt: string;
}
