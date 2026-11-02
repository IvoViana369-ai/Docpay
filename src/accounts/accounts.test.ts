import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, warmUpTestDatabase } from '../db/testing.js';
import { PostgresAccountRepository } from './postgres-repository.js';
import { InMemoryAccountRepository } from './repositories.js';
import { AccountError, saveAccount } from './save-account.js';
import type { AccountRepository } from './types.js';

const storages: { name: string; create(): Promise<{ accounts: AccountRepository; close(): Promise<void> }> }[] = [
  {
    name: 'em memória',
    create: async () => ({ accounts: new InMemoryAccountRepository(), close: async () => {} }),
  },
  {
    name: 'PostgreSQL',
    create: async () => {
      const { db, close } = await createTestDatabase();
      return { accounts: new PostgresAccountRepository(db), close };
    },
  },
];

beforeAll(() => warmUpTestDatabase(), 60_000);

const FIRST = new Date('2026-11-02T12:00:00.000Z');
const LATER = new Date('2026-11-03T09:30:00.000Z');

async function issueCodes(promise: Promise<unknown>): Promise<string[]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AccountError) return error.issues.map((issue) => `${issue.code}@${issue.path}`);
    throw error;
  }
  throw new Error('Esperava que a conta fosse recusada, mas ela foi aceita.');
}

describe.each(storages)('contas, dados $name', (storage) => {
  const opened: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of opened.splice(0)) await close();
  });

  async function setup(): Promise<AccountRepository> {
    const { accounts, close } = await storage.create();
    opened.push(close);
    return accounts;
  }

  it('cria a conta com o nome e a subconta no parceiro', async () => {
    const accounts = await setup();
    const account = await saveAccount(
      accounts,
      { id: 'docline:parceiro:42', name: ' Contabilidade Silva ', providerRefs: { safe2pay: ' 123456 ' } },
      FIRST,
    );

    expect(account).toEqual({
      id: 'docline:parceiro:42',
      name: 'Contabilidade Silva',
      providerRefs: { safe2pay: '123456' },
      createdAt: FIRST.toISOString(),
      updatedAt: FIRST.toISOString(),
    });
    expect(await accounts.get('docline:parceiro:42')).toEqual(account);
  });

  it('atualiza o nome e a subconta, mantendo a data de criação', async () => {
    const accounts = await setup();
    await saveAccount(accounts, { id: 'docline:parceiro:42', name: 'Silva' }, FIRST);
    const updated = await saveAccount(
      accounts,
      { id: 'docline:parceiro:42', name: 'Contabilidade Silva', providerRefs: { safe2pay: '654321' } },
      LATER,
    );

    expect(updated).toEqual({
      id: 'docline:parceiro:42',
      name: 'Contabilidade Silva',
      providerRefs: { safe2pay: '654321' },
      createdAt: FIRST.toISOString(),
      updatedAt: LATER.toISOString(),
    });
  });

  it('busca várias contas de uma vez, só as que existem', async () => {
    const accounts = await setup();
    await saveAccount(accounts, { id: 'a', name: 'Conta A' }, FIRST);
    await saveAccount(accounts, { id: 'b', name: 'Conta B' }, FIRST);

    const found = await accounts.getMany(['a', 'b', 'c']);
    expect([...found.keys()].sort()).toEqual(['a', 'b']);
    expect(found.get('b')?.name).toBe('Conta B');
    expect(await accounts.getMany([])).toEqual(new Map());
    expect(await accounts.get('c')).toBeUndefined();
  });

  it('recusa id inválido, nome vazio e subconta vazia, com todos os problemas', async () => {
    const accounts = await setup();

    expect(
      await issueCodes(saveAccount(accounts, { id: 'conta com espaço', name: ' ', providerRefs: { safe2pay: ' ' } }, FIRST)),
    ).toEqual([
      'INVALID_ACCOUNT_ID@id',
      'MISSING_ACCOUNT_NAME@name',
      'INVALID_PROVIDER_REF@providerRefs.safe2pay',
    ]);
    expect(await issueCodes(saveAccount(accounts, { id: 'x'.repeat(101), name: 'Longa' }, FIRST))).toEqual([
      'INVALID_ACCOUNT_ID@id',
    ]);
  });
});
