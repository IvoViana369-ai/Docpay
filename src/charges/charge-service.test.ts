import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, warmUpTestDatabase } from '../db/testing.js';
import { PAYERS, PROVIDER_FEES, ledgerAccountFor } from '../ledger/accounts.js';
import { InMemoryLedger } from '../ledger/in-memory-ledger.js';
import { PostgresLedger } from '../ledger/postgres-ledger.js';
import type { Ledger } from '../ledger/types.js';
import { ProviderError } from '../providers/errors.js';
import { SimulatedProvider, type SimulatedProviderOptions } from '../providers/simulated-provider.js';
import type { ProviderCharge, ProviderChargeRef, ProviderChargeRequest } from '../providers/types.js';
import { ChargeService, chargeRequestFingerprint } from './charge-service.js';
import { InMemoryChargeClaims, PostgresChargeClaims, type ChargeClaims } from './claims.js';
import type { Notifier } from './notifier.js';
import { ChargeError } from './errors.js';
import { PostgresChargeRepository, PostgresWebhookInbox } from './postgres-repositories.js';
import {
  InMemoryChargeRepository,
  InMemoryWebhookInbox,
  type ChargeRepository,
  type WebhookInbox,
} from './repositories.js';
import type { Charge, CreateChargeInput } from './types.js';

const NOW = '2026-10-29T12:00:00.000Z';
const now = () => new Date(NOW);

interface Stores {
  ledger: Ledger;
  charges: ChargeRepository;
  claims: ChargeClaims;
  webhooks: WebhookInbox;
  close(): Promise<void>;
}

// O fluxo inteiro roda com as duas formas de guardar os dados.
const storages: { name: string; create(): Promise<Stores> }[] = [
  {
    name: 'em memória',
    create: async () => ({
      ledger: new InMemoryLedger({ now }),
      charges: new InMemoryChargeRepository(),
      claims: new InMemoryChargeClaims(),
      webhooks: new InMemoryWebhookInbox(),
      close: async () => {},
    }),
  },
  {
    name: 'PostgreSQL',
    create: async () => {
      const { db, close } = await createTestDatabase();
      return {
        ledger: new PostgresLedger(db, { now }),
        charges: new PostgresChargeRepository(db),
        claims: new PostgresChargeClaims(db),
        webhooks: new PostgresWebhookInbox(db),
        close,
      };
    },
  },
];

beforeAll(() => warmUpTestDatabase(), 60_000);

/** Parceiro simulado que fica fora do ar quando o teste manda. */
class UnstableProvider extends SimulatedProvider {
  /** Imita também um parceiro de produção, para conferir a marca de teste das cobranças. */
  override readonly sandbox: boolean;
  readonly offlineFor = new Set<string>();
  /** Erro da próxima criação de cobrança, como uma queda de rede. */
  failNextCreate: Error | undefined;
  createCalls = 0;

  constructor(options: SimulatedProviderOptions & { sandbox?: boolean } = {}) {
    super(options);
    this.sandbox = options.sandbox ?? true;
  }

  override async createCharge(request: ProviderChargeRequest): Promise<ProviderCharge> {
    this.createCalls += 1;
    const failure = this.failNextCreate;
    this.failNextCreate = undefined;
    if (failure) throw failure;
    return super.createCharge(request);
  }

  override async getCharge(ref: ProviderChargeRef): Promise<ProviderCharge> {
    if (this.offlineFor.has(ref.id)) throw new Error('Parceiro fora do ar.');
    return super.getCharge(ref);
  }
}

const input: CreateChargeInput = {
  idempotencyKey: 'docline-fatura-123',
  method: 'boleto',
  amountCents: 100_000,
  dueDate: '2026-11-10',
  payer: {
    name: 'Maria Silva',
    document: '529.982.247-25',
    address: {
      zipCode: '60160-230',
      street: 'Rua Silva Paulet',
      number: '100',
      district: 'Meireles',
      city: 'Fortaleza',
      state: 'CE',
    },
  },
  rule: { beneficiary: 'vendedor', recipients: [{ account: 'parceiro', percentBps: 4_000 }] },
};

