import { describe, expect, it } from 'vitest';
import { PAYERS, PROVIDER_FEES, ledgerAccountFor } from '../ledger/accounts.js';
import { InMemoryLedger } from '../ledger/in-memory-ledger.js';
import { ProviderError } from '../providers/errors.js';
import { SimulatedProvider } from '../providers/simulated-provider.js';
import { ChargeService } from './charge-service.js';
import { ChargeError } from './errors.js';
import { InMemoryChargeRepository, InMemoryWebhookInbox } from './repositories.js';
import type { CreateChargeInput } from './types.js';

const NOW = '2026-10-29T12:00:00.000Z';

function setup() {
  const now = () => new Date(NOW);
  const provider = new SimulatedProvider({ now });
  const ledger = new InMemoryLedger({ now });
  const charges = new InMemoryChargeRepository();
  const webhooks = new InMemoryWebhookInbox();
  let count = 0;
  const service = new ChargeService({
    provider,
    ledger,
    charges,
    webhooks,
    now,
    newId: () => `ch_${++count}`,
  });
  return { provider, ledger, webhooks, service };
}

const input: CreateChargeInput = {
  idempotencyKey: 'docline-fatura-123',
  amountCents: 100_000,
  dueDate: '2026-11-10',
  payer: { name: 'Maria Silva', document: '529.982.247-25' },
  rule: { beneficiary: 'vendedor', recipients: [{ account: 'parceiro', percentBps: 4_000 }] },
};

async function chargeRejection(promise: Promise<unknown>): Promise<ChargeError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ChargeError) return error;
    throw error;
  }
  throw new Error('Esperava que a cobrança fosse recusada, mas ela foi aceita.');
}

