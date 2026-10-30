import { randomUUID } from 'node:crypto';
import type { SignedCents } from '../money/cents.js';
import {
  deepFreeze,
  idempotencyConflict,
  prepareTransaction,
  reversalKey,
  reversalOf,
  toSafeNumber,
  transactionNotFound,
} from './internal.js';
import type {
  Ledger,
  LedgerAccountId,
  LedgerTransaction,
  NewLedgerTransaction,
  StatementLine,
} from './types.js';

export interface InMemoryLedgerOptions {
  now?: () => Date;
  newId?: () => string;
}

/** Razão em memória, para testes e desenvolvimento. Segue as mesmas regras do razão em PostgreSQL. */
export class InMemoryLedger implements Ledger {
  readonly #transactions: LedgerTransaction[] = [];
  readonly #byId = new Map<string, LedgerTransaction>();
  readonly #byKey = new Map<string, { transaction: LedgerTransaction; fingerprint: string }>();
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(options: InMemoryLedgerOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
  }

  async post(input: NewLedgerTransaction): Promise<LedgerTransaction> {
    const { entries, metadata, fingerprint } = prepareTransaction(input);

    const previous = this.#byKey.get(input.idempotencyKey);
    if (previous) {
      if (previous.fingerprint === fingerprint) return previous.transaction;
      throw idempotencyConflict(input.idempotencyKey);
    }

    const transaction: LedgerTransaction = deepFreeze({
      id: this.#newId(),
      idempotencyKey: input.idempotencyKey,
      description: input.description,
      entries,
      metadata,
      sequence: this.#transactions.length + 1,
      postedAt: this.#now().toISOString(),
    });
    this.#transactions.push(transaction);
    this.#byId.set(transaction.id, transaction);
    this.#byKey.set(transaction.idempotencyKey, { transaction, fingerprint });
    return transaction;
  }

  async reverse(transactionId: string, description: string): Promise<LedgerTransaction> {
    const original = this.#byId.get(transactionId);
    if (!original) throw transactionNotFound(transactionId);

    const previous = this.#byKey.get(reversalKey(original.id));
    if (previous) return previous.transaction;
    return this.post(reversalOf(original, description));
  }

  async getTransaction(id: string): Promise<LedgerTransaction | undefined> {
    return this.#byId.get(id);
  }

  async balance(account: LedgerAccountId): Promise<SignedCents> {
    let total = 0n;
    for (const { entries } of this.#transactions) {
      for (const entry of entries) {
        if (entry.account === account) total += BigInt(entry.amountCents);
      }
    }
    return toSafeNumber(total);
  }

  async statement(account: LedgerAccountId): Promise<StatementLine[]> {
    const lines: StatementLine[] = [];
    let balance = 0n;
    for (const transaction of this.#transactions) {
      for (const entry of transaction.entries) {
        if (entry.account !== account) continue;
        balance += BigInt(entry.amountCents);
        const line: StatementLine = {
          transactionId: transaction.id,
          postedAt: transaction.postedAt,
          description: transaction.description,
          amountCents: entry.amountCents,
          balanceCents: toSafeNumber(balance),
        };
        if (entry.memo !== undefined) line.memo = entry.memo;
        lines.push(line);
      }
    }
    return lines;
  }
}
