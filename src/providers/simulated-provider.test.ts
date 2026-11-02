import { describe, expect, it } from 'vitest';
import { ProviderError, type ProviderErrorCode } from './errors.js';
import { SimulatedProvider } from './simulated-provider.js';
import type { ProviderChargeRef, ProviderChargeRequest } from './types.js';

const request: ProviderChargeRequest = {
  idempotencyKey: 'cobranca-1',
  reference: 'DOCLINE-1',
  beneficiary: 'vendedor',
  method: 'boleto',
  amountCents: 100_000,
  dueDate: '2026-11-10',
  payer: { name: 'Maria Silva', document: '529.982.247-25' },
  transfers: [{ account: 'parceiro', amountCents: 40_000 }],
};

function ref(id: string): ProviderChargeRef {
  return { id, method: 'boleto', amountCents: 100_000, transfers: request.transfers };
}

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
  it('cria o boleto com link, linha digitável e Pix de mentira', async () => {
    const charge = await new SimulatedProvider().createCharge(request);

    expect(charge).toEqual({
      id: '9000000001',
      status: 'pending',
      providerStatus: { code: 'pending', label: 'Pendente' },
      paymentUrl: 'https://simulado.docpay.invalid/boleto/9000000001',
      digitableLine: expect.stringMatching(/^999\d{44}$/),
      pixCopyPaste: 'SIMULADO-PIX-9000000001',
    });
  });

  it('cria o Pix só com o copia e cola', async () => {
    const charge = await new SimulatedProvider().createCharge({ ...request, method: 'pix' });

    expect(charge).toEqual({
      id: '9000000001',
      status: 'pending',
      providerStatus: { code: 'pending', label: 'Pendente' },
      pixCopyPaste: 'SIMULADO-PIX-9000000001',
    });
  });

  it('numera as cobranças só com dígitos, a partir do número configurado', async () => {
    const provider = new SimulatedProvider({ firstChargeNumber: 1_793_000_000_000 });
    const first = await provider.createCharge(request);
    const second = await provider.createCharge({ ...request, idempotencyKey: 'cobranca-2' });

    expect([first.id, second.id]).toEqual(['1793000000000', '1793000000001']);
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new SimulatedProvider({ firstChargeNumber: invalid })).toThrow(RangeError);
    }
  });

  it('guarda o pedido, para os testes conferirem os repasses', async () => {
    const provider = new SimulatedProvider();
    const { id } = await provider.createCharge(request);

    expect(provider.requestFor(id)).toEqual(request);
  });

  it('com a mesma chave e o mesmo pedido, devolve a mesma cobrança', async () => {
    const provider = new SimulatedProvider();
    const first = await provider.createCharge(request);
    const again = await provider.createCharge({ ...request, payer: { ...request.payer } });

    expect(again).toEqual(first);
    expect(await rejectionCode(provider.getCharge(ref('9000000002')))).toBe('CHARGE_NOT_FOUND');
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
    provider.pay(id);

    const paid = await provider.getCharge(ref(id));
    expect(paid.status).toBe('paid');
    expect(paid.providerStatus).toEqual({ code: 'paid', label: 'Pago' });
    expect(paid.payment).toEqual({
      paidAt: '2026-11-05T15:00:00.000Z',
      method: 'boleto',
      paidAmountCents: 100_000,
      feeCents: 299,
      transfers: [{ account: 'parceiro', amountCents: 40_000 }],
    });
  });

  it('o boleto também pode ser pago pelo QR do Pix, com a tarifa do Pix', async () => {
    const provider = new SimulatedProvider();
    const { id } = await provider.createCharge(request);
    provider.pay(id, { method: 'pix' });

    expect((await provider.getCharge(ref(id))).payment).toMatchObject({ method: 'pix', feeCents: 240 });
  });

  it('usa as tarifas configuradas', async () => {
    const provider = new SimulatedProvider({ fees: { boleto: 199, pix: 199 } });
    const { id } = await provider.createCharge(request);
    provider.pay(id);

    expect((await provider.getCharge(ref(id))).payment?.feeCents).toBe(199);
  });

  it('dá baixa na cobrança vencida', async () => {
    const provider = new SimulatedProvider();
    const { id } = await provider.createCharge(request);
    provider.expire(id);

    const expired = await provider.getCharge(ref(id));
    expect(expired.status).toBe('expired');
    expect(expired.providerStatus).toEqual({ code: 'expired', label: 'Baixado' });
    expect(errorCode(() => provider.expire(id))).toBe('INVALID_REQUEST');
  });

  it('o aviso só diz qual cobrança mudou', async () => {
    const provider = new SimulatedProvider();
    const { id } = await provider.createCharge(request);
    const body = provider.pay(id);

    expect(JSON.parse(body)).toEqual({ id: 'sim_evt_000001', type: 'charge.updated', chargeId: id });
    expect(provider.parseWebhook({ body, query: {} })).toEqual({ chargeIds: [id] });
  });

  it('com chave configurada, recusa aviso sem a chave certa', async () => {
    const provider = new SimulatedProvider({ webhookKey: 'segredo' });
    const { id } = await provider.createCharge(request);
    const body = provider.pay(id);

    expect(errorCode(() => provider.parseWebhook({ body, query: {} }))).toBe('UNAUTHORIZED_WEBHOOK');
    expect(errorCode(() => provider.parseWebhook({ body, query: { k: 'errada' } }))).toBe('UNAUTHORIZED_WEBHOOK');
    expect(provider.parseWebhook({ body, query: { k: 'segredo' } })).toEqual({ chargeIds: [id] });
  });

  it('recusa aviso em formato inválido', () => {
    const provider = new SimulatedProvider();
    for (const body of ['não é json', 'null', '[]', '{"chargeId":1}']) {
      expect(errorCode(() => provider.parseWebhook({ body, query: {} }))).toBe('INVALID_WEBHOOK');
    }
  });

  it('recusa pagar duas vezes, pagar cobrança desconhecida ou pagar menos que os repasses e a tarifa', async () => {
    const provider = new SimulatedProvider();
    const { id } = await provider.createCharge(request);

    expect(errorCode(() => provider.pay(id, { paidAmountCents: 40_100 }))).toBe('INVALID_REQUEST');
    provider.pay(id);
    expect(errorCode(() => provider.pay(id))).toBe('ALREADY_PAID');
    expect(errorCode(() => provider.pay('9999999999'))).toBe('CHARGE_NOT_FOUND');
  });

  it('devolve cópias: mudar o que voltou não muda a cobrança no parceiro', async () => {
    const provider = new SimulatedProvider();
    const charge = await provider.createCharge(request);
    charge.status = 'paid';

    expect((await provider.getCharge(ref(charge.id))).status).toBe('pending');
  });
});
