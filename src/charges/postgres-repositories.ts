import { isoTimestamp } from '../db/sql.js';
import type { Db } from '../db/types.js';
import type { ChargeRepository, PendingCursor, ReceivedWebhook, WebhookInbox } from './repositories.js';
import type { Charge } from './types.js';

/**
 * Cobranças em PostgreSQL. A coluna `document` guarda a cobrança inteira; as
 * outras colunas servem para buscar e para o banco garantir as regras.
 */
export class PostgresChargeRepository implements ChargeRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async insert(charge: Charge): Promise<boolean> {
    const rows = await this.#db.query(
      `INSERT INTO charges (id, idempotency_key, provider, provider_charge_id, status, document, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        charge.id,
        charge.idempotencyKey,
        charge.provider,
        charge.providerChargeId,
        charge.status,
        JSON.stringify(charge),
        charge.createdAt,
      ],
    );
    return rows.length > 0;
  }

  async update(charge: Charge): Promise<void> {
    const rows = await this.#db.query(
      `UPDATE charges SET status = $2, document = $3::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [charge.id, charge.status, JSON.stringify(charge)],
    );
    if (rows.length === 0) throw new Error(`Cobrança ${charge.id} não existe.`);
  }

  findById(id: string): Promise<Charge | undefined> {
    return this.#findOne('id = $1', [id]);
  }

  findByIdempotencyKey(idempotencyKey: string): Promise<Charge | undefined> {
    return this.#findOne('idempotency_key = $1', [idempotencyKey]);
  }

  findByProviderChargeId(provider: string, providerChargeId: string): Promise<Charge | undefined> {
    return this.#findOne('provider = $1 AND provider_charge_id = $2', [provider, providerChargeId]);
  }

  async findPending({ limit, after }: { limit: number; after?: PendingCursor }): Promise<Charge[]> {
    const rows = after
      ? await this.#db.query<{ document: Charge }>(
          `SELECT document FROM charges
            WHERE status = 'pending' AND (created_at, id) > ($1::timestamptz, $2)
            ORDER BY created_at, id
            LIMIT $3`,
          [after.createdAt, after.id, limit],
        )
      : await this.#db.query<{ document: Charge }>(
          `SELECT document FROM charges
            WHERE status = 'pending'
            ORDER BY created_at, id
            LIMIT $1`,
          [limit],
        );
    return rows.map((row) => row.document);
  }

  async #findOne(condition: string, params: readonly unknown[]): Promise<Charge | undefined> {
    const [row] = await this.#db.query<{ document: Charge }>(
      `SELECT document FROM charges WHERE ${condition}`,
      params,
    );
    return row?.document;
  }
}

export class PostgresWebhookInbox implements WebhookInbox {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async save(webhook: ReceivedWebhook): Promise<void> {
    await this.#db.query(
      'INSERT INTO webhook_inbox (provider, body, received_at) VALUES ($1, $2, $3)',
      [webhook.provider, webhook.body, webhook.receivedAt],
    );
  }

  async recent(limit: number): Promise<ReceivedWebhook[]> {
    const rows = await this.#db.query<{ provider: string; body: string; received_at: string }>(
      `SELECT provider, body, ${isoTimestamp('received_at')} AS received_at
         FROM webhook_inbox
        ORDER BY id DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({ provider: row.provider, body: row.body, receivedAt: row.received_at }));
  }
}
