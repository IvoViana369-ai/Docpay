import { formatBRL, isCents, type Cents } from '../money/cents.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { ProviderError, type ProviderErrorCode } from './errors.js';
import type {
  IncomingWebhook,
  PaymentMethod,
  PaymentProvider,
  ProviderCharge,
  ProviderChargeRef,
  ProviderChargeRequest,
  ProviderChargeStatus,
  ProviderStatus,
  ProviderWebhook,
  Transfer,
} from './types.js';

export interface SimulatedProviderOptions {
  /** Tarifa por cobrança paga, em centavos. Padrão: R$ 2,99 no boleto e R$ 2,40 no Pix. */
  fees?: Readonly<Record<PaymentMethod, Cents>>;
  /** Se definida, o aviso só é aceito com esta chave no parâmetro `k`, como na Safe2Pay. */
  webhookKey?: string;
  /**
   * Número da primeira cobrança. Padrão: 9000000001. Os números têm só
   * dígitos, como os da Safe2Pay, porque o DocLine confere isso.
   */
  firstChargeNumber?: number;
  now?: () => Date;
}

const DEFAULT_FIRST_CHARGE_NUMBER = 9_000_000_001;

export interface SimulatedPayment {
  /** Padrão: o meio da cobrança. O boleto também pode ser pago pelo QR do Pix. */
  method?: PaymentMethod;
  /** Padrão: o valor da cobrança. Use outro valor para simular juros, multa ou desconto. */
  paidAmountCents?: Cents;
}

const STATUS_LABELS: Record<ProviderChargeStatus, string> = {
  pending: 'Pendente',
  paid: 'Pago',
  expired: 'Baixado',
  canceled: 'Cancelado',
  failed: 'Recusado',
};

interface StoredCharge {
  request: ProviderChargeRequest;
  charge: ProviderCharge;
}

