import type { Pool, PoolClient } from 'pg';
import type { Db, Queryable } from './types.js';

/** Adapta um pool do node-postgres, o driver usado em produção, à interface Db. */
export function nodePostgresDb(pool: Pool): Db {
  return {
    ...queryable(pool),
    async transaction(fn) {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn(queryable(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // Conexão em estado ruim: o pool descarta em vez de reaproveitar.
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
  };
}

function queryable(target: Pool | PoolClient): Queryable {
  return {
    async query(sql, params) {
      const result = await target.query(sql, params ? [...params] : undefined);
      return result.rows;
    },
    async exec(sql) {
      await target.query(sql);
    },
  };
}
