import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, warmUpTestDatabase, type TestDatabase } from './testing.js';
import type { Db } from './types.js';

// Comportamento das transações em qualquer driver: com DATABASE_URL, estes
// testes exercitam o node-postgres, que é o driver de produção.

beforeAll(() => warmUpTestDatabase(), 60_000);

describe('transações do banco', () => {
  const opened: TestDatabase[] = [];
  afterEach(async () => {
    for (const database of opened.splice(0)) await database.close();
  });

  async function openWithTable(): Promise<Db> {
    const database = await createTestDatabase();
    opened.push(database);
    await database.db.exec('CREATE TABLE numbers (value integer PRIMARY KEY)');
    return database.db;
  }

  async function values(db: Db): Promise<number[]> {
    const rows = await db.query<{ value: number }>('SELECT value FROM numbers ORDER BY value');
    return rows.map((row) => row.value);
  }

  it('confirma tudo quando dá certo', async () => {
    const db = await openWithTable();
    const result = await db.transaction(async (tx) => {
      await tx.query('INSERT INTO numbers VALUES (1), (2)');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(await values(db)).toEqual([1, 2]);
  });

  it('um erro do banco no meio desfaz tudo, e a conexão continua utilizável', async () => {
    const db = await openWithTable();

    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO numbers VALUES (1)');
        await tx.query('INSERT INTO numbers VALUES (1)');
      }),
    ).rejects.toThrow();

    expect(await values(db)).toEqual([]);
    await db.transaction((tx) => tx.query('INSERT INTO numbers VALUES (2)'));
    expect(await values(db)).toEqual([2]);
  });

  it('um erro do código no meio também desfaz tudo', async () => {
    const db = await openWithTable();

    await expect(
      db.transaction(async (tx) => {
        await tx.query('INSERT INTO numbers VALUES (3)');
        throw new Error('Falhou no meio.');
      }),
    ).rejects.toThrow('Falhou no meio.');

    expect(await values(db)).toEqual([]);
  });
});
