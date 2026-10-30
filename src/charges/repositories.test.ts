import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, warmUpTestDatabase } from '../db/testing.js';
import { PostgresChargeRepository, PostgresWebhookInbox } from './postgres-repositories.js';
import {
  InMemoryChargeRepository,
  InMemoryWebhookInbox,
  type ChargeRepository,
  type WebhookInbox,
} from './repositories.js';
import type { Charge } from './types.js';

const storages: {
  name: string;
  create(): Promise<{ charges: ChargeRepository; webhooks: WebhookInbox; close(): Promise<void> }>;
}[] = [
  {
    name: 'em memória',
    create: async () => ({
      charges: new InMemoryChargeRepository(),
      webhooks: new InMemoryWebhookInbox(),
      close: async () => {},
    }),
  },
  {
    name: 'PostgreSQL',
    create: async () => {
      const { db, close } = await createTestDatabase();
      return { charges: new PostgresChargeRepository(db), webhooks: new PostgresWebhookInbox(db), close };
    },
  },
];

beforeAll(() => warmUpTestDatabase(), 60_000);

function chargeFixture(id: string, overrides: Partial<Charge> = {}): Charge {
  return {
    id,
    idempotencyKey: `chave-${id}`,
    status: 'pending',
    amountCents: 100_000,
    dueDate: '2026-11-10',
    payer: { name: 'Maria Silva', document: '529.982.247-25' },
    rule: { beneficiary: 'vendedor', recipients: [{ account: 'parceiro', percentBps: 4_000 }] },
    expectedShares: [
      { account: 'vendedor', role: 'beneficiary', grossCents: 60_000, feeCents: 0, netCents: 60_000 },
      { account: 'parceiro', role: 'recipient', grossCents: 40_000, feeCents: 0, netCents: 40_000 },
    ],
    provider: 'simulated',
    providerChargeId: `sim_${id}`,
    digitableLine: '999',
    pixCopyPaste: `SIMULADO-PIX-sim_${id}`,
    divergences: [],
    createdAt: '2026-10-29T12:00:00.000Z',
    ...overrides,
  };
}

describe.each(storages)('repositórios, dados $name', (storage) => {
  const opened: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of opened.splice(0)) await close();
  });

  async function setup() {
    const stores = await storage.create();
    opened.push(() => stores.close());
    return stores;
  }

  it('grava a cobrança e encontra por id, por chave e pela cobrança no parceiro', async () => {
    const { charges } = await setup();
    const charge = chargeFixture('ch_1', { description: 'Mensalidade', fiscalDocumentKey: 'nfse-1' });

    expect(await charges.insert(charge)).toBe(true);
    expect(await charges.findById('ch_1')).toEqual(charge);
    expect(await charges.findByIdempotencyKey('chave-ch_1')).toEqual(charge);
    expect(await charges.findByProviderChargeId('simulated', 'sim_ch_1')).toEqual(charge);
    expect(await charges.findById('ch_2')).toBeUndefined();
    expect(await charges.findByProviderChargeId('outro', 'sim_ch_1')).toBeUndefined();
  });

  it('não grava duas cobranças com a mesma chave', async () => {
    const { charges } = await setup();
    await charges.insert(chargeFixture('ch_1'));

    expect(await charges.insert(chargeFixture('ch_2', { idempotencyKey: 'chave-ch_1' }))).toBe(false);
    expect(await charges.findById('ch_2')).toBeUndefined();
  });

  it('atualiza a cobrança', async () => {
    const { charges } = await setup();
    const charge = chargeFixture('ch_1');
    await charges.insert(charge);

    const paid: Charge = {
      ...charge,
      status: 'paid',
      payment: {
        paidAt: '2026-11-05T15:00:00.000Z',
        method: 'pix',
        paidAmountCents: 100_000,
        feeCents: 240,
        transfers: [{ account: 'parceiro', amountCents: 40_000 }],
        ledgerTransactionId: 'tx_1',
      },
    };
    await charges.update(paid);

    expect(await charges.findById('ch_1')).toEqual(paid);
    await expect(charges.update(chargeFixture('ch_9'))).rejects.toThrow('Cobrança ch_9 não existe.');
  });

  it('devolve cópias: mudar o que voltou não muda o que está gravado', async () => {
    const { charges } = await setup();
    await charges.insert(chargeFixture('ch_1'));

    const found = await charges.findById('ch_1');
    found!.amountCents = 1;
    expect((await charges.findById('ch_1'))?.amountCents).toBe(100_000);
  });

  it('lista as cobranças em aberto da mais antiga para a mais nova, em páginas', async () => {
    const { charges } = await setup();
    await charges.insert(chargeFixture('ch_c', { createdAt: '2026-10-29T12:00:02.000Z' }));
    await charges.insert(chargeFixture('ch_b', { createdAt: '2026-10-29T12:00:01.000Z' }));
    await charges.insert(chargeFixture('ch_a', { createdAt: '2026-10-29T12:00:01.000Z' }));
    await charges.insert(chargeFixture('ch_paga', { status: 'paid', createdAt: '2026-10-29T12:00:00.000Z' }));

    const firstPage = await charges.findPending({ limit: 2 });
    expect(firstPage.map((charge) => charge.id)).toEqual(['ch_a', 'ch_b']);

    const last = firstPage.at(-1)!;
    const secondPage = await charges.findPending({
      limit: 2,
      after: { createdAt: last.createdAt, id: last.id },
    });
    expect(secondPage.map((charge) => charge.id)).toEqual(['ch_c']);
  });

  it('guarda os avisos e devolve os mais recentes primeiro', async () => {
    const { webhooks } = await setup();
    await webhooks.save({ provider: 'simulated', body: 'primeiro', receivedAt: '2026-10-29T12:00:00.000Z' });
    await webhooks.save({ provider: 'simulated', body: 'segundo', receivedAt: '2026-10-29T12:00:01.000Z' });

    expect(await webhooks.recent(10)).toEqual([
      { provider: 'simulated', body: 'segundo', receivedAt: '2026-10-29T12:00:01.000Z' },
      { provider: 'simulated', body: 'primeiro', receivedAt: '2026-10-29T12:00:00.000Z' },
    ]);
    expect(await webhooks.recent(1)).toHaveLength(1);
  });
});
