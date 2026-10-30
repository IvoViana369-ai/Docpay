import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './types.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/**
 * Aplica, em ordem, as migrações de `migrations/` que ainda não foram
 * aplicadas. Tudo numa transação só e com trava: se duas instâncias subirem
 * juntas, uma espera a outra. Devolve os nomes das migrações aplicadas agora.
 */
export async function migrate(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

  return db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['docpay:migrations']);
    await tx.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Set(
      (await tx.query<{ name: string }>('SELECT name FROM schema_migrations')).map((row) => row.name),
    );

    const pending = files.filter((name) => !applied.has(name));
    for (const name of pending) {
      await tx.exec(await readFile(join(MIGRATIONS_DIR, name), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    }
    return pending;
  });
}