function webhookOf(body: string) {
  return { body, query: {} };
}

async function chargeRejection(promise: Promise<unknown>): Promise<ChargeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChargeError) return error;
    throw error;
  }
  throw new Error('Esperava que a cobrança fosse recusada, mas ela foi aceita.');
}

describe.each(storages)('ChargeService, dados $name', (storage) => {
  const opened: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of opened.splice(0)) await close();
  });

  async function setup({
    sandbox,
    ...options
  }: { reconciliationPageSize?: number; notifier?: Notifier; sandbox?: boolean } = {}) {
    const stores = await storage.create();
    opened.push(() => stores.close());
    const provider = new UnstableProvider({ now, ...(sandbox === undefined ? {} : { sandbox }) });
    let count = 0;
    const service = new ChargeService({
      provider,
      ledger: stores.ledger,
      charges: stores.charges,
      claims: stores.claims,
      webhooks: stores.webhooks,
      now,
      newId: () => `ch_${++count}`,
      ...options,
    });
    return {
      provider,
      ledger: stores.ledger,
      charges: stores.charges,
      claims: stores.claims,
      webhooks: stores.webhooks,
      service,
    };
  }

  describe('emissão', () => {
    it('emite o boleto no parceiro com os repasses já em centavos', async () => {
      const { service, provider } = await setup();
      const charge = await service.create(input);

      expect(charge).toMatchObject({
        id: 'ch_1',
        reference: 'docline-fatura-123',
        method: 'boleto',
        status: 'pending',
        amountCents: 100_000,
        provider: 'simulated',
        sandbox: true,
        providerChargeId: '9000000001',
        providerStatus: { code: 'pending', label: 'Pendente' },
        paymentUrl: 'https://simulado.docpay.invalid/boleto/9000000001',
        pixCopyPaste: 'SIMULADO-PIX-9000000001',
        divergences: [],
        createdAt: NOW,
      });
      expect(charge.digitableLine).toMatch(/^999\d{44}$/);
      expect(charge.expectedShares.map(({ account, grossCents }) => [account, grossCents])).toEqual([
        ['vendedor', 60_000],
        ['parceiro', 40_000],
      ]);
      expect(provider.requestFor(charge.providerChargeId)).toMatchObject({
        reference: 'docline-fatura-123',
        beneficiary: 'vendedor',
        method: 'boleto',
        transfers: [{ account: 'parceiro', amountCents: 40_000 }],
      });
      expect(await service.get(charge.id)).toEqual(charge);
    });

    it('emite o Pix sem exigir endereço, com a referência escolhida', async () => {
      const { service, provider } = await setup();
      const { address: _address, ...payerWithoutAddress } = input.payer;
      const charge = await service.create({
        ...input,
        method: 'pix',
        reference: 'DOCLINE-123',
        payer: payerWithoutAddress,
      });

      expect(charge).toMatchObject({ method: 'pix', reference: 'DOCLINE-123', pixCopyPaste: 'SIMULADO-PIX-9000000001' });
      expect(charge.digitableLine).toBeUndefined();
      expect(provider.requestFor(charge.providerChargeId).reference).toBe('DOCLINE-123');
    });

    it('marca a cobrança como de teste conforme o ambiente do parceiro na emissão', async () => {
      const { service } = await setup({ sandbox: false });
      const charge = await service.create(input);

      expect(charge.sandbox).toBe(false);
      expect((await service.get(charge.id))?.sandbox).toBe(false);
    });

    it('não manda ao parceiro repasse de valor zero', async () => {
      const { service, provider } = await setup();
      // 0,01% de R$ 10,00 é menos de um centavo: o indicador não recebe nada.
      const charge = await service.create({
        ...input,
        amountCents: 1_000,
        rule: {
          beneficiary: 'vendedor',
          recipients: [
            { account: 'parceiro', fixedCents: 100 },
            { account: 'indicador', percentBps: 1 },
          ],
        },
      });

      expect(provider.requestFor(charge.providerChargeId).transfers).toEqual([
        { account: 'parceiro', amountCents: 100 },
      ]);
    });

    it('repetir a mesma chave devolve a mesma cobrança, sem criar outra no parceiro', async () => {
      const { service, provider } = await setup();
      const first = await service.create(input);
      const again = await service.create(structuredClone(input));

      expect(again).toEqual(first);
      await expect(
        provider.getCharge({ id: '9000000002', method: 'boleto', amountCents: 1, transfers: [] }),
      ).rejects.toThrow(ProviderError);
    });

    it('emissões com a mesma chave ao mesmo tempo chamam o parceiro uma vez só', async () => {
      const { service, provider } = await setup();
      const results = await Promise.allSettled([1, 2, 3].map(() => service.create(input)));

      // Conforme a ordem em que chegam, a outra chamada recebe a mesma cobrança
      // ou ouve "em andamento". Nunca há uma segunda cobrança no parceiro.
      expect(provider.createCalls).toBe(1);
      const created = new Set(results.flatMap((result) => (result.status === 'fulfilled' ? [result.value.id] : [])));
      expect(created.size).toBe(1);
      for (const result of results) {
        if (result.status === 'rejected') expect((result.reason as ChargeError).code).toBe('IN_PROGRESS');
      }
      expect((await service.create(input)).id).toBe([...created][0]);
    });

    it('quem consegue a reserva confere de novo e não chama o parceiro se a cobrança acabou de ser gravada', async () => {
      const { service, provider, charges } = await setup();
      const first = await service.create(input);

      // A segunda chamada fez a primeira conferência antes de a primeira gravar,
      // e só pediu a reserva depois que a primeira já tinha gravado e liberado.
      const lookup = charges.findByIdempotencyKey.bind(charges);
      let lookups = 0;
      charges.findByIdempotencyKey = async (key) => (++lookups === 1 ? undefined : lookup(key));

      expect((await service.create(input)).id).toBe(first.id);
      expect(provider.createCalls).toBe(1);
    });

    it('se o parceiro recusar ou não responder, a chave fica livre para tentar de novo', async () => {
      const { service, provider } = await setup();
      provider.failNextCreate = new ProviderError('simulated', 'UNAVAILABLE', 'Parceiro fora do ar.');

      await expect(service.create(input)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      expect((await service.create(input)).status).toBe('pending');
      expect(provider.createCalls).toBe(2);
    });

    it('uma reserva parada há mais de 10 minutos é de uma tentativa que parou no meio e pode ser assumida', async () => {
      const { service, claims, provider } = await setup();
      // Reserva de uma tentativa que caiu entre o parceiro e a gravação, 11 minutos antes.
      await claims.acquire(input.idempotencyKey, chargeRequestFingerprint(input), '2026-10-29T11:49:00.000Z', '2026-10-29T11:00:00.000Z');

      expect((await service.create(input)).status).toBe('pending');
      expect(provider.createCalls).toBe(1);
    });

    it('uma reserva recente faz a nova tentativa ouvir "em andamento"', async () => {
      const { service, claims, provider } = await setup();
      await claims.acquire(input.idempotencyKey, chargeRequestFingerprint(input), '2026-10-29T11:55:00.000Z', '2026-10-29T11:00:00.000Z');

      await expect(service.create(input)).rejects.toMatchObject({ code: 'IN_PROGRESS' });
      expect(provider.createCalls).toBe(0);
    });

    it('uma reserva da mesma chave com outro pedido é conflito', async () => {
      const { service, claims } = await setup();
      await claims.acquire(input.idempotencyKey, 'outro pedido', '2026-10-29T11:55:00.000Z', '2026-10-29T11:00:00.000Z');

      await expect(service.create(input)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    });

    it('recusa a mesma chave com outro conteúdo', async () => {
      const { service } = await setup();
      await service.create(input);

      const error = await chargeRejection(service.create({ ...input, amountCents: 100_001 }));
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('se a resposta do parceiro se perdeu, repetir o pedido recupera a mesma cobrança', async () => {
      const { service, provider } = await setup();
      // Primeira tentativa: o parceiro criou a cobrança, mas a resposta não chegou ao DocPay.
      const lost = await provider.createCharge({
        idempotencyKey: input.idempotencyKey,
        reference: input.idempotencyKey,
        beneficiary: 'vendedor',
        method: 'boleto',
        amountCents: input.amountCents,
        dueDate: input.dueDate,
        payer: input.payer,
        transfers: [{ account: 'parceiro', amountCents: 40_000 }],
      });

      const charge = await service.create(input);
      expect(charge.providerChargeId).toBe(lost.id);
    });

    it('recusa dados inválidos, com todos os problemas de uma vez', async () => {
      const { service } = await setup();
      const error = await chargeRejection(
        service.create({
          idempotencyKey: '',
          reference: ' ',
          method: 'cheque' as 'boleto',
          amountCents: 100_000,
          dueDate: '2026-02-30',
          payer: { name: ' ', document: '123.456.789-00' },
          rule: {
            beneficiary: 'vendedor',
            recipients: [{ account: 'parceiro', percentBps: 12_000 }],
            feePolicy: { kind: 'proportional' },
          },
        }),
      );

      expect(error.code).toBe('INVALID_CHARGE');
      expect(error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: 'MISSING_IDEMPOTENCY_KEY', path: 'idempotencyKey' },
        { code: 'INVALID_REFERENCE', path: 'reference' },
        { code: 'INVALID_METHOD', path: 'method' },
        { code: 'INVALID_DUE_DATE', path: 'dueDate' },
        { code: 'MISSING_PAYER_NAME', path: 'payer.name' },
        { code: 'INVALID_PAYER_DOCUMENT', path: 'payer.document' },
        { code: 'UNSUPPORTED_FEE_POLICY', path: 'rule.feePolicy' },
        { code: 'INVALID_PERCENT', path: 'rule.recipients[0].percentBps' },
      ]);
    });

    it('no boleto, exige o endereço completo do pagador e diz o que falta', async () => {
      const { service } = await setup();
      const error = await chargeRejection(
        service.create({
          ...input,
          payer: { ...input.payer, address: { zipCode: '6016', street: 'Rua A', district: '', city: 'Fortaleza', state: 'Ceará' } },
        }),
      );

      expect(error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: 'MISSING_PAYER_ADDRESS', path: 'payer.address.zipCode' },
        { code: 'MISSING_PAYER_ADDRESS', path: 'payer.address.district' },
        { code: 'MISSING_PAYER_ADDRESS', path: 'payer.address.state' },
      ]);
      expect(error.issues[0]?.message).toBe('No boleto, o endereço do pagador precisa estar completo: falta CEP.');
    });

    it('recusa vencimento que já passou, no fuso do DocPay', async () => {
      const { service } = await setup();
      const error = await chargeRejection(service.create({ ...input, dueDate: '2026-10-28' }));
      expect(error.issues.map((issue) => issue.code)).toEqual(['PAST_DUE_DATE']);

      // Vencimento hoje é aceito.
      expect((await service.create({ ...input, dueDate: '2026-10-29' })).status).toBe('pending');
    });

    it('recusa repasses maiores que o valor', async () => {
      const { service } = await setup();
      const error = await chargeRejection(
        service.create({
          ...input,
          rule: { beneficiary: 'vendedor', recipients: [{ account: 'parceiro', fixedCents: 150_000 }] },
        }),
      );

      expect(error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: 'SPLIT_EXCEEDS_AMOUNT', path: 'rule.recipients' },
      ]);
    });

    it('aceita o beneficiário como pagador explícito da tarifa', async () => {
      const { service } = await setup();
      const charge = await service.create({
        ...input,
        rule: { ...input.rule, feePolicy: { kind: 'single', payer: 'vendedor' } },
      });
      expect(charge.status).toBe('pending');
    });
  });

  describe('pagamento', () => {
    it('dá baixa quando o parceiro avisa que a cobrança foi paga', async () => {
      const { service, provider, ledger } = await setup();
      const charge = await service.create(input);
      const webhook = provider.pay(charge.providerChargeId, { method: 'pix' });

      expect(await service.handleWebhook(webhookOf(webhook))).toEqual([
        { providerChargeId: charge.providerChargeId, status: 'settled', chargeId: charge.id },
      ]);

      expect(await ledger.balance(ledgerAccountFor('vendedor'))).toBe(59_760);
      expect(await ledger.balance(ledgerAccountFor('parceiro'))).toBe(40_000);
      expect(await ledger.balance(PROVIDER_FEES)).toBe(240);
      expect(await ledger.balance(PAYERS)).toBe(-100_000);

      const paid = await service.get(charge.id);
      expect(paid).toMatchObject({
        status: 'paid',
        providerStatus: { code: 'paid', label: 'Pago' },
        divergences: [],
        payment: { method: 'pix', paidAmountCents: 100_000, feeCents: 240 },
      });
      expect(paid?.payment?.ledgerTransactionId).toBeDefined();
    });

    it('o extrato do beneficiário mostra o que ele recebeu, repassou e pagou de tarifa', async () => {
      const { service, provider, ledger } = await setup();
      const charge = await service.create(input);
      await service.handleWebhook(webhookOf(provider.pay(charge.providerChargeId)));

      const lines = await ledger.statement(ledgerAccountFor('vendedor'));
      expect(lines.map(({ memo, amountCents, balanceCents }) => ({ memo, amountCents, balanceCents }))).toEqual([
        { memo: 'Pagamento recebido', amountCents: 100_000, balanceCents: 100_000 },
        { memo: 'Repasse para parceiro', amountCents: -40_000, balanceCents: 60_000 },
        { memo: 'Tarifa do parceiro', amountCents: -299, balanceCents: 59_701 },
      ]);
    });

    it('aviso repetido não lança a baixa duas vezes', async () => {
      const { service, provider, ledger } = await setup();
      const charge = await service.create(input);
      const webhook = provider.pay(charge.providerChargeId);

      await service.handleWebhook(webhookOf(webhook));
      expect(await service.handleWebhook(webhookOf(webhook))).toEqual([
        { providerChargeId: charge.providerChargeId, status: 'unchanged', chargeId: charge.id },
      ]);
      expect(await ledger.statement(PAYERS)).toHaveLength(1);
    });

    it('duas baixas ao mesmo tempo lançam uma vez só', async () => {
      const { service, provider, ledger } = await setup();
      const charge = await service.create(input);
      provider.pay(charge.providerChargeId);

      await Promise.all([service.sync(charge.id), service.sync(charge.id)]);
      expect(await ledger.statement(PAYERS)).toHaveLength(1);
      expect(await ledger.balance(ledgerAccountFor('parceiro'))).toBe(40_000);
    });

    it('não confia no aviso: um aviso falso de cobrança não paga não lança nada', async () => {
      const { service, ledger } = await setup();
      const charge = await service.create(input);
      const forged = JSON.stringify({ id: 'evt_falso', chargeId: charge.providerChargeId });

      expect(await service.handleWebhook(webhookOf(forged))).toEqual([
        { providerChargeId: charge.providerChargeId, status: 'unchanged', chargeId: charge.id },
      ]);
      expect(await ledger.balance(PAYERS)).toBe(0);
      expect((await service.get(charge.id))?.status).toBe('pending');
    });

    it('ignora aviso de cobrança que o DocPay não emitiu', async () => {
      const { service } = await setup();
      const unknown = JSON.stringify({ id: 'evt_1', chargeId: '9999999999' });
      expect(await service.handleWebhook(webhookOf(unknown))).toEqual([
        { providerChargeId: '9999999999', status: 'unknown_charge' },
      ]);
    });

    it('guarda o aviso bruto mesmo quando ele é inválido', async () => {
      const { service, webhooks } = await setup();

      await expect(service.handleWebhook(webhookOf('isto não é json'))).rejects.toMatchObject({
        name: 'ProviderError',
        code: 'INVALID_WEBHOOK',
      });
      expect(await webhooks.recent(10)).toEqual([
        { provider: 'simulated', body: 'isto não é json', receivedAt: NOW },
      ]);
    });

    it('registra divergência quando o valor pago é diferente, e o beneficiário fica com a diferença', async () => {
      const { service, provider, ledger } = await setup();
      const charge = await service.create(input);
      // Pago com R$ 10,00 de juros.
      await service.handleWebhook(webhookOf(provider.pay(charge.providerChargeId, { paidAmountCents: 101_000 })));

      const paid = await service.get(charge.id);
      expect(paid?.divergences.map((divergence) => divergence.code)).toEqual(['PAID_AMOUNT_DIFFERS']);
      expect(await ledger.balance(ledgerAccountFor('vendedor'))).toBe(101_000 - 40_000 - 299);
      expect(await ledger.balance(ledgerAccountFor('parceiro'))).toBe(40_000);
    });

    it('cobrança baixada pelo parceiro fica vencida, sem lançamento no razão', async () => {
      const { service, provider, ledger } = await setup();
      const charge = await service.create(input);

      expect(await service.handleWebhook(webhookOf(provider.expire(charge.providerChargeId)))).toEqual([
        { providerChargeId: charge.providerChargeId, status: 'updated', chargeId: charge.id },
      ]);
      expect(await service.get(charge.id)).toMatchObject({
        status: 'expired',
        providerStatus: { code: 'expired', label: 'Baixado' },
      });
      expect(await ledger.balance(PAYERS)).toBe(0);
    });

    it('sync dá baixa mesmo sem aviso e não lança de novo', async () => {
      const { service, provider } = await setup();
      const charge = await service.create(input);
      provider.pay(charge.providerChargeId);

      expect(await service.sync(charge.id)).toEqual({ status: 'settled', chargeId: charge.id });
      expect(await service.sync(charge.id)).toEqual({ status: 'unchanged', chargeId: charge.id });
    });

    it('sync de cobrança ainda não paga não muda nada', async () => {
      const { service } = await setup();
      const charge = await service.create(input);
      expect(await service.sync(charge.id)).toEqual({ status: 'unchanged', chargeId: charge.id });
    });

    it('sync de cobrança desconhecida é recusado', async () => {
      const { service } = await setup();
      const error = await chargeRejection(service.sync('ch_999'));
      expect(error.code).toBe('CHARGE_NOT_FOUND');
    });
  });

  describe('aviso ao sistema cliente', () => {
    /** Sistema cliente de mentira: guarda os avisos e pode ficar fora do ar. */
    class FakeClient implements Notifier {
      readonly received: string[] = [];
      offline = false;

      async notify(charge: Charge): Promise<void> {
        if (this.offline) throw new Error('Sistema cliente fora do ar.');
        this.received.push(`${charge.id}:${charge.status}`);
      }
    }

    it('avisa quando a cobrança é paga ou baixada, uma vez por status', async () => {
      const client = new FakeClient();
      const { service, provider } = await setup({ notifier: client });
      const paid = await service.create(input);
      const expired = await service.create({ ...input, idempotencyKey: 'fatura-vencida' });

      const webhook = provider.pay(paid.providerChargeId);
      await service.handleWebhook(webhookOf(webhook));
      await service.handleWebhook(webhookOf(webhook));
      await service.handleWebhook(webhookOf(provider.expire(expired.providerChargeId)));

      expect(client.received).toEqual([`${paid.id}:paid`, `${expired.id}:expired`]);
      expect(await service.deliverPendingNotifications()).toEqual({ delivered: [], failed: [] });
    });

    it('se o sistema cliente estiver fora do ar, a baixa acontece e o aviso sai depois', async () => {
      const client = new FakeClient();
      const { service, provider, ledger } = await setup({ notifier: client });
      const charge = await service.create(input);
      client.offline = true;

      expect(await service.handleWebhook(webhookOf(provider.pay(charge.providerChargeId)))).toMatchObject([
        { status: 'settled' },
      ]);
      expect(await ledger.balance(PAYERS)).toBe(-100_000);
      expect(await service.deliverPendingNotifications()).toEqual({
        delivered: [],
        failed: [{ chargeId: charge.id, message: 'Sistema cliente fora do ar.' }],
      });

      client.offline = false;
      expect(await service.deliverPendingNotifications()).toEqual({ delivered: [charge.id], failed: [] });
      expect(await service.deliverPendingNotifications()).toEqual({ delivered: [], failed: [] });
      expect(client.received).toEqual([`${charge.id}:paid`]);
    });

    it('sem sistema cliente configurado, não há o que avisar', async () => {
      const { service, provider } = await setup();
      const charge = await service.create(input);
      await service.handleWebhook(webhookOf(provider.pay(charge.providerChargeId)));

      expect(await service.deliverPendingNotifications()).toEqual({ delivered: [], failed: [] });
    });
  });

  describe('conciliação', () => {
    async function createCharges(service: ChargeService, count: number) {
      const charges = [];
      for (let index = 1; index <= count; index += 1) {
        charges.push(await service.create({ ...input, idempotencyKey: `fatura-${index}` }));
      }
      return charges;
    }

    it('registra o que mudou nas cobranças cujo aviso se perdeu, passando por todas as páginas', async () => {
      const { service, provider, ledger } = await setup({ reconciliationPageSize: 2 });
      const [first, second, third, fourth] = await createCharges(service, 4);
      // Pagas ou baixadas, mas os avisos nunca chegaram.
      provider.pay(first!.providerChargeId);
      provider.pay(third!.providerChargeId);
      provider.expire(fourth!.providerChargeId);

      expect(await service.reconcilePending()).toEqual({
        checked: 4,
        settled: [first!.id, third!.id],
        updated: [fourth!.id],
        failed: [],
      });
      expect(await ledger.balance(PAYERS)).toBe(-200_000);
      expect((await service.get(second!.id))?.status).toBe('pending');

      // Na próxima rodada, só a cobrança ainda em aberto é consultada.
      expect(await service.reconcilePending()).toEqual({ checked: 1, settled: [], updated: [], failed: [] });
    });

    it('uma falha numa cobrança não interrompe as outras', async () => {
      const { service, provider } = await setup();
      const [first, second] = await createCharges(service, 2);
      provider.pay(first!.providerChargeId);
      provider.pay(second!.providerChargeId);
      provider.offlineFor.add(first!.providerChargeId);

      expect(await service.reconcilePending()).toEqual({
        checked: 2,
        settled: [second!.id],
        updated: [],
        failed: [{ chargeId: first!.id, message: 'Parceiro fora do ar.' }],
      });

      // Quando o parceiro volta, a próxima conciliação resolve.
      provider.offlineFor.clear();
      expect(await service.reconcilePending()).toEqual({
        checked: 1,
        settled: [first!.id],
        updated: [],
        failed: [],
      });
    });

    it('sem cobranças em aberto, não consulta nada', async () => {
      const { service } = await setup();
      expect(await service.reconcilePending()).toEqual({ checked: 0, settled: [], updated: [], failed: [] });
    });
  });
});
