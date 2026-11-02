import type { Db } from '../db/types.js';

export type ClaimResult =
  | { acquired: true }
  | { acquired: false; fingerprint: string; claimedAt: string };

/**
 * Reserva da chave de idempotência enquanto o DocPay fala com o parceiro.
 * Alguns parceiros (como a Safe2Pay) não reconhecem a chave: sem a reserva,
 * duas chamadas ao mesmo tempo criariam duas cobranças.
 */
export interface ChargeClaims {
  /**
   * Reserva a chave. Uma reserva do mesmo pedido feita antes de `staleBefore`
   * é de uma tentativa que parou no meio e pode ser assumida.
   */
  acquire(idempotencyKey: string, fingerprint: string, now: string, staleBefore: string): Promise<ClaimResult>;
  release(idempotencyKey: string): Promise<void>;
}

export class InMemoryChargeClaims implements ChargeClaims {
  readonly #claims = new Map<string, { fingerprint: string; claimedAt: string }>();

  async acquire(idempotencyKey: string, fingerprint: string, now: string, staleBefore: string): Promise<ClaimResult> {
    const current = this.#claims.get(idempotencyKey);
    if (current && !(current.fingerprint === fingerprint && current.claimedAt < staleBefore)) {
      return { acquired: false, ...current };
    }
    this.#claims.set(idempotencyKey, { fingerprint, claimedAt: now });
    return { acquired: true };
  }

  async release(idempotencyKey: string): Promise<void> {
    this.#claims.delete(idempotencyKey);
  }
}

export class PostgresChargeClaims implements ChargeClaims {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async acquire(idempotencyKey: string, fingerprint: string, now: string, staleBefore: string): Promise<ClaimResult> {
    const acquired = await this.#db.query(
      `INSERT INTO charge_claims (idempotency_key, fingerprint, claimed_at) VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO UPDATE SET claimed_at = EXCLUDED.claimed_at
         WHERE charge_claims.fingerprint = EXCLUDED.fingerprint AND charge_claims.claimed_at < $4
       RETURNING idempotency_key`,
      [idempotencyKey, fingerprint, now, staleBefore],
    );
    if (acquired.length > 0) return { acquired: true };

    const [current] = await this.#db.query<{ fingerprint: string; claimed_at: string }>(
      `SELECT fingerprint, to_char(claimed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS claimed_at
         FROM charge_claims WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    // A reserva pode ter sido liberada entre os dois comandos: tenta de novo.
    if (!current) return this.acquire(idempotencyKey, fingerprint, now, staleBefore);
    return { acquired: false, fingerprint: current.fingerprint, claimedAt: current.claimed_at };
  }

  async release(idempotencyKey: string): Promise<void> {
    await this.#db.query('DELETE FROM charge_claims WHERE idempotency_key = $1', [idempotencyKey]);
  }
}