/**
 * Parceiro de mentira, para desenvolver e testar sem contrato nem rede. Imita
 * o que importa num parceiro de verdade: a criação é idempotente, a tarifa
 * muda conforme o meio de pagamento, os repasses são executados exatamente
 * como pedidos e o aviso só diz qual cobrança mudou.
 */
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated';
  readonly #fees: Readonly<Record<PaymentMethod, Cents>>;
  readonly #webhookKey: string | undefined;
  readonly #firstChargeNumber: number;
  readonly #now: () => Date;
  readonly #charges = new Map<string, StoredCharge>();
  readonly #keys = new Map<string, { fingerprint: string; chargeId: string }>();
  #chargeCount = 0;
  #webhookCount = 0;

  constructor(options: SimulatedProviderOptions = {}) {
    const firstChargeNumber = options.firstChargeNumber ?? DEFAULT_FIRST_CHARGE_NUMBER;
    if (!Number.isSafeInteger(firstChargeNumber) || firstChargeNumber < 1) {
      throw new RangeError(`Número da primeira cobrança inválido (${String(firstChargeNumber)}).`);
    }
    this.#fees = options.fees ?? { boleto: 299, pix: 240 };
    this.#webhookKey = options.webhookKey;
    this.#firstChargeNumber = firstChargeNumber;
    this.#now = options.now ?? (() => new Date());
  }

  async createCharge(request: ProviderChargeRequest): Promise<ProviderCharge> {
    const { idempotencyKey, ...content } = request;
    const fingerprint = canonicalJson(content);
    const previous = this.#keys.get(idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw this.#error(
          'IDEMPOTENCY_CONFLICT',
          `A chave ${idempotencyKey} já foi usada numa cobrança diferente.`,
        );
      }
      return structuredClone(this.#find(previous.chargeId).charge);
    }

    this.#validate(request);

    this.#chargeCount += 1;
    const id = String(this.#firstChargeNumber + this.#chargeCount - 1);
    const pixCopyPaste = `SIMULADO-PIX-${id}`;
    const charge: ProviderCharge =
      request.method === 'boleto'
        ? {
            id,
            status: 'pending',
            providerStatus: statusOf('pending'),
            paymentUrl: `https://simulado.docpay.invalid/boleto/${id}`,
            digitableLine: fakeDigitableLine(this.#chargeCount, request.amountCents),
            pixCopyPaste,
          }
        : { id, status: 'pending', providerStatus: statusOf('pending'), pixCopyPaste };
    this.#charges.set(id, { request: structuredClone(request), charge });
    this.#keys.set(idempotencyKey, { fingerprint, chargeId: id });
    return structuredClone(charge);
  }

  async getCharge(ref: ProviderChargeRef): Promise<ProviderCharge> {
    return structuredClone(this.#find(ref.id).charge);
  }

  /** Só no simulador: o pedido que criou a cobrança, para os testes conferirem. */
  requestFor(chargeId: string): ProviderChargeRequest {
    return structuredClone(this.#find(chargeId).request);
  }

  /**
   * Só no simulador: paga a cobrança como se fosse o pagador e devolve o corpo
   * do aviso que o parceiro mandaria.
   */
  pay(chargeId: string, payment: SimulatedPayment = {}): string {
    const { charge, request } = this.#find(chargeId);
    if (charge.status === 'paid') {
      throw this.#error('ALREADY_PAID', `A cobrança ${chargeId} já foi paga.`);
    }

    const method = payment.method ?? request.method;
    const paidAmountCents = payment.paidAmountCents ?? request.amountCents;
    const feeCents = this.#fees[method];
    if (!isCents(paidAmountCents)) {
      throw this.#error('INVALID_REQUEST', `Valor pago inválido (${String(paidAmountCents)}).`);
    }
    if (paidAmountCents < sumOf(request.transfers) + feeCents) {
      throw this.#error(
        'INVALID_REQUEST',
        `O valor pago (${formatBRL(paidAmountCents)}) não cobre os repasses e a tarifa.`,
      );
    }

    charge.status = 'paid';
    charge.providerStatus = statusOf('paid');
    charge.payment = {
      paidAt: this.#now().toISOString(),
      method,
      paidAmountCents,
      feeCents,
      transfers: request.transfers.map((transfer) => ({ ...transfer })),
    };
    return this.#webhookFor(chargeId);
  }

  /** Só no simulador: o parceiro dá baixa na cobrança vencida e avisa. */
  expire(chargeId: string): string {
    const { charge } = this.#find(chargeId);
    if (charge.status !== 'pending') {
      throw this.#error('INVALID_REQUEST', `Só cobrança em aberto pode ser baixada (${chargeId}).`);
    }
    charge.status = 'expired';
    charge.providerStatus = statusOf('expired');
    return this.#webhookFor(chargeId);
  }

  parseWebhook({ body, query }: IncomingWebhook): ProviderWebhook {
    if (this.#webhookKey !== undefined && query.k !== this.#webhookKey) {
      throw this.#error('UNAUTHORIZED_WEBHOOK', 'Aviso com a chave errada.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const { chargeId } = parsed as Record<string, unknown>;
      if (typeof chargeId === 'string') return { chargeIds: [chargeId] };
    }
    throw this.#error('INVALID_WEBHOOK', 'Aviso em formato inválido.');
  }

  #webhookFor(chargeId: string): string {
    this.#webhookCount += 1;
    return JSON.stringify({
      id: `sim_evt_${String(this.#webhookCount).padStart(6, '0')}`,
      type: 'charge.updated',
      chargeId,
    });
  }

  #validate(request: ProviderChargeRequest): void {
    if (!isCents(request.amountCents) || request.amountCents === 0) {
      throw this.#error('INVALID_REQUEST', `Valor da cobrança inválido (${String(request.amountCents)}).`);
    }
    if (request.transfers.some(({ amountCents }) => !isCents(amountCents) || amountCents === 0)) {
      throw this.#error('INVALID_REQUEST', 'Há repasse com valor inválido.');
    }
    // A tarifa sai do beneficiário: o que sobra para ele precisa cobrir a maior tarifa possível.
    const maxFee = Math.max(...Object.values(this.#fees));
    const transferred = sumOf(request.transfers);
    if (request.amountCents - transferred < maxFee) {
      throw this.#error(
        'INVALID_REQUEST',
        `Os repasses (${formatBRL(transferred)}) não deixam para o beneficiário o suficiente para a tarifa, que pode chegar a ${formatBRL(maxFee)}.`,
      );
    }
  }

  #find(chargeId: string): StoredCharge {
    const stored = this.#charges.get(chargeId);
    if (!stored) throw this.#error('CHARGE_NOT_FOUND', `Cobrança ${chargeId} não encontrada.`);
    return stored;
  }

  #error(code: ProviderErrorCode, message: string): ProviderError {
    return new ProviderError(this.name, code, message);
  }
}

function statusOf(status: ProviderChargeStatus): ProviderStatus {
  return { code: status, label: STATUS_LABELS[status] };
}

function sumOf(transfers: readonly Transfer[]): Cents {
  return transfers.reduce((sum, transfer) => sum + transfer.amountCents, 0);
}

/** Linha digitável de mentira: 47 dígitos começando pelo banco 999, que não existe. */
function fakeDigitableLine(sequence: number, amountCents: Cents): string {
  return `999${String(sequence).padStart(10, '0')}${String(amountCents).padStart(34, '0')}`;
}
