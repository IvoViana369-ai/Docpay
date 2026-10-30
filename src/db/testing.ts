/*
 * Banco para os testes. Não é usado em produção.
 *
 * Sem DATABASE_URL, usa o PGlite: um PostgreSQL de verdade que roda dentro do
 * processo, sem instalar nada. Com DATABASE_URL (como no CI), usa o servidor
 * indicado. Nos dois casos, cada teste ganha um schema próprio e vazio, com as
 * migrações aplicadas.
 */
import { randomUUID } from 'node:crypto';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import pg from 'pg';
import { migrate } from './migrate.js';
import { nodePostgresDb } from './node-postgres.js';
import type { Db, Queryable } from './types.js';

export interface TestDatabase {
  db: Db;
  /** Apaga o schema do teste e libera as conexões. */
  close(): Promise<void>;
}

// Abrir o PGlite leva alguns segundos; cada arquivo de teste abre um só e
// separa os testes por schema. Os testes de um arquivo rodam em sequência
// (padrão do Vitest), então trocar o search_path entre eles é seguro.
let sharedPglite: Promise<PGlite> | undefined;

/** Abre o banco compartilhado antes dos testes, para o primeiro não pagar a espera. */
export async function warmUpTestDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) await pglite();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const url = process.env.DATABASE_URL;
  return url ? createOnServer(url, schema) : createOnPglite(schema);
}

function pglite(): Promise<PGlite> {
  sharedPglite ??= PGlite.create();
  return sharedPglite;
}

async function createOnPglite(schema: string): Promise<TestDatabase> {
  const instance = await pglite();
  await instance.exec(`CREATE SCHEMA ${schema}; SET search_path TO ${schema};`);
  const db: Db = {
    ...pgliteQueryable(instance),
    transaction: (fn) => instance.transaction((tx) => fn(pgliteQueryable(tx))),
  };
  await migrate(db);
  return {
    db,
    close: async () => {
      await instance.exec(`DROP SCHEMA ${schema} CASCADE`);
    },
  };
}

function pgliteQueryable(target: PGlite | Transaction): Queryable {
  return {
    async query<Row>(sql: string, params?: readonly unknown[]): Promise<Row[]> {
      const result = await target.query<Row>(sql, params ? [...params] : undefined);
      return result.rows;
    },
    async exec(sql) {
      await target.exec(sql);
    },
  };
}

async function createOnServer(url: string, schema: string): Promise<TestDatabase> {
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const db = nodePostgresDb(pool);
  await migrate(db);
  return {
    db,
    close: async () => {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
