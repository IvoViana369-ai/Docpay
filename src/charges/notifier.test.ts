import { describe, expect, it } from 'vitest';
import { WebhookNotifier, signatureHeader, verifySignature, type ChargeNotification } from './notifier.js';
import type { Charge } from './types.js';

const NOW = new Date('2026-11-05T13:00:00.000Z');

const charge = {
  id: 'ch_1',
  idempotencyKey: 'docline-venda-13',
  reference: 'DOCLINE-13',
  status: 'paid',
} as Charge;

function recordingFetch(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response('{}', { status });
  }) as typeof fetch;
  return { fetch: fetchFake, calls };
}

describe('WebhookNotifier', () => {
  it('manda o aviso assinado, que o sistema cliente consegue conferir', async () => {
    const recorder = recordingFetch();
    const notifier = new WebhookNotifier({
      url: 'https://docline.example.com/api/docpay/webhook',
      secret: 'segredo-combinado',
      fetch: recorder.fetch,
      now: () => NOW,
    });

    await notifier.notify(charge);

    const [call] = recorder.calls;
    expect(call?.url).toBe('https://docline.example.com/api/docpay/webhook');
    expect(JSON.parse(call!.body) as ChargeNotification).toEqual({
      event: 'charge.updated',
      chargeId: 'ch_1',
      idempotencyKey: 'docline-venda-13',
      reference: 'DOCLINE-13',
      status: 'paid',
      occurredAt: NOW.toISOString(),
    });
    expect(verifySignature('segredo-combinado', call?.headers['X-DocPay-Signature'], call!.body, NOW)).toBe(true);
  });

  it('falha quando o sistema cliente não confirma', async () => {
    const notifier = new WebhookNotifier({ url: 'https://x.example', secret: 's', fetch: recordingFetch(500).fetch });
    await expect(notifier.notify(charge)).rejects.toThrow('O sistema avisado respondeu HTTP 500.');
  });
});

describe('verifySignature', () => {
  const body = '{"event":"charge.updated"}';
  const timestamp = Math.floor(NOW.getTime() / 1000);
  const header = signatureHeader('segredo', timestamp, body);

  it('recusa segredo errado, corpo alterado e cabeçalho estranho', () => {
    expect(verifySignature('segredo', header, body, NOW)).toBe(true);
    expect(verifySignature('outro', header, body, NOW)).toBe(false);
    expect(verifySignature('segredo', header, `${body} `, NOW)).toBe(false);
    expect(verifySignature('segredo', undefined, body, NOW)).toBe(false);
    expect(verifySignature('segredo', 'qualquer coisa', body, NOW)).toBe(false);
  });

  it('recusa aviso com mais de 5 minutos de diferença no horário', () => {
    expect(verifySignature('segredo', header, body, new Date(NOW.getTime() + 299_000))).toBe(true);
    expect(verifySignature('segredo', header, body, new Date(NOW.getTime() + 301_000))).toBe(false);
  });
});
