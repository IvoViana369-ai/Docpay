import type { SignedCents } from '../money/cents.js';

/** Conta do razão. Os nomes usados ficam em `accounts.ts`. */
export type LedgerAccountId = string;

/** Uma partida: quanto entra (positivo) ou sai (negativo) de uma conta. */
export interface LedgerEntry {
  account: LedgerAccountId;
  /** Positivo entra na conta, negativo sai. Nunca zero. */
  amountCents: SignedCents;
  /** Texto curto para o extrato, por exemplo "Tarifa do parceiro". */
  memo?: string;
}

export interface NewLedgerTransaction {
  /** Repetir a mesma chave devolve o lançamento já feito, sem duplicar. */
  idempotencyKey: string;
  description: string;
  /** Precisam somar zero. */
  entries: readonly LedgerEntry[];
  metadata?: Readonly<Record<string, string>>;
}

/** Lançamento gravado. Nunca muda depois de criado. */
export interface LedgerTransaction {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly entries: readonly Readonly<LedgerEntry>[];
  readonly metadata: Readonly<Record<string, string>>;
  /** Ordem de entrada no razão, começando em 1. */
  readonly sequence: number;
  readonly postedAt: string;
}

export interface StatementLine {
  transactionId: string;
  postedAt: string;
  description: string;
  memo?: string;
  amountCents: SignedCents;
  /** Saldo da conta depois desta linha. */
  balanceCents: SignedCents;
}

export interface Ledger {
  /**
   * Grava um lançamento. Lança LedgerError se as partidas não somarem zero ou
   * se a chave já tiver sido usada com outro conteúdo.
   */
  post(transaction: NewLedgerTransaction): Promise<LedgerTransaction>;
  /** Grava o lançamento inverso (estorno). Chamar de novo devolve o mesmo estorno. */
  reverse(transactionId: string, description: string): Promise<LedgerTransaction>;
  getTransaction(id: string): Promise<LedgerTransaction | undefined>;
  balance(account: LedgerAccountId): Promise<SignedCents>;
  statement(account: LedgerAccountId): Promise<StatementLine[]>;
}
