/*
 * Regras comuns às implementações do razão (em memória e PostgreSQL), para
 * que as duas se comportem igual.
 */
import { canonicalJson } from '../shared/canonical-json.js';
import { LedgerError } from './errors.js';
import type { LedgerEntry, LedgerTransaction, NewLedgerTransaction } from './types.js';
import { validateTransaction } from './validate-transaction.js';

/** Pedido conferido e copiado, pronto para gravar. */
export interface PreparedTransaction {
  entries: LedgerEntry[];
  metadata: Record<string, string>;
  /** Conteúdo do pedido, para reconhecer uma repetição da mesma chave. */
  fingerprint: string;
}

/** Confere o pedido e copia o que vai ser gravado. Lança LedgerError se ele for inválido. */
export function prepareTransaction(input: NewLedgerTransaction): PreparedTransaction {
  const issues = validateTransaction(input);
  if (issues.length > 0) {
    throw new LedgerError(
      'INVALID_TRANSACTION',
      issues.map((issue) => issue.message).join(' '),
      issues,
    );
  }
  const entries = input.entries.map(({ account, amountCents, memo }) =>
    makeEntry(account, amountCents, memo),
  );
  const metadata = { ...input.metadata };
  const fingerprint = canonicalJson({ description: input.description, entries, metadata });
  return { entries, metadata, fingerprint };
}

export function makeEntry(
  account: string,
  amountCents: number,
  memo: string | null | undefined,
): LedgerEntry {
  return memo === undefined || memo === null ? { account, amountCents } : { account, amountCents, memo };
}

export function idempotencyConflict(idempotencyKey: string): LedgerError {
  return new LedgerError(
    'IDEMPOTENCY_CONFLICT',
    `A chave ${idempotencyKey} já foi usada num lançamento diferente.`,
  );
}

export function transactionNotFound(transactionId: string): LedgerError {
  return new LedgerError('TRANSACTION_NOT_FOUND', `Lançamento ${transactionId} não encontrado.`);
}

/** Chave do estorno de um lançamento: cada lançamento tem no máximo um estorno. */
export function reversalKey(transactionId: string): string {
  return `reversal:${transactionId}`;
}

export function reversalOf(original: LedgerTransaction, description: string): NewLedgerTransaction {
  return {
    idempotencyKey: reversalKey(original.id),
    description,
    entries: original.entries.map((entry) => ({ ...entry, amountCents: -entry.amountCents })),
    metadata: { reverses: original.id },
  };
}

export function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`Valor fora do limite seguro: ${value}.`);
  }
  return Number(value);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
