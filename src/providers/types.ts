import type { Cents } from '../money/cents.js';
import type { AccountId } from '../split/types.js';

export type PaymentMethod = 'boleto' | 'pix';

export interface Payer {
  name: string;
  /** CPF ou CNPJ, com ou sem pontuação. */
  document: string;
  email?: string;
}

/** Repasse para um destinatário, em centavos fixos. */
export interface Transfer {
  account: AccountId;
  amountCents: Cents;
}

export interface ProviderChargeRequest {
  /** O parceiro usa a chave para não criar a mesma cobrança duas vezes. */
  idempotencyKey: string;
  /** Credor da cobrança: aparece no boleto e fica com o restante. */
  beneficiary: AccountId;
  amountCents: Cents;
  /** Vencimento, no formato AAAA-MM-DD. */
  dueDate: string;
  payer: Payer;
  /** Repasses calculados pelo DocPay. O parceiro só executa. */
  transfers: readonly Transfer[];
  description?: string;
}

export interface ProviderPayment {
  paidAt: string;
  method: PaymentMethod;
  paidAmountCents: Cents;
  /** Tarifa do parceiro, descontada do beneficiário. */
  feeCents: Cents;
  /** Repasses que o parceiro de fato executou. */
  transfers: Transfer[];
}

export interface ProviderCharge {
  id: string;
  status: 'pending' | 'paid';
  beneficiary: AccountId;
  amountCents: Cents;
  dueDate: string;
  /** Repasses pedidos na emissão. */
  transfers: Transfer[];
  /** Linha digitável do boleto. */
  digitableLine: string;
  /** Código do Pix copia e cola. */
  pixCopyPaste: string;
  payment?: ProviderPayment;
}

/** O que se aproveita de um aviso (webhook) do parceiro. */
export interface ProviderWebhook {
  eventId: string;
  chargeId: string;
}

/** O que o DocPay precisa de um parceiro. Cada parceiro real terá um adaptador com esta interface. */
export interface PaymentProvider {
  readonly name: string;
  createCharge(request: ProviderChargeRequest): Promise<ProviderCharge>;
  getCharge(chargeId: string): Promise<ProviderCharge>;
  /**
   * Lê o corpo de um aviso. O conteúdo não é confiável, porque qualquer um
   * pode mandar um aviso falso: serve só para saber qual cobrança consultar.
   */
  parseWebhook(body: string): ProviderWebhook;
}
