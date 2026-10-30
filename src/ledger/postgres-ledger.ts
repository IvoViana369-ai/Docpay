import { randomUUID } from 'node:crypto';
import { isoTimestamp } from '../db/sql.js';
import type { Db, Queryable } from '../db/types.js';
import type { SignedCents } from '../money/cents.js';
import { LedgerError } from './errors.js';
import {
  deepFreeze,
  idempotencyConflict,
  makeEntry,
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

export interface PostgresLedgerOptions {
  now?: () => Date;
  newId?: () => string;
}

// Nas consultas abaixo, bigint sai como texto, para nenhum driver perder precisão.

interface TransactionRow {
  id: string;
  sequence: string;
  idempotency_key: string;
  fingerprint: string;
  description: string;
  metadata: Record<string, string>;
  posted_at: string;
}

interface EntryRow {
  account: string;
  amount_cents: string;
  memo: string | null;
}

/** Razão em PostgreSQL. O banco também garante soma zero, imutabilidade e chave única. */
export class PostgresLedger implements Ledger {
  readonly #db: Db;
  readonly #now: () => Date;
  readonly #newId: () => string;

  constructor(db: Db, options: PostgresLedgerOptions = {}) {
    this.#db = db;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => randomUUID());
  }

  async post(input: NewLedgerTransaction): Promise<LedgerTransaction> {
    const { entries, metadata, fingerprint } = prepareTransaction(input);
    const id = this.#newId();
    const postedAt = this.#now().toISOString();

    return this.#db.transaction(async (tx) => {
      // Se outra transação estiver gravando a mesma chave, o banco espera ela
      // terminar; aí não insere nada e o lançamento dela é lido abaixo.
      const [inserted] = await tx.query<{ sequence: string }>(
        `INSERT INTO ledger_transactions (id, idempotency_key, fingerprint, description, metadata, posted_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING sequence::text AS sequence`,
        [id, input.idempotencyKey, fingerprint, input.description, JSON.stringify(metadata), postedAt],
      );
      if (!inserted) {
        const existing = await findTransaction(tx, 'idempotency_key', input.idempotencyKey);
        if (existing?.fingerprint === fingerprint) return existing.transaction;
        throw idempotencyConflict(input.idempotencyKey);
      }

      const params: unknown[] = [];
      const rows = entries.map((entry, position) => {
        params.push(id, position, entry.account, String(entry.amountCents), entry.memo ?? null);
        const n = params.length;
        return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}::bigint, $${n})`;
      });
      await tx.query(
        `INSERT INTO ledger_entries (transaction_id, position, account, amount_cents, memo) VALUES ${rows.join(', ')}`,
        params,
      );

      return deepFreeze({
        id,
        idempotencyKey: input.idempotencyKey,
        description: input.description,
        entries,
        metadata,
        sequence: Number(inserted.sequence),
        postedAt,
      });
    });
  }

  async reverse(transactionId: string, description: string): Promise<LedgerTransaction> {
    const original = await this.getTransaction(transactionId);
    if (!original) throw transactionNotFound(transactionId);

    const key = reversalKey(original.id);
    const previous = await findTransaction(this.#db, 'idempotency_key', key);
    if (previous) return previous.transaction;

    try {
      return await this.post(reversalOf(original, description));
    } catch (error) {
      // Outro estorno do mesmo lançamento, com outra descrição, gravou primeiro.
      if (error instanceof LedgerError && error.code === 'IDEMPOTENCY_CONFLICT') {
        const winner = await findTransaction(this.#db, 'idempotency_key', key);
        if (winner) return winner.transaction;
      }
      throw error;
    }
  }

  async getTransaction(id: string): Promise<LedgerTransaction | undefined> {
    return (await findTransaction(this.#db, 'id', id))?.transaction;
  }

  async balance(account: LedgerAccountId): Promise<SignedCents> {
    const [row] = await this.#db.query<{ balance: string }>(
      'SELECT coalesce(sum(amount_cents), 0)::text AS balance FROM ledger_entries WHERE account = $1',
      [account],
    );
    return toSafeNumber(BigInt(row?.balance ?? '0'));
  }

  async statement(account: LedgerAccountId): Promise<StatementLine[]> {
    const rows = await this.#db.query<EntryRow & { transaction_id: string; description: string; posted_at: string }>(
      `SELECT t.id AS transaction_id, t.description, ${isoTimestamp('t.posted_at')} AS posted_at,
              e.account, e.amount_cents::text AS amount_cents, e.memo
         FROM ledger_entries e
         JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE e.account = $1
        ORDER BY t.sequence, e.position`,
      [account],
    );

    let balance = 0n;
    return rows.map((row) => {
      const amount = BigInt(row.amount_cents);
      balance += amount;
      const line: StatementLine = {
        transactionId: row.transaction_id,
        postedAt: row.posted_at,
        description: row.description,
        amountCents: toSafeNumber(amount),
        balanceCents: toSafeNumber(balance),
      };
      if (row.memo !== null) line.memo = row.memo;
      return line;
    });
  }
}

async function findTransaction(
  q: Queryable,
  column: 'id' | 'idempotency_key',
  value: string,
): Promise<{ transaction: LedgerTransaction; fingerprint: string } | undefined> {
  const [row] = await q.query<TransactionRow>(
    `SELECT id, sequence::text AS sequence, idempotency_key, fingerprint, description, metadata,
            ${isoTimestamp('posted_at')} AS posted_at
       FROM ledger_transactions
      WHERE ${column} = $1`,
    [value],
  );
  if (!row) return undefined;

  const entries = await q.query<EntryRow>(
    `SELECT account, amount_cents::text AS amount_cents, memo
       FROM ledger_entries
      WHERE transaction_id = $1
      ORDER BY position`,
    [row.id],
  );

  return {
    fingerprint: row.fingerprint,
    transaction: deepFreeze({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      description: row.description,
      entries: entries.map((entry) =>
        makeEntry(entry.account, toSafeNumber(BigInt(entry.amount_cents)), entry.memo),
      ),
      metadata: row.metadata,
      sequence: Number(row.sequence),
      postedAt: row.posted_at,
    }),
  };
}
