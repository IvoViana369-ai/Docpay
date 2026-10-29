import type { BasisPoints, Cents } from '../money/cents.js';

/** Identificador de uma conta que recebe dinheiro. No provedor, é uma subconta. */
export type AccountId = string;

/** Conta que recebe uma parte da cobrança além do beneficiário. */
export interface SplitRecipient {
  account: AccountId;
  /** Percentual sobre o valor, em pontos-base (4000 = 40%). */
  percentBps?: BasisPoints;
  /** Valor fixo em centavos. Pode ser combinado com o percentual. */
  fixedCents?: Cents;
}

/** Quem arca com a tarifa do provedor. */
export type FeePolicy =
  /** Uma conta (o beneficiário ou um destinatário) paga a tarifa inteira. */
  | { kind: 'single'; payer: AccountId }
  /** Cada conta paga a tarifa na proporção do que recebe. */
  | { kind: 'proportional' };

export interface SplitRule {
  /** Credor da cobrança. Fica com o que sobra depois dos repasses. */
  beneficiary: AccountId;
  recipients: readonly SplitRecipient[];
  /** Padrão: o beneficiário paga a tarifa inteira. */
  feePolicy?: FeePolicy;
}

export interface SplitInput {
  /** Valor a dividir, em centavos. Em geral, o valor da cobrança. */
  amountCents: Cents;
  /** Tarifa do provedor, em centavos. Padrão: 0. */
  feeCents?: Cents;
  rule: SplitRule;
}

export interface SplitShare {
  account: AccountId;
  role: 'beneficiary' | 'recipient';
  /** Parte do valor que cabe à conta. */
  grossCents: Cents;
  /** Parte da tarifa do provedor paga pela conta. */
  feeCents: Cents;
  /** O que a conta recebe de fato: grossCents - feeCents. */
  netCents: Cents;
}

export interface SplitResult {
  amountCents: Cents;
  feeCents: Cents;
  /** Beneficiário primeiro, depois os destinatários na ordem da regra. */
  shares: SplitShare[];
}
