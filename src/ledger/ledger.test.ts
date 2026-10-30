import fc from 'fast-check';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, warmUpTestDatabase } from '../db/testing.js';
import { LedgerError } from './errors.js';
import { InMemoryLedger } from './in-memory-ledger.js';
import { PostgresLedger } from './postgres-ledger.js';
import type { Ledger, LedgerEntry, NewLedgerTransaction } from './types.js';

const POSTED_AT = '2026-10-29T12:00:00.000Z';

interface LedgerOptions {
  now: () => Date;
  newId: () => string;
}

// As duas implementações passam pelos mesmos testes, para se comportarem igual.
const implementations = [
  {
    name: 'em memória',
    create: async (options: LedgerOptions) => ({
      ledger: new InMemoryLedger(options) as Ledger,
      close: async () => {},
    }),
  },
  {
    name: 'PostgreSQL',
    create: async (options: LedgerOptions) => {
      const { db, close } = await createTestDatabase();
      return { ledger: new PostgresLedger(db, options) as Ledger, close };
    },
  },
];

beforeAll(() => warmUpTestDatabase(), 60_000);

async function rejection(promise: Promise<unknown>): Promise<LedgerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LedgerError) return error;
    throw error;
  }
  throw new Error('Esperava que o razão recusasse o pedido, mas ele foi aceito.');
}

const payment: NewLedgerTransaction = {
  idempotencyKey: 'pagamento-1',
  description: 'Pagamento recebido',
  entries: [
    { account: 'external:payers', amountCents: -10_000 },
    { account: 'account:vendedor', amountCents: 10_000, memo: 'Pagamento' },
  ],
};

