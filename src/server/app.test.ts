import { describe, expect, it } from 'vitest';
import { InMemoryAccountRepository } from '../accounts/repositories.js';
import { ChargeService } from '../charges/charge-service.js';
import { InMemoryChargeClaims } from '../charges/claims.js';
import { InMemoryChargeRepository, InMemoryWebhookInbox } from '../charges/repositories.js';
import type { Charge, CreateChargeInput } from '../charges/types.js';
import { InMemoryLedger } from '../ledger/in-memory-ledger.js';
import { ProviderError } from '../providers/errors.js';
import { SimulatedProvider } from '../providers/simulated-provider.js';
import type { ProviderCharge, ProviderChargeRef } from '../providers/types.js';
import { buildApp, errorResponse } from './app.js';

const API_KEY = 'chave-de-teste-do-docline-com-tamanho';
const NOW = new Date('2026-10-29T12:00:00.000Z');
const now = () => NOW;
const auth = { authorization: `Bearer ${API_KEY}` };

class FlakyProvider extends SimulatedProvider {
  offline = false;

  override async getCharge(ref: ProviderChargeRef): Promise<ProviderCharge> {
    if (this.offline) throw new ProviderError('simulated', 'UNAVAILABLE', 'Parceiro fora do ar.');
    return super.getCharge(ref);
  }
}

function setup() {
  const provider = new FlakyProvider({ now });
  const accounts = new InMemoryAccountRepository();
  const notified: string[] = [];
  const service = new ChargeService({
    provider,
    ledger: new InMemoryLedger({ now }),
    charges: new InMemoryChargeRepository(),
    claims: new InMemoryChargeClaims(),
    webhooks: new InMemoryWebhookInbox(),
    now,
    notifier: { notify: async (charge) => void notified.push(`${charge.id}:${charge.status}`) },
  });
  const app = buildApp({ apiKey: API_KEY, service, accounts, provider, simulator: provider, now });
  return { app, provider, notified };
}

const input: CreateChargeInput = {
  idempotencyKey: 'docline-venda-13',
  reference: 'DOCLINE-13',
  method: 'boleto',
  amountCents: 13_500,
  dueDate: '2026-11-10',
  payer: {
    name: 'Maria Silva',
    document: '529.982.247-25',
    address: { zipCode: '60160-230', street: 'Rua Silva Paulet', district: 'Meireles', city: 'Fortaleza', state: 'CE' },
  },
  rule: { beneficiary: 'docline', recipients: [{ account: 'docline:parceiro:42', percentBps: 3_000 }] },
};