describe('ChargeService', () => {
  describe('emissão', () => {
    it('emite a cobrança no parceiro com os repasses já em centavos', async () => {
      const { service, provider } = setup();
      const charge = await service.create(input);

      expect(charge).toMatchObject({
        id: 'ch_1',
        status: 'pending',
        amountCents: 100_000,
        provider: 'simulated',
        providerChargeId: 'sim_ch_000001',
        pixCopyPaste: 'SIMULADO-PIX-sim_ch_000001',
        divergences: [],
        createdAt: NOW,
      });
      expect(charge.expectedShares.map(({ account, grossCents }) => [account, grossCents])).toEqual([
        ['vendedor', 60_000],
        ['parceiro', 40_000],
      ]);
      const remote = await provider.getCharge(charge.providerChargeId);
      expect(remote.beneficiary).toBe('vendedor');
      expect(remote.transfers).toEqual([{ account: 'parceiro', amountCents: 40_000 }]);
    });

    it('não manda ao parceiro repasse de valor zero', async () => {
      const { service, provider } = setup();
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

      expect((await provider.getCharge(charge.providerChargeId)).transfers).toEqual([
        { account: 'parceiro', amountCents: 100 },
      ]);
    });

    it('repetir a mesma chave devolve a mesma cobrança, sem criar outra no parceiro', async () => {
      const { service, provider } = setup();
      const first = await service.create(input);
      const again = await service.create(structuredClone(input));

      expect(again).toEqual(first);
      await expect(provider.getCharge('sim_ch_000002')).rejects.toThrow(ProviderError);
    });

    it('recusa a mesma chave com outro conteúdo', async () => {
      const { service } = setup();
      await service.create(input);

      const error = await chargeRejection(service.create({ ...input, amountCents: 100_001 }));
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('se a resposta do parceiro se perdeu, repetir o pedido recupera a mesma cobrança', async () => {
      const { service, provider } = setup();
      // Primeira tentativa: o parceiro criou a cobrança, mas a resposta não chegou ao DocPay.
      const lost = await provider.createCharge({
        idempotencyKey: input.idempotencyKey,
        beneficiary: 'vendedor',
        amountCents: input.amountCents,
        dueDate: input.dueDate,
        payer: input.payer,
        transfers: [{ account: 'parceiro', amountCents: 40_000 }],
      });

      const charge = await service.create(input);
      expect(charge.providerChargeId).toBe(lost.id);
    });

    it('recusa dados inválidos, com todos os problemas de uma vez', async () => {
      const { service } = setup();
      const error = await chargeRejection(
        service.create({
          idempotencyKey: '',
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
        { code: 'INVALID_DUE_DATE', path: 'dueDate' },
        { code: 'MISSING_PAYER_NAME', path: 'payer.name' },
        { code: 'INVALID_PAYER_DOCUMENT', path: 'payer.document' },
        { code: 'UNSUPPORTED_FEE_POLICY', path: 'rule.feePolicy' },
        { code: 'INVALID_PERCENT', path: 'rule.recipients[0].percentBps' },
      ]);
    });

    it('recusa repasses maiores que o valor', async () => {
      const { service } = setup();
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
      const { service } = setup();
      const charge = await service.create({
        ...input,
        rule: { ...input.rule, feePolicy: { kind: 'single', payer: 'vendedor' } },
      });
      expect(charge.status).toBe('pending');
    });
  });

  describe('pagamento', () => {
    it('dá baixa quando o parceiro avisa que a cobrança foi paga', async () => {
      const { service, provider, ledger } = setup();
      const charge = await service.create(input);
      const webhook = provider.pay(charge.providerChargeId, { method: 'pix' });

      expect(await service.handleWebhook(webhook)).toEqual({ status: 'settled', chargeId: charge.id });

      expect(await ledger.balance(ledgerAccountFor('vendedor'))).toBe(59_760);
      expect(await ledger.balance(ledgerAccountFor('parceiro'))).toBe(40_000);
      expect(await ledger.balance(PROVIDER_FEES)).toBe(240);
      expect(await ledger.balance(PAYERS)).toBe(-100_000);

      const paid = await service.get(charge.id);
      expect(paid).toMatchObject({
        status: 'paid',
        divergences: [],
        payment: { method: 'pix', paidAmountCents: 100_000, feeCents: 240 },
      });
      expect(paid?.payment?.ledgerTransactionId).toBeDefined();
    });

    it('o extrato do beneficiário mostra o que ele recebeu, repassou e pagou de tarifa', async () => {
      const { service, provider, ledger } = setup();
      const charge = await service.create(input);
      await service.handleWebhook(provider.pay(charge.providerChargeId, { method: 'boleto' }));

      const lines = await ledger.statement(ledgerAccountFor('vendedor'));
      expect(lines.map(({ memo, amountCents, balanceCents }) => ({ memo, amountCents, balanceCents }))).toEqual([
        { memo: 'Pagamento recebido', amountCents: 100_000, balanceCents: 100_000 },
        { memo: 'Repasse para parceiro', amountCents: -40_000, balanceCents: 60_000 },
        { memo: 'Tarifa do parceiro', amountCents: -299, balanceCents: 59_701 },
      ]);
    });

    it('aviso repetido não lança a baixa duas vezes', async () => {
      const { service, provider, ledger } = setup();
      const charge = await service.create(input);
      const webhook = provider.pay(charge.providerChargeId);

      await service.handleWebhook(webhook);
      expect(await service.handleWebhook(webhook)).toEqual({ status: 'unchanged', chargeId: charge.id });
      expect(await ledger.statement(PAYERS)).toHaveLength(1);
    });

    it('duas baixas ao mesmo tempo lançam uma vez só', async () => {
      const { service, provider, ledger } = setup();
      const charge = await service.create(input);
      provider.pay(charge.providerChargeId);

      await Promise.all([service.sync(charge.id), service.sync(charge.id)]);
      expect(await ledger.statement(PAYERS)).toHaveLength(1);
      expect(await ledger.balance(ledgerAccountFor('parceiro'))).toBe(40_000);
    });

    it('não confia no aviso: um aviso falso de cobrança não paga não lança nada', async () => {
      const { service, ledger } = setup();
      const charge = await service.create(input);
      const forged = JSON.stringify({ id: 'evt_falso', chargeId: charge.providerChargeId });

      expect(await service.handleWebhook(forged)).toEqual({ status: 'unchanged', chargeId: charge.id });
      expect(await ledger.balance(PAYERS)).toBe(0);
      expect((await service.get(charge.id))?.status).toBe('pending');
    });

    it('ignora aviso de cobrança que o DocPay não emitiu', async () => {
      const { service } = setup();
      const unknown = JSON.stringify({ id: 'evt_1', chargeId: 'sim_ch_999999' });
      expect(await service.handleWebhook(unknown)).toEqual({ status: 'unknown_charge' });
    });

    it('guarda o aviso bruto mesmo quando ele é inválido', async () => {
      const { service, webhooks } = setup();

      await expect(service.handleWebhook('isto não é json')).rejects.toMatchObject({
        name: 'ProviderError',
        code: 'INVALID_WEBHOOK',
      });
      expect(webhooks.all()).toEqual([
        { provider: 'simulated', body: 'isto não é json', receivedAt: NOW },
      ]);
    });

    it('registra divergência quando o valor pago é diferente, e o beneficiário fica com a diferença', async () => {
      const { service, provider, ledger } = setup();
      const charge = await service.create(input);
      // Pago com R$ 10,00 de juros.
      await service.handleWebhook(
        provider.pay(charge.providerChargeId, { method: 'boleto', paidAmountCents: 101_000 }),
      );

      const paid = await service.get(charge.id);
      expect(paid?.divergences.map((divergence) => divergence.code)).toEqual(['PAID_AMOUNT_DIFFERS']);
      expect(await ledger.balance(ledgerAccountFor('vendedor'))).toBe(101_000 - 40_000 - 299);
      expect(await ledger.balance(ledgerAccountFor('parceiro'))).toBe(40_000);
    });

    it('sync dá baixa mesmo sem aviso, para a conciliação recuperar avisos perdidos', async () => {
      const { service, provider } = setup();
      const charge = await service.create(input);
      provider.pay(charge.providerChargeId);

      expect(await service.sync(charge.id)).toEqual({ status: 'settled', chargeId: charge.id });
      expect(await service.sync(charge.id)).toEqual({ status: 'unchanged', chargeId: charge.id });
    });

    it('sync de cobrança ainda não paga não muda nada', async () => {
      const { service } = setup();
      const charge = await service.create(input);
      expect(await service.sync(charge.id)).toEqual({ status: 'unchanged', chargeId: charge.id });
    });

    it('sync de cobrança desconhecida é recusado', async () => {
      const { service } = setup();
      const error = await chargeRejection(service.sync('ch_999'));
      expect(error.code).toBe('CHARGE_NOT_FOUND');
    });
  });
});
