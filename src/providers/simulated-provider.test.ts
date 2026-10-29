import { describe, expect, it } from 'vitest';
import { ProviderError, type ProviderErrorCode } from './errors.js';
import { SimulatedProvider } from './simulated-provider.js';
import type { ProviderChargeRequest } from './types.js';

const request: ProviderChargeRequest = {
  idempotencyKey: 'cobranca-1',
  beneficiary: 'vendedor',
  amountCents: 100_000,
  dueDate: '2026-11-10',
  payer: { name: 'Maria Silva', document: '529.982.247-25' },
  transfers: [{ account: 'parceiro', amountCents: 40_000 }],
};

async function rejectionCode(promise: Promise<unknown>): Promise<ProviderErrorCode> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error.code;
    throw error;
  }
  throw new Error('Esperava que o parceiro recusasse o pedido, mas ele foi aceito.');
}

function errorCode(action: () => unknown): ProviderErrorCode {
  try {
    action();
  } catch (error) {
    if (error instanceof ProviderError) return error.code;
    throw error;
  }
  throw new Error('Esperava que o parceiro recusasse o pedido, mas ele foi aceito.');
}

describe('SimulatedProvider', () => {
  it('cria a cobrança com linha digitável e Pix de mentira', async () => {
    const charge = await new SimulatedProvider().createCharge(request);

    expect(charge).toEqual({
      id: 'sim_ch_000001',
      status: 'pending',
      beneficiary: 'vendedor',
      amountCents: 100_000,
      dueDate: '2026-11-10',
      transfers: [{ account: 'parceiro', amountCents: 40_000 }],
      digitableLine: expect.stringMatching(/^999\d{44}$/),
      pixCopyPaste: 'SIMULADO-PIX-sim_ch_000001',
    });
  });

  it('com a mesma chave e o mesmo pedido, devolve a mesma cobrança', async () => {
    const provider = new SimulatedProvider();
    const first = await provider.createCharge(request);
    const again = await provider.createCharge({ ...request, payer: { ...request.payer } });

    expect(again).toEqual(first);
    expect(await rejectionCode(provider.getCharge('sim_ch_000002'))).toBe('CHARGE_NOT_FOUND');
  });

  it('recusa a mesma chave com outro pedido', async () => {
    const provider = new SimulatedProvider();
    await provider.createCharge(request);

    expect(await rejectionCode(provider.createCharge({ ...request, amountCents: 100_001 }))).toBe(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('recusa repasses que não deixam para o beneficiário o suficiente para a tarifa', async () => {
    const tooMuch = { ...request, transfers: [{ account: 'parceiro', amountCents: 99_800 }] };
    expect(await rejectionCode(new SimulatedProvider().createCharge(tooMuch))).toBe('INVALID_REQUEST');
  });

  it('recusa valor de cobrança ou de repasse inválido', async () => {
    const provider = new SimulatedProvider();
    expect(await rejectionCode(provider.createCharge({ ...request, amountCents: 0 }))).toBe(
      'INVALID_REQUEST',
    );
    const zeroTransfer = { ...request, transfers: [{ account: 'parceiro', amountCents: 0 }] };
    expect(await rejectionCode(provider.createCharge(zeroTransfer))).toBe('INVALID_REQUEST');
  });

  it('no pagamento, executa os repasses pedidos e cobra a tarifa do meio usado', async () => {
    const provider = new SimulatedProvider({ now: () => new Date('2026-11-05T15:00:00Z') });
    const { id } = await provider.createCharge(request);
    provider.pay(id, { method: 'boleto' });

    const paid = await provider.getCharge(id);
    expect(paid.status).toBe('paid');
    expect(paid.payment).toEqual({
      paidAt: '2026-11-05T15:00:00.000Z',
      method: 'boleto',
      paidAmountCents: 100_000,
      feeCents: 299,
      transfers: [{ account: 'parceiro', amountCents: 40_000 }],
    });
  });

  it('usa as tarifas configuradas', async () => {
    const provider = new SimulatedProvider({ fees: { boleto: 199, pix: 199 } });
    const { id } = await provider.createCharge(request);
    provider.pay(id);

    expect((await provider.getCharge(id)).payment?.feeCents).toBe(199);
  });

  it('o aviso de pagamento só diz qual cobrança mudou', async () => {
    const provider = new SimulatedProvider();
    const { id } = await provider.createCharge(request);
    const body = provider.pay(id);

    expect(JSON.parse(body)).toEqual({ id: 'sim_evt_000001', type: 'charge.updated', chargeId: id });
    expect(provider.parseWebhook(body)).toEqual({ eventId: 'sim_evt_000001', chargeId: id });
  });

  it('recusa aviso em formato inválido', () => {
    const provider = new SimulatedProvider();
    for (const body of ['não é json', 'null', '[]', '{"id":1,"chargeId":"x"}']) {
      expect(errorCode(() => provider.parseWebhook(body))).toBe('INVALID_WEBHOOK');
    }
  });

  it('recusa pagar duas vezes, pagar cobrança desconhecida ou pagar menos que os repasses e a tarifa', async () => {
    const provider = new SimulatedProvider();
    const { id } = await provider.createCharge(request);

    expect(errorCode(() => provider.pay(id, { paidAmountCents: 40_100 }))).toBe('INVALID_REQUEST');
    provider.pay(id);
    expect(errorCode(() => provider.pay(id))).toBe('ALREADY_PAID');
    expect(errorCode(() => provider.pay('sim_ch_999999'))).toBe('CHARGE_NOT_FOUND');
  });

  it('devolve cópias: mudar o que voltou não muda a cobrança no parceiro', async () => {
    const provider = new SimulatedProvider();
    const charge = await provider.createCharge(request);
    charge.transfers[0]!.amountCents = 1;
    charge.status = 'paid';

    const fresh = await provider.getCharge(charge.id);
    expect(fresh.status).toBe('pending');
    expect(fresh.transfers).toEqual([{ account: 'parceiro', amountCents: 40_000 }]);
  });
});