describe('API do DocPay', () => {
  it('responde ao /health sem chave', async () => {
    const { app } = setup();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, provider: 'simulated' });
  });

  it('exige a chave de acesso nas rotas /v1', async () => {
    const { app } = setup();
    for (const headers of [{}, { authorization: 'Bearer errada' }, { authorization: API_KEY }, { authorization: `Basic ${API_KEY}` }]) {
      const response = await app.inject({ method: 'GET', url: '/v1/charges/ch_1', headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(401);
      expect(response.json().error).toBe('UNAUTHORIZED');
    }
  });

  describe('contas', () => {
    it('cria, atualiza e consulta a conta', async () => {
      const { app } = setup();
      const saved = await app.inject({
        method: 'PUT',
        url: '/v1/accounts/docline:parceiro:42',
        headers: auth,
        payload: { name: 'Contabilidade Silva', providerRefs: { safe2pay: '123456' } },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ id: 'docline:parceiro:42', name: 'Contabilidade Silva', providerRefs: { safe2pay: '123456' } });

      const found = await app.inject({ method: 'GET', url: '/v1/accounts/docline:parceiro:42', headers: auth });
      expect(found.json()).toEqual(saved.json());
      expect((await app.inject({ method: 'GET', url: '/v1/accounts/outra', headers: auth })).statusCode).toBe(404);
    });

    it('recusa conta inválida com os problemas, e formato errado com 400', async () => {
      const { app } = setup();
      const invalid = await app.inject({ method: 'PUT', url: '/v1/accounts/x', headers: auth, payload: { name: ' ' } });
      expect(invalid.statusCode).toBe(422);
      expect(invalid.json()).toMatchObject({ error: 'INVALID_ACCOUNT', issues: [{ code: 'MISSING_ACCOUNT_NAME', path: 'name' }] });

      const extra = await app.inject({ method: 'PUT', url: '/v1/accounts/x', headers: auth, payload: { name: 'X', apelido: 'Y' } });
      expect(extra.statusCode).toBe(400);
      expect(extra.json().error).toBe('INVALID_REQUEST_FORMAT');
    });
  });

  describe('cobranças', () => {
    it('emite a cobrança e devolve a mesma ao repetir a chave', async () => {
      const { app } = setup();
      const first = await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload: input });
      expect(first.statusCode).toBe(200);
      const charge = first.json<Charge>();
      expect(charge).toMatchObject({ reference: 'DOCLINE-13', method: 'boleto', status: 'pending', provider: 'simulated' });

      const again = await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload: input });
      expect(again.json<Charge>().id).toBe(charge.id);

      const found = await app.inject({ method: 'GET', url: `/v1/charges/${charge.id}`, headers: auth });
      expect(found.json()).toEqual(charge);
      expect((await app.inject({ method: 'GET', url: '/v1/charges/ch_x', headers: auth })).statusCode).toBe(404);
    });

    it('recusa com 409 a mesma chave com outro conteúdo', async () => {
      const { app } = setup();
      await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload: input });
      const conflict = await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload: { ...input, amountCents: 13_600 } });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error).toBe('IDEMPOTENCY_CONFLICT');
    });

    it('devolve 422 com cada problema dos valores', async () => {
      const { app } = setup();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/charges',
        headers: auth,
        payload: { ...input, dueDate: '2026-10-01', payer: { ...input.payer, document: '123' } },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        error: 'INVALID_CHARGE',
        issues: [
          { code: 'PAST_DUE_DATE', path: 'dueDate' },
          { code: 'INVALID_PAYER_DOCUMENT', path: 'payer.document' },
        ],
      });
    });

    it('devolve 400 quando o formato está errado, sem converter tipos', async () => {
      const { app } = setup();
      for (const payload of [
        { ...input, amountCents: '13500' },
        { ...input, amountCents: 135.5 },
        { ...input, apelido: 'x' },
        { reference: 'só isso' },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      }
    });

    it('devolve 422 quando o parceiro recusa', async () => {
      const { app } = setup();
      // O parceiro simulado recusa repasses que não deixam espaço para a tarifa.
      const response = await app.inject({
        method: 'POST',
        url: '/v1/charges',
        headers: auth,
        payload: { ...input, rule: { beneficiary: 'docline', recipients: [{ account: 'p', fixedCents: 13_400 }] } },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ error: 'PROVIDER_INVALID_REQUEST', provider: 'simulated' });
    });

    it('paga pelo simulador, dá baixa, avisa o sistema cliente e consulta de novo', async () => {
      const { app, notified } = setup();
      const charge = (await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload: input })).json<Charge>();

      const paid = await app.inject({
        method: 'POST',
        url: `/v1/simulator/charges/${charge.providerChargeId}/pay`,
        headers: auth,
        payload: { method: 'pix' },
      });
      expect(paid.json()).toEqual({
        ok: true,
        outcomes: [{ providerChargeId: charge.providerChargeId, status: 'settled', chargeId: charge.id }],
      });
      expect(notified).toEqual([`${charge.id}:paid`]);

      const synced = await app.inject({ method: 'POST', url: `/v1/charges/${charge.id}/sync`, headers: auth });
      expect(synced.json()).toMatchObject({ result: { status: 'unchanged' }, charge: { status: 'paid' } });
    });

    it('roda a conciliação e os avisos pendentes', async () => {
      const { app } = setup();
      const response = await app.inject({ method: 'POST', url: '/v1/jobs/reconcile', headers: auth });
      expect(response.json()).toEqual({
        reconciliation: { checked: 0, settled: [], updated: [], failed: [] },
        notifications: { delivered: [], failed: [] },
      });
    });
  });

  describe('aviso do parceiro', () => {
    it('recebe o aviso sem a chave da API e consulta o parceiro', async () => {
      const { app, provider } = setup();
      const charge = (await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload: input })).json<Charge>();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/providers/simulated/webhook',
        headers: { 'content-type': 'application/json' },
        payload: provider.expire(charge.providerChargeId),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        ok: true,
        outcomes: [{ providerChargeId: charge.providerChargeId, status: 'updated', chargeId: charge.id }],
      });
    });

    it('recusa parceiro que não é o configurado e aviso em formato inválido', async () => {
      const { app } = setup();
      const other = await app.inject({ method: 'POST', url: '/v1/providers/safe2pay/webhook', payload: '{}' });
      expect(other.statusCode).toBe(404);

      const invalid = await app.inject({
        method: 'POST',
        url: '/v1/providers/simulated/webhook',
        headers: { 'content-type': 'text/plain' },
        payload: 'isto não é json',
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toBe('PROVIDER_INVALID_WEBHOOK');
    });

    it('sem resposta do parceiro, devolve 502 para ele mandar o aviso de novo', async () => {
      const { app, provider } = setup();
      const charge = (await app.inject({ method: 'POST', url: '/v1/charges', headers: auth, payload: input })).json<Charge>();
      const webhook = provider.pay(charge.providerChargeId);
      provider.offline = true;

      const response = await app.inject({ method: 'POST', url: '/v1/providers/simulated/webhook', payload: webhook });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toBe('PROVIDER_UNAVAILABLE');
    });
  });

  it('erro inesperado vira 500 sem expor detalhes', () => {
    expect(errorResponse(new Error('senha do banco: 123'))).toEqual({
      status: 500,
      body: { error: 'INTERNAL', message: 'Erro interno no DocPay.' },
    });
  });
});
