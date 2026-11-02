import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { createTestDatabase, warmUpTestDatabase, type TestDatabase } from './testing.js';
import type { Db } from './types.js';

// O código confere tudo antes de gravar. Estes testes vão direto ao banco,
// como faria um bug ou um comando manual, e mostram que ele recusa sozinho.

beforeAll(() => warmUpTestDatabase(), 60_000);

describe('banco de dados', () => {
  const opened: TestDatabase[] = [];
  afterEach(async () => {
    for (const database of opened.splice(0)) await database.close();
  });

  async function open(): Promise<Db> {
    const database = await createTestDatabase();
    opened.push(database);
    return database.db;
  }

  it('aplicar as migrações de novo não faz nada', async () => {
    const db = await open();

    expect(await migrate(db)).toEqual([]);
    expect(await db.query('SELECT name FROM schema_migrations ORDER BY name')).toEqual([
      { name: '001_initial.sql' },
      { name: '002_charge_statuses.sql' },
      { name: '003_accounts.sql' },
      { name: '004_charge_claims.sql' },
    ]);
  });

  describe('razão', () => {
    async function insertTransaction(db: Db, id: string, entries: [string, number][]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO ledger_transactions (id, idempotency_key, fingerprint, description, posted_at)
           VALUES ($1, $1, '-', 'Teste', now())`,
          [id],
        );
        for (const [position, [account, amount]] of entries.entries()) {
          await tx.query(
            'INSERT INTO ledger_entries (transaction_id, position, account, amount_cents) VALUES ($1, $2, $3, $4)',
            [id, position, account, String(amount)],
          );
        }
      });
    }

    it('recusa, no fim da transação, partidas que não somam zero', async () => {
      const db = await open();

      await expect(insertTransaction(db, 'tx_1', [['a', 100], ['b', -99]])).rejects.toThrow(
        'Lançamento tx_1 inválido: as partidas somam 1 centavo(s) em 2 conta(s).',
      );
      expect(await db.query('SELECT id FROM ledger_transactions')).toEqual([]);
    });

    it('recusa lançamento sem partidas ou com uma conta só', async () => {
      const db = await open();

      await expect(insertTransaction(db, 'tx_1', [])).rejects.toThrow('em 0 conta(s)');
      await expect(insertTransaction(db, 'tx_2', [['a', 100], ['a', -100]])).rejects.toThrow('em 1 conta(s)');
    });

    it('recusa acrescentar partida a um lançamento já gravado', async () => {
      const db = await open();
      await insertTransaction(db, 'tx_1', [['a', 100], ['b', -100]]);

      await expect(
        db.transaction((tx) =>
          tx.query(
            "INSERT INTO ledger_entries (transaction_id, position, account, amount_cents) VALUES ('tx_1', 2, 'c', 5)",
          ),
        ),
      ).rejects.toThrow('somam 5 centavo(s)');
    });

    it('não deixa alterar nem apagar o razão', async () => {
      const db = await open();
      await insertTransaction(db, 'tx_1', [['a', 100], ['b', -100]]);

      for (const sql of [
        "UPDATE ledger_entries SET amount_cents = 1 WHERE transaction_id = 'tx_1'",
        "DELETE FROM ledger_entries WHERE transaction_id = 'tx_1'",
        "UPDATE ledger_transactions SET description = 'Outra' WHERE id = 'tx_1'",
        "DELETE FROM ledger_transactions WHERE id = 'tx_1'",
        'TRUNCATE ledger_entries',
        'TRUNCATE ledger_transactions CASCADE',
      ]) {
        await expect(db.exec(sql), sql).rejects.toThrow('O razão é imutável');
      }
      expect(await db.query("SELECT amount_cents::text AS amount FROM ledger_entries WHERE account = 'a'")).toEqual([
        { amount: '100' },
      ]);
    });
  });

  describe('cobranças', () => {
    type Status = 'pending' | 'paid' | 'expired' | 'canceled' | 'failed';

    async function setStatus(db: Db, status: Status): Promise<void> {
      await db.query(
        `UPDATE charges SET status = $1, document = jsonb_set(document, '{status}', to_jsonb($1::text))
          WHERE id = 'ch_1'`,
        [status],
      );
    }

    async function insertCharge(db: Db, status: Status): Promise<void> {
      const document = {
        id: 'ch_1',
        idempotencyKey: 'chave-1',
        provider: 'simulated',
        providerChargeId: 'sim_1',
        status,
      };
      await db.query(
        `INSERT INTO charges (id, idempotency_key, provider, provider_charge_id, status, document, created_at, updated_at)
         VALUES ('ch_1', 'chave-1', 'simulated', 'sim_1', $1, $2::jsonb, now(), now())`,
        [status, JSON.stringify(document)],
      );
    }

    it('não deixa apagar cobrança', async () => {
      const db = await open();
      await insertCharge(db, 'pending');

      await expect(db.exec("DELETE FROM charges WHERE id = 'ch_1'")).rejects.toThrow('Cobranças não são apagadas');
    });

    it('cobrança paga não muda mais de status', async () => {
      const db = await open();
      await insertCharge(db, 'paid');

      for (const status of ['pending', 'expired', 'canceled', 'failed'] as const) {
        await expect(setStatus(db, status), status).rejects.toThrow('já foi paga e não pode mudar de status');
      }
    });

    it('cobrança encerrada não volta a ficar em aberto, mas pode passar a paga', async () => {
      const db = await open();
      await insertCharge(db, 'expired');

      await expect(setStatus(db, 'pending')).rejects.toThrow('está encerrada (expired) e só pode passar a paga');
      await expect(setStatus(db, 'canceled')).rejects.toThrow('só pode passar a paga');
      await setStatus(db, 'paid');
      expect(await db.query("SELECT status FROM charges WHERE id = 'ch_1'")).toEqual([{ status: 'paid' }]);
    });

    it('aceita só os status conhecidos', async () => {
      const db = await open();
      await insertCharge(db, 'pending');

      await expect(setStatus(db, 'perdida' as Status)).rejects.toThrow('charges_status_check');
    });

    it('a identidade da cobrança não muda', async () => {
      const db = await open();
      await insertCharge(db, 'pending');

      await expect(
        db.exec(
          `UPDATE charges SET provider_charge_id = 'sim_2', document = jsonb_set(document, '{providerChargeId}', '"sim_2"')
            WHERE id = 'ch_1'`,
        ),
      ).rejects.toThrow('A identidade da cobrança ch_1 não pode mudar');
    });

    it('as colunas precisam bater com o documento', async () => {
      const db = await open();

      await expect(
        db.query(
          `INSERT INTO charges (id, idempotency_key, provider, provider_charge_id, status, document, created_at, updated_at)
           VALUES ('ch_1', 'chave-1', 'simulated', 'sim_1', 'pending', $1::jsonb, now(), now())`,
          [JSON.stringify({ id: 'ch_1', idempotencyKey: 'chave-1', provider: 'simulated', providerChargeId: 'sim_1', status: 'paid' })],
        ),
      ).rejects.toThrow('charges_document_matches');
    });
  });
});
