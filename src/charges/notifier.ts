import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Charge, ChargeStatus } from './types.js';

/** O aviso que o DocPay manda ao sistema que pediu a cobrança quando o status dela muda. */
export interface ChargeNotification {
  event: 'charge.updated';
  chargeId: string;
  idempotencyKey: string;
  reference: string;
  status: ChargeStatus;
  occurredAt: string;
}

export interface Notifier {
  /** Avisa o sistema cliente. Lança erro se ele não confirmar o recebimento. */
  notify(charge: Charge): Promise<void>;
}

export interface WebhookNotifierOptions {
  /** Endereço do sistema cliente que recebe os avisos (ex.: o do DocLine). */
  url: string;
  /** Segredo combinado com o sistema cliente, para ele conferir a assinatura. */
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Avisa por HTTP, com a assinatura no cabeçalho X-DocPay-Signature
 * ("t=<segundos>,v1=<HMAC-SHA256 de "<t>.<corpo>">"). O sistema cliente confere
 * a assinatura e, como o DocPay faz com os parceiros, consulta a cobrança
 * antes de agir.
 */
export class WebhookNotifier implements Notifier {
  readonly #options: WebhookNotifierOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: WebhookNotifierOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async notify(charge: Charge): Promise<void> {
    const now = this.#now();
    const notification: ChargeNotification = {
      event: 'charge.updated',
      chargeId: charge.id,
      idempotencyKey: charge.idempotencyKey,
      reference: charge.reference,
      status: charge.status,
      occurredAt: now.toISOString(),
    };
    const body = JSON.stringify(notification);
    const response = await this.#fetch(this.#options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DocPay-Signature': signatureHeader(this.#options.secret, Math.floor(now.getTime() / 1000), body),
      },
      body,
      signal: AbortSignal.timeout(this.#options.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`O sistema avisado respondeu HTTP ${response.status}.`);
  }
}

export function signatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${hmac(secret, `${timestamp}.${body}`)}`;
}

/**
 * Confere a assinatura de um aviso do DocPay: o segredo certo e no máximo
 * `toleranceSeconds` de diferença de horário (contra reenvio de aviso velho).
 */
export function verifySignature(
  secret: string,
  header: string | undefined,
  body: string,
  now: Date,
  toleranceSeconds = 300,
): boolean {
  const parts = Object.fromEntries(
    String(header ?? '')
      .split(',')
      .map((part) => part.trim().split('=', 2) as [string, string]),
  );
  const timestamp = Number(parts.t);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = Buffer.from(hmac(secret, `${timestamp}.${body}`));
  const received = Buffer.from(String(parts.v1 ?? ''));
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}