describe.each(implementations)('razão $name', (implementation) => {
  const opened: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of opened.splice(0)) await close();
  });

  async function newLedger(): Promise<Ledger> {
    let count = 0;
    const { ledger, close } = await implementation.create({
      now: () => new Date(POSTED_AT),
      newId: () => `tx_${++count}`,
    });
    opened.push(close);
    return ledger;
  }

  it('grava o lançamento e atualiza os saldos', async () => {
    const ledger = await newLedger();
    const transaction = await ledger.post(payment);

    expect(transaction).toEqual({
      id: 'tx_1',
      idempotencyKey: 'pagamento-1',
      description: 'Pagamento recebido',
      entries: payment.entries,
      metadata: {},
      sequence: 1,
      postedAt: POSTED_AT,
    });
    expect(await ledger.balance('account:vendedor')).toBe(10_000);
    expect(await ledger.balance('external:payers')).toBe(-10_000);
    expect(await ledger.balance('account:sem-movimento')).toBe(0);
    expect(await ledger.getTransaction('tx_1')).toEqual(transaction);
    expect(await ledger.getTransaction('tx_999')).toBeUndefined();
  });

  it('monta o extrato com o saldo depois de cada linha', async () => {
    const ledger = await newLedger();
    await ledger.post(payment);
    await ledger.post({
      idempotencyKey: 'tarifa-1',
      description: 'Tarifa',
      entries: [
        { account: 'account:vendedor', amountCents: -199, memo: 'Tarifa do parceiro' },
        { account: 'external:provider-fees', amountCents: 199 },
      ],
    });

    expect(await ledger.statement('account:vendedor')).toEqual([
      {
        transactionId: 'tx_1',
        postedAt: POSTED_AT,
        description: 'Pagamento recebido',
        memo: 'Pagamento',
        amountCents: 10_000,
        balanceCents: 10_000,
      },
      {
        transactionId: 'tx_2',
        postedAt: POSTED_AT,
        description: 'Tarifa',
        memo: 'Tarifa do parceiro',
        amountCents: -199,
        balanceCents: 9_801,
      },
    ]);
    expect(await ledger.statement('account:sem-movimento')).toEqual([]);
  });

  it('guarda os dados extras do lançamento', async () => {
    const ledger = await newLedger();
    const transaction = await ledger.post({ ...payment, metadata: { chargeId: 'ch_1' } });

    expect((await ledger.getTransaction(transaction.id))?.metadata).toEqual({ chargeId: 'ch_1' });
  });

  it('recusa lançamento que não soma zero', async () => {
    const ledger = await newLedger();
    const error = await rejection(
      ledger.post({
        ...payment,
        entries: [
          { account: 'external:payers', amountCents: -10_000 },
          { account: 'account:vendedor', amountCents: 9_999 },
        ],
      }),
    );

    expect(error.code).toBe('INVALID_TRANSACTION');
    expect(error.issues.map((issue) => issue.code)).toEqual(['UNBALANCED']);
    expect(error.message).toBe('As partidas somam -R$ 0,01, mas um lançamento precisa somar zero.');
  });

  it('confere a soma sem perder precisão', async () => {
    const ledger = await newLedger();
    // Somados como número comum, estes valores dariam zero por arredondamento; a soma real é 1.
    const error = await rejection(
      ledger.post({
        ...payment,
        entries: [
          { account: 'a', amountCents: Number.MAX_SAFE_INTEGER },
          { account: 'b', amountCents: 2 },
          { account: 'c', amountCents: -Number.MAX_SAFE_INTEGER },
          { account: 'd', amountCents: -1 },
        ],
      }),
    );

    expect(error.issues.map((issue) => issue.code)).toEqual(['UNBALANCED']);
  });

  it('grava e lê valores muito altos sem perder precisão', async () => {
    const ledger = await newLedger();
    await ledger.post({
      ...payment,
      entries: [
        { account: 'a', amountCents: Number.MAX_SAFE_INTEGER },
        { account: 'b', amountCents: -Number.MAX_SAFE_INTEGER },
      ],
    });

    expect(await ledger.balance('a')).toBe(Number.MAX_SAFE_INTEGER);
    expect((await ledger.statement('b'))[0]?.balanceCents).toBe(-Number.MAX_SAFE_INTEGER);
  });

  it('recusa partida com valor zero ou fração de centavo', async () => {
    const ledger = await newLedger();
    const error = await rejection(
      ledger.post({
        ...payment,
        entries: [
          { account: 'a', amountCents: 0 },
          { account: 'b', amountCents: 1.5 },
        ],
      }),
    );

    expect(error.issues.map((issue) => issue.code)).toEqual(['INVALID_AMOUNT', 'INVALID_AMOUNT']);
  });

  it('exige pelo menos duas partidas, em contas diferentes', async () => {
    const ledger = await newLedger();
    const single = await rejection(ledger.post({ ...payment, entries: [{ account: 'a', amountCents: 5 }] }));
    expect(single.issues.map((issue) => issue.code)).toEqual(['TOO_FEW_ENTRIES', 'UNBALANCED']);

    const sameAccount = await rejection(
      ledger.post({
        ...payment,
        entries: [
          { account: 'a', amountCents: 5 },
          { account: 'a', amountCents: -5 },
        ],
      }),
    );
    expect(sameAccount.issues.map((issue) => issue.code)).toEqual(['SINGLE_ACCOUNT']);
  });

  it('exige chave, descrição e conta em cada partida', async () => {
    const ledger = await newLedger();
    const error = await rejection(
      ledger.post({
        idempotencyKey: '',
        description: '  ',
        entries: [
          { account: '', amountCents: 5 },
          { account: 'b', amountCents: -5 },
        ],
      }),
    );

    expect(error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: 'MISSING_IDEMPOTENCY_KEY', path: 'idempotencyKey' },
      { code: 'MISSING_DESCRIPTION', path: 'description' },
      { code: 'MISSING_ACCOUNT', path: 'entries[0].account' },
    ]);
  });

  it('repetir a mesma chave com o mesmo conteúdo devolve o lançamento já feito', async () => {
    const ledger = await newLedger();
    const first = await ledger.post(payment);
    const again = await ledger.post({
      ...payment,
      entries: payment.entries.map((entry) => ({ ...entry })),
    });

    expect(again).toEqual(first);
    expect(await ledger.balance('account:vendedor')).toBe(10_000);
  });

  it('duas gravações da mesma chave ao mesmo tempo lançam uma vez só', async () => {
    const ledger = await newLedger();
    const [first, second] = await Promise.all([ledger.post(payment), ledger.post(payment)]);

    expect(second).toEqual(first);
    expect(await ledger.statement('account:vendedor')).toHaveLength(1);
  });

  it('recusa a mesma chave com outro conteúdo', async () => {
    const ledger = await newLedger();
    await ledger.post(payment);

    const error = await rejection(ledger.post({ ...payment, description: 'Outra coisa' }));
    expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('não deixa alterar um lançamento gravado', async () => {
    const ledger = await newLedger();
    const transaction = await ledger.post(payment);

    expect(() => {
      (transaction.entries[0] as LedgerEntry).amountCents = 1;
    }).toThrow(TypeError);
    expect(() => {
      (transaction as { description: string }).description = 'Outra';
    }).toThrow(TypeError);
    expect(await ledger.balance('account:vendedor')).toBe(10_000);
  });

  it('não muda se o pedido original for alterado depois de gravado', async () => {
    const ledger = await newLedger();
    const entries = [
      { account: 'a', amountCents: 5 },
      { account: 'b', amountCents: -5 },
    ];
    await ledger.post({ idempotencyKey: 'k', description: 'Teste', entries });
    entries[0]!.amountCents = 500;

    expect(await ledger.balance('a')).toBe(5);
  });

  it('estorna gravando o lançamento inverso e mantém o original', async () => {
    const ledger = await newLedger();
    const original = await ledger.post(payment);
    const reversal = await ledger.reverse(original.id, 'Estorno do pagamento');

    expect(reversal.entries).toEqual([
      { account: 'external:payers', amountCents: 10_000 },
      { account: 'account:vendedor', amountCents: -10_000, memo: 'Pagamento' },
    ]);
    expect(reversal.metadata).toEqual({ reverses: original.id });
    expect(await ledger.balance('account:vendedor')).toBe(0);
    expect(await ledger.getTransaction(original.id)).toEqual(original);
  });

  it('estornar de novo devolve o mesmo estorno', async () => {
    const ledger = await newLedger();
    const original = await ledger.post(payment);
    const first = await ledger.reverse(original.id, 'Estorno');
    const second = await ledger.reverse(original.id, 'Estorno repetido');

    expect(second).toEqual(first);
    expect(await ledger.balance('account:vendedor')).toBe(0);
  });

  it('recusa estornar lançamento que não existe', async () => {
    const ledger = await newLedger();
    const error = await rejection(ledger.reverse('tx_999', 'Estorno'));
    expect(error.code).toBe('TRANSACTION_NOT_FOUND');
  });

  it('a soma de todos os saldos é zero, e o extrato de cada conta bate com o saldo', async () => {
    const accounts = ['a', 'b', 'c', 'd'];
    // Partidas aleatórias; a conta "ajuste" fecha a soma em zero quando preciso.
    const balancedEntries = fc
      .array(
        fc.record({
          account: fc.constantFrom(...accounts),
          amountCents: fc
            .integer({ min: -1_000_000_000, max: 1_000_000_000 })
            .filter((amount) => amount !== 0),
        }),
        { minLength: 1, maxLength: 6 },
      )
      .map((entries) => {
        const total = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
        return total === 0 ? entries : [...entries, { account: 'ajuste', amountCents: -total }];
      })
      .filter((entries) => new Set(entries.map((entry) => entry.account)).size >= 2);

    // Um razão só para todas as rodadas; cada rodada usa contas e chaves próprias.
    const ledger = await newLedger();
    let round = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(balancedEntries, { maxLength: 10 }), async (transactions) => {
        round += 1;
        const prefix = `rodada${round}:`;
        for (const [index, entries] of transactions.entries()) {
          await ledger.post({
            idempotencyKey: `${prefix}${index}`,
            description: 'Teste',
            entries: entries.map((entry) => ({ ...entry, account: prefix + entry.account })),
          });
        }

        let total = 0;
        for (const account of [...accounts, 'ajuste']) {
          const balance = await ledger.balance(prefix + account);
          const lines = await ledger.statement(prefix + account);
          expect(lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(balance);
          expect(lines.at(-1)?.balanceCents ?? 0).toBe(balance);
          total += balance;
        }
        expect(total).toBe(0);
      }),
      { numRuns: 50 },
    );
  });
});
