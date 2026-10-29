import { formatBRL, isCents, type Cents } from '../money/cents.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { ProviderError, type ProviderErrorCode } from './errors.js';
import type {
  PaymentMethod,
  PaymentProvider,
  ProviderCharge,
  ProviderChargeRequest,
  ProviderWebhook,
  Transfer,
} from './types.js';

export interface SimulatedProviderOptions {
  /** Tarifa por cobrança paga, em centavos. Padrão: R$ 2,99 no boleto e R$ 2,40 no Pix. */
  fees?: Readonly<Record<PaymentMethod, Cents>>;
  now?: () => Date;
}

export interface SimulatedPayment {
  /** Padrão: Pix. */
  method?: PaymentMethod;
  /** Padrão: o valor da cobrança. Use outro valor para simular juros, multa ou desconto. */
  paidAmountCents?: Cents;
}

/**
 * Parceiro de mentira, para desenvolver e testar sem contrato nem rede. Imita
 * o que importa num parceiro de verdade: a criação é idempotente, a tarifa
 * muda conforme o meio de pagamento, os repasses são executados exatamente
 * como pedidos e o aviso de pagamento só diz qual cobrança mudou.
 */
export class SimulatedProvider implements PaymentProvider {
  readonly name = 'simulated';
  readonly #fees: Readonly<Record<PaymentMethod, Cents>>;
  readonly #now: () => Date;
  readonly #charges = new Map<string, ProviderCharge>();
  readonly #keys = new Map<string, { fingerprint: string; chargeId: string }>();
  #chargeCount = 0;
  #webhookCount = 0;

  constructor(options: SimulatedProviderOptions = {}) {
    this.#fees = options.fees ?? { boleto: 299, pix: 240 };
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
      return this.getCharge(previous.chargeId);
    }

    this.#validate(request);

    this.#chargeCount += 1;
    const id = `sim_ch_${String(this.#chargeCount).padStart(6, '0')}`;
    const charge: ProviderCharge = {
      id,
      status: 'pending',
      beneficiary: request.beneficiary,
      amountCents: request.amountCents,
      dueDate: request.dueDate,
      transfers: request.transfers.map((transfer) => ({ ...transfer })),
      digitableLine: fakeDigitableLine(this.#chargeCount, request.amountCents),
      pixCopyPaste: `SIMULADO-PIX-${id}`,
    };
    this.#charges.set(id, charge);
    this.#keys.set(idempotencyKey, { fingerprint, chargeId: id });
    return structuredClone(charge);
  }

  async getCharge(chargeId: string): Promise<ProviderCharge> {
    return structuredClone(this.#find(chargeId));
  }

  /**
   * Só existe no simulador: paga a cobrança como se fosse o pagador e devolve
   * o corpo do aviso que o parceiro mandaria.
   */
  pay(chargeId: string, payment: SimulatedPayment = {}): string {
    const charge = this.#find(chargeId);
    if (charge.status === 'paid') {
      throw this.#error('ALREADY_PAID', `A cobrança ${chargeId} já foi paga.`);
    }

    const method = payment.method ?? 'pix';
    const paidAmountCents = payment.paidAmountCents ?? charge.amountCents;
    const feeCents = this.#fees[method];
    if (!isCents(paidAmountCents)) {
      throw this.#error('INVALID_REQUEST', `Valor pago inválido (${String(paidAmountCents)}).`);
    }
    if (paidAmountCents < sumOf(charge.transfers) + feeCents) {
      throw this.#error(
        'INVALID_REQUEST',
        `O valor pago (${formatBRL(paidAmountCents)}) não cobre os repasses e a tarifa.`,
      );
    }

    charge.status = 'paid';
    charge.payment = {
      paidAt: this.#now().toISOString(),
      method,
      paidAmountCents,
      feeCents,
      transfers: charge.transfers.map((transfer) => ({ ...transfer })),
    };

    this.#webhookCount += 1;
    return JSON.stringify({
      id: `sim_evt_${String(this.#webhookCount).padStart(6, '0')}`,
      type: 'charge.updated',
      chargeId,
    });
  }

  parseWebhook(body: string): ProviderWebhook {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const { id, chargeId } = parsed as Record<string, unknown>;
      if (typeof id === 'string' && typeof chargeId === 'string') {
        return { eventId: id, chargeId };
      }
    }
    throw this.#error('INVALID_WEBHOOK', 'Aviso em formato inválido.');
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

  #find(chargeId: string): ProviderCharge {
    const charge = this.#charges.get(chargeId);
    if (!charge) throw this.#error('CHARGE_NOT_FOUND', `Cobrança ${chargeId} não encontrada.`);
    return charge;
  }

  #error(code: ProviderErrorCode, message: string): ProviderError {
    return new ProviderError(this.name, code, message);
  }
}

function sumOf(transfers: readonly Transfer[]): Cents {
  return transfers.reduce((sum, transfer) => sum + transfer.amountCents, 0);
}

/** Linha digitável de mentira: 47 dígitos começando pelo banco 999, que não existe. */
function fakeDigitableLine(sequence: number, amountCents: Cents): string {
  return `999${String(sequence).padStart(10, '0')}${String(amountCents).padStart(34, '0')}`;
}
