import { randomUUID } from 'node:crypto';
import type { SignedCents } from '../money/cents.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { LedgerError } from './errors.js';
import type {
  Ledger,
  LedgerAccountId,
  LedgerEntry,
  LedgerTransaction,
  NewLedgerTransaction,
  StatementLine,
} from './types.js';
import { validateTransaction } from './validate-transaction.js';

export interface InMemoryLedgerOptions {
  now?: () => Date;
  newId?: () => string;
}

/**
 * Razão em memória. É a referência das regras do razão e serve aos testes;
 * a versão em PostgreSQL vai seguir a mesma interface e as mesmas regras.
 */
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
    const issues = validateTransaction(input);
    if (issues.length > 0) {
      throw new LedgerError(
        'INVALID_TRANSACTION',
        issues.map((issue) => issue.message).join(' '),
        issues,
      );
    }

    const entries = input.entries.map(copyEntry);
    const metadata = { ...input.metadata };
    const fingerprint = canonicalJson({ description: input.description, entries, metadata });

    const previous = this.#byKey.get(input.idempotencyKey);
    if (previous) {
      if (previous.fingerprint === fingerprint) return previous.transaction;
      throw new LedgerError(
        'IDEMPOTENCY_CONFLICT',
        `A chave ${input.idempotencyKey} já foi usada num lançamento diferente.`,
      );
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
    if (!original) {
      throw new LedgerError('TRANSACTION_NOT_FOUND', `Lançamento ${transactionId} não encontrado.`);
    }

    const idempotencyKey = `reversal:${original.id}`;
    const previous = this.#byKey.get(idempotencyKey);
    if (previous) return previous.transaction;

    return this.post({
      idempotencyKey,
      description,
      entries: original.entries.map((entry) => ({ ...entry, amountCents: -entry.amountCents })),
      metadata: { reverses: original.id },
    });
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

function copyEntry({ account, amountCents, memo }: LedgerEntry): LedgerEntry {
  return memo === undefined ? { account, amountCents } : { account, amountCents, memo };
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`Saldo fora do limite seguro: ${value}.`);
  }
  return Number(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
