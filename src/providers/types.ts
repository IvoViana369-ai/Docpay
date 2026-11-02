import type { Cents } from '../money/cents.js';
import type { AccountId } from '../split/types.js';

export type PaymentMethod = 'boleto' | 'pix';

export interface PayerAddress {
  /** CEP, com ou sem traço. */
  zipCode: string;
  street: string;
  /** Sem número, vai "S/N". */
  number?: string;
  complement?: string;
  district: string;
  city: string;
  /** UF, duas letras. */
  state: string;
}

export interface Payer {
  name: string;
  /** CPF ou CNPJ, com ou sem pontuação. */
  document: string;
  email?: string;
  phone?: string;
  /** Obrigatório no boleto: o banco exige o endereço de quem paga. */
  address?: PayerAddress;
}

/** Repasse para um destinatário, em centavos fixos. */
export interface Transfer {
  account: AccountId;
  amountCents: Cents;
}

export interface ProviderChargeRequest {
  /** Chave de idempotência da cobrança. */
  idempotencyKey: string;
  /** Texto curto que identifica a cobrança no painel do parceiro, como "DOCLINE-123". */
  reference: string;
  /** Credor da cobrança: aparece no boleto e fica com o restante. */
  beneficiary: AccountId;
  method: PaymentMethod;
  amountCents: Cents;
  /** Vencimento, no formato AAAA-MM-DD. */
  dueDate: string;
  payer: Payer;
  /** Repasses calculados pelo DocPay. O parceiro só executa. */
  transfers: readonly Transfer[];
  description?: string;
}

/** Status da cobrança no parceiro, traduzido para o DocPay. */
export type ProviderChargeStatus = 'pending' | 'paid' | 'expired' | 'canceled' | 'failed';

/** O status como o parceiro informa, para conferência. */
export interface ProviderStatus {
  code: string;
  label: string;
}

export interface ProviderPayment {
  paidAt: string;
  method: PaymentMethod;
  paidAmountCents: Cents;
  /** Tarifa do parceiro, descontada do beneficiário. */
  feeCents: Cents;
  /** Repasses executados. */
  transfers: Transfer[];
}

export interface ProviderCharge {
  id: string;
  status: ProviderChargeStatus;
  providerStatus: ProviderStatus;
  /** Link da página ou do PDF do boleto, quando o parceiro devolve. */
  paymentUrl?: string;
  /** Linha digitável do boleto. */
  digitableLine?: string;
  /** Imagem do QR do Pix: um link ou a imagem PNG em base64, como o parceiro devolve. */
  pixQrCodeImage?: string;
  /** Código do Pix copia e cola. */
  pixCopyPaste?: string;
  payment?: ProviderPayment;
}

/**
 * O que o DocPay sabe de uma cobrança. Vai junto na consulta, para o parceiro
 * completar o que a resposta dele não traz (a Safe2Pay, por exemplo, não
 * devolve a tarifa nem os repasses na consulta).
 */
export interface ProviderChargeRef {
  id: string;
  method: PaymentMethod;
  amountCents: Cents;
  transfers: readonly Transfer[];
}

/** Aviso (webhook) recebido do parceiro, como chegou. */
export interface IncomingWebhook {
  body: string;
  /** Parâmetros do endereço do aviso, como a chave `k` da Safe2Pay. */
  query: Readonly<Record<string, string | undefined>>;
}

/** O que se aproveita de um aviso: quais cobranças consultar. */
export interface ProviderWebhook {
  chargeIds: string[];
}

/** O que o DocPay precisa de um parceiro. Cada parceiro tem um adaptador com esta interface. */
export interface PaymentProvider {
  readonly name: string;
  /** Ambiente de teste (o parceiro simulado ou o sandbox do parceiro): nada ali é dinheiro de verdade. */
  readonly sandbox: boolean;
  createCharge(request: ProviderChargeRequest): Promise<ProviderCharge>;
  getCharge(ref: ProviderChargeRef): Promise<ProviderCharge>;
  /**
   * Confere e lê um aviso do parceiro. O conteúdo nunca é confiável: serve só
   * para saber quais cobranças consultar.
   */
  parseWebhook(webhook: IncomingWebhook): ProviderWebhook;
}
