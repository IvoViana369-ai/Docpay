import { isoTimestamp } from '../db/sql.js';
import type { Db } from '../db/types.js';
import type { AccountId } from '../split/types.js';
import type { Account, AccountInput, AccountRepository } from './types.js';

interface AccountRow {
  id: string;
  name: string;
  provider_refs: Record<string, string>;
  created_at: string;
  updated_at: string;
}

const COLUMNS = `id, name, provider_refs, ${isoTimestamp('created_at')} AS created_at, ${isoTimestamp('updated_at')} AS updated_at`;

/** Contas em PostgreSQL. */
export class PostgresAccountRepository implements AccountRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async upsert(input: Required<AccountInput>, now: string): Promise<Account> {
    const [row] = await this.#db.query<AccountRow>(
      `INSERT INTO accounts (id, name, provider_refs, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $4)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, provider_refs = EXCLUDED.provider_refs, updated_at = EXCLUDED.updated_at
       RETURNING ${COLUMNS}`,
      [input.id, input.name, JSON.stringify(input.providerRefs), now],
    );
    return toAccount(row!);
  }

  async get(id: AccountId): Promise<Account | undefined> {
    const [row] = await this.#db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE id = $1`, [id]);
    return row && toAccount(row);
  }

  async getMany(ids: readonly AccountId[]): Promise<Map<AccountId, Account>> {
    if (ids.length === 0) return new Map();
    const rows = await this.#db.query<AccountRow>(
      `SELECT ${COLUMNS} FROM accounts WHERE id = ANY($1::text[])`,
      [[...ids]],
    );
    return new Map(rows.map((row) => [row.id, toAccount(row)]));
  }
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    providerRefs: row.provider_refs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
