/*
 * Adaptador da Safe2Pay. Porta para o DocPay o que o DocLine já validou em
 * produção (safe2pay.py e docs/SAFE2PAY.md do DocLine, de 08 a 29/10/2026):
 *
 * - POST https://payment.safe2pay.com.br/v2/Payment com o cabeçalho x-api-key
 *   e IsSandbox no corpo. PaymentMethod "1" = boleto (DueDate dd/mm/aaaa) e
 *   "6" = Pix (Expiration em segundos). O ambiente de teste não gera Pix
 *   (código 301).
 * - Divisão no formato que o suporte da Safe2Pay mandou: CodeTaxType 2 (valor
 *   fixo), IdReceiver, Name, IsPayTax (false: quem paga a tarifa é a conta
 *   principal) e Amount, em reais. Só as subcontas vão na divisão: o resto
 *   fica na conta principal, dona da chave (a linha dela é recusada, 1292).
 * - A Safe2Pay responde HTTP 200 mesmo com erro: o erro vem em HasError,
 *   Error e ErrorCode. O resultado vem em ResponseDetail.
 * - Consulta: GET https://api.safe2pay.com.br/v2/transaction/Get?Id=...
 *   Status 3, 4 e 11 = pago; 7 = baixado; 8 = recusado; 12 = em cancelamento.
 * - O aviso traz IdTransaction em algum nível do JSON; o formato varia.
 *
 * O que a consulta não traz (a tarifa e os repasses) vem da cobrança e da
 * tarifa do contrato, configurada. A Safe2Pay não reconhece chave de
 * idempotência: a reserva da chave no DocPay evita cobrança em dobro.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AccountDirectory } from '../../accounts/types.js';
import { missingAddressFields, onlyDigits } from '../../documents/address.js';
import { normalizeTaxId } from '../../documents/tax-id.js';
import type { Cents } from '../../money/cents.js';
import { DEFAULT_TIME_ZONE, zonedTime } from '../../shared/dates.js';
import type { AccountId } from '../../split/types.js';
import { ProviderError, type ProviderErrorCode } from '../errors.js';
import type {
  IncomingWebhook,
  Payer,
  PaymentMethod,
  PaymentProvider,
  ProviderCharge,
  ProviderChargeRef,
  ProviderChargeRequest,
  ProviderChargeStatus,
  ProviderStatus,
  ProviderWebhook,
  Transfer,
} from '../types.js';
import { feeFor, type Fee } from './fees.js';

export const PAYMENT_URL = 'https://payment.safe2pay.com.br/v2/Payment';
export const API_URL = 'https://api.safe2pay.com.br/v2';
const TIMEOUT_MS = 40_000;
const PIX_MIN_SECONDS = 3600;
const PIX_MAX_SECONDS = 30 * 24 * 3600;

export const SAFE2PAY_STATUS: Readonly<Record<number, string>> = {
  1: 'Pendente',
  2: 'Processamento',
  3: 'Autorizado',
  4: 'Disponível',
  5: 'Em disputa',
  6: 'Devolvido',
  7: 'Baixado',
  8: 'Recusado',
  11: 'Liberado',
  12: 'Em cancelamento',
  13: 'Chargeback',
  14: 'Pré-autorizado',
};
const PAID = new Set([3, 4, 11]);
const CLOSED: Readonly<Record<number, ProviderChargeStatus>> = { 7: 'expired', 8: 'failed', 12: 'canceled' };

const SANDBOX_PIX = 'O ambiente de teste da Safe2Pay não gera Pix, só boleto.';

/** O que fazer em cada recusa já vista em produção. */
const HINTS: Readonly<Record<string, string>> = {
  '022': 'Complete o endereço do pagador (CEP, logradouro, número, bairro, cidade e UF).',
  '256': 'O pagador não pode ser a própria empresa dona da conta: use outro CPF ou CNPJ.',
  '301': SANDBOX_PIX,
  '1292': 'Confira o Id Receiver da subconta Safe2Pay das contas da divisão (só números).',
  '207':
    'A Safe2Pay não achou a subconta. Confira o Id Receiver; se estiver certo, a subconta não está ligada ao Marketplace da conta principal.',
};

export interface Safe2PayOptions {
  apiKey: string;
  /** true: ambiente de teste da Safe2Pay (sem dinheiro de verdade; não gera Pix). */
  sandbox: boolean;
  /** Conta do DocPay dona da chave (a conta principal na Safe2Pay). Só ela emite cobranças. */
  mainAccount: AccountId;
  /** Endereço público do DocPay, para a Safe2Pay mandar o aviso de pagamento. */
  publicBaseUrl: string;
  /** Tarifa do contrato por meio de pagamento: a consulta da Safe2Pay não informa a tarifa. */
  fees: Readonly<Record<PaymentMethod, Fee>>;
  accounts: AccountDirectory;
  fetch?: typeof fetch;
  now?: () => Date;
  timeZone?: string;
}

type Detail = Record<string, unknown>;

export class Safe2PayProvider implements PaymentProvider {
  readonly name = 'safe2pay';
  readonly sandbox: boolean;
  readonly #options: Safe2PayOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeZone: string;

  constructor(options: Safe2PayOptions) {
    this.sandbox = options.sandbox;
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  }

  /** Endereço do aviso de pagamento, com a chave tirada da chave da API (não precisa de outra variável). */
  get webhookUrl(): string {
    return `${this.#options.publicBaseUrl.replace(/\/+$/, '')}/v1/providers/safe2pay/webhook?k=${this.#callbackKey()}`;
  }

  async createCharge(request: ProviderChargeRequest): Promise<ProviderCharge> {
    const { mainAccount, sandbox } = this.#options;
    if (request.beneficiary !== mainAccount) {
      throw this.#error(
        'INVALID_REQUEST',
        `A chave da Safe2Pay configurada só emite cobranças da conta ${mainAccount}, não de ${request.beneficiary}.`,
      );
    }
    if (sandbox && request.method === 'pix') throw this.#error('INVALID_REQUEST', SANDBOX_PIX, '301');
    if (request.method === 'boleto' && missingAddressFields(request.payer.address).length > 0) {
      throw this.#error('INVALID_REQUEST', `${HINTS['022']} A Safe2Pay exige o endereço no boleto.`, '022');
    }

    const [splits, vendor] = await Promise.all([this.#splits(request.transfers), this.#vendorName()]);
    const text = (request.description ?? request.reference).slice(0, 200);
    const payload = {
      IsSandbox: sandbox,
      Application: 'DocPay',
      Vendor: vendor,
      CallbackUrl: this.webhookUrl,
      Reference: request.reference,
      PaymentMethod: request.method === 'boleto' ? '1' : '6',
      PaymentObject:
        request.method === 'boleto'
          ? { DueDate: brazilianDate(request.dueDate), Instruction: text, IsEnablePartialPayment: false }
          : { Expiration: pixSeconds(request.dueDate, this.#now(), this.#timeZone) },
      Customer: customer(request.payer),
      Products: [{ Code: request.reference, Description: text, UnitPrice: reais(request.amountCents), Quantity: 1 }],
      Splits: splits,
    };

    const detail = await this.#call(PAYMENT_URL, { method: 'POST', body: JSON.stringify(payload) }, request.reference);
    const id = text_(detail.IdTransaction) || text_(detail.Id);
    if (!id) throw this.#unavailable('A Safe2Pay não devolveu o número da transação.', request.reference);
    const code = statusCode(detail.Status) ?? 1;

    const charge: ProviderCharge = { id, status: statusOf(code), providerStatus: labelOf(code) };
    if (request.method === 'boleto') {
      if (text_(detail.BankSlipUrl)) charge.paymentUrl = text_(detail.BankSlipUrl);
      if (text_(detail.DigitableLine)) charge.digitableLine = text_(detail.DigitableLine);
    } else {
      if (text_(detail.QrCode)) charge.pixQrCodeImage = text_(detail.QrCode);
      if (text_(detail.Key)) charge.pixCopyPaste = text_(detail.Key);
    }
    return charge;
  }

  async getCharge(ref: ProviderChargeRef): Promise<ProviderCharge> {
    const detail = await this.#call(`${API_URL}/transaction/Get?Id=${encodeURIComponent(ref.id)}`, { method: 'GET' });
    const code = statusCode(detail.Status ?? detail.TransactionStatus);
    if (code === undefined) throw this.#unavailable('A Safe2Pay não informou o status da transação.');

    const charge: ProviderCharge = { id: ref.id, status: statusOf(code), providerStatus: labelOf(code) };
    if (charge.status === 'paid') {
      charge.payment = {
        paidAt: parseSafe2PayDate(detail.PaymentDate ?? detail.PaymentDateTime, this.#timeZone) ?? this.#now().toISOString(),
        method: ref.method,
        // Pagamento parcial desligado e sem juros: o valor pago é o da cobrança.
        paidAmountCents: ref.amountCents,
        feeCents: feeFor(this.#options.fees[ref.method], ref.amountCents),
        transfers: ref.transfers.map((transfer) => ({ ...transfer })),
      };
    }
    return charge;
  }

  parseWebhook({ body, query }: IncomingWebhook): ProviderWebhook {
    if (!this.#validKey(query.k)) throw this.#error('UNAUTHORIZED_WEBHOOK', 'Aviso da Safe2Pay com a chave errada.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }
    return { chargeIds: transactionIds(parsed) };
  }

  async #splits(transfers: readonly Transfer[]) {
    if (transfers.length === 0) return [];
    const accounts = await this.#options.accounts.getMany(transfers.map((transfer) => transfer.account));
    return transfers.map(({ account: id, amountCents }) => {
      const account = accounts.get(id);
      const receiver = account?.providerRefs.safe2pay?.trim();
      if (!account || !receiver) {
        throw this.#error(
          'INVALID_REQUEST',
          `A conta ${id} não tem a subconta da Safe2Pay (Id Receiver) no cadastro de contas do DocPay.`,
        );
      }
      const receiverId = Number(receiver);
      if (!/^\d+$/.test(receiver) || !Number.isSafeInteger(receiverId)) {
        throw this.#error('INVALID_REQUEST', `O Id Receiver da conta ${id} precisa ter só números (está "${receiver}").`);
      }
      return {
        CodeTaxType: 2,
        IdReceiver: receiverId,
        Name: account.name.trim().slice(0, 100),
        IsPayTax: false,
        Amount: reais(amountCents),
      };
    });
  }

  async #vendorName(): Promise<string> {
    const { mainAccount, accounts } = this.#options;
    return (await accounts.getMany([mainAccount])).get(mainAccount)?.name ?? mainAccount;
  }

  async #call(url: string, init: RequestInit, reference?: string): Promise<Detail> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        headers: { 'x-api-key': this.#options.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw this.#unavailable('Não consegui falar com a Safe2Pay agora.', reference);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw this.#unavailable(`A Safe2Pay respondeu HTTP ${response.status} sem detalhes.`, reference);
    }
    if (isRecord(data) && data.HasError) {
      const message = text_(data.Error) || text_(data.Message) || 'erro sem descrição';
      const code = text_(data.ErrorCode);
      const hint = code ? HINTS[code] : undefined;
      throw this.#error(
        'INVALID_REQUEST',
        `A Safe2Pay recusou: ${message}${code ? ` (código ${code})` : ''}${hint ? ` ${hint}` : ''}`,
        code || undefined,
      );
    }
    if (response.status >= 400) throw this.#unavailable(`A Safe2Pay respondeu HTTP ${response.status}.`, reference);
    if (!isRecord(data)) throw this.#unavailable('A Safe2Pay respondeu num formato inesperado.', reference);

    const detail = Array.isArray(data.ResponseDetail) ? data.ResponseDetail[0] : data.ResponseDetail;
    return isRecord(detail) ? detail : {};
  }

  #callbackKey(): string {
    return createHmac('sha256', this.#options.apiKey).update('docpay-safe2pay-callback').digest('hex').slice(0, 32);
  }

  #validKey(key: string | undefined): boolean {
    const expected = Buffer.from(this.#callbackKey());
    const received = Buffer.from(String(key ?? ''));
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  /** Sem resposta da Safe2Pay. Na criação, pede para conferir o painel antes de tentar de novo. */
  #unavailable(message: string, reference?: string): ProviderError {
    const check = reference
      ? ` Antes de tentar de novo, confira no painel da Safe2Pay se a cobrança ${reference} não foi criada.`
      : '';
    return this.#error('UNAVAILABLE', `${message}${check}`);
  }

  #error(code: ProviderErrorCode, message: string, providerCode?: string): ProviderError {
    return new ProviderError(this.name, code, message, providerCode);
  }
}

/** Os números de transação de um aviso, em qualquer nível do JSON (até 3 níveis; listas até 20 itens). */
export function transactionIds(body: unknown): string[] {
  const ids: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 20)) walk(item, depth + 1);
    } else if (isRecord(value)) {
      for (const key of ['IdTransaction', 'TransactionId', 'TransactionID']) {
        const id = text_(value[key]);
        if (/^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
      }
      for (const child of Object.values(value)) {
        if (typeof child === 'object' && child !== null) walk(child, depth + 1);
      }
    }
  };
  walk(body, 0);
  return ids;
}

/** Data e hora da Safe2Pay ("2026-10-09T10:00:00" ou "09/10/2026 10:00:00", no horário de Brasília) em ISO. */
export function parseSafe2PayDate(value: unknown, timeZone: string): string | undefined {
  const text = text_(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  const parts = iso
    ? { y: iso[1], m: iso[2], d: iso[3], h: iso[4], mi: iso[5], s: iso[6] }
    : br
      ? { y: br[3], m: br[2], d: br[1], h: br[4], mi: br[5], s: br[6] }
      : undefined;
  if (!parts) return undefined;
  const local = `${parts.y}-${parts.m}-${parts.d}T${parts.h ?? '00'}:${parts.mi ?? '00'}:${parts.s ?? '00'}`;
  const instant = zonedTime(local, timeZone);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function customer(payer: Payer): Record<string, unknown> {
  const out: Record<string, unknown> = {
    Name: payer.name.trim().slice(0, 200),
    Identity: normalizeTaxId(payer.document),
  };
  if (payer.email?.trim()) out.Email = payer.email.trim().slice(0, 150);
  const phone = onlyDigits(payer.phone);
  if (phone) out.Phone = phone.slice(-11);
  const address = payer.address;
  if (address && missingAddressFields(address).length === 0) {
    out.Address = {
      ZipCode: onlyDigits(address.zipCode).slice(0, 8),
      Street: address.street.trim().slice(0, 150),
      Number: (address.number?.trim() || 'S/N').slice(0, 15),
      Complement: (address.complement ?? '').trim().slice(0, 150),
      District: address.district.trim().slice(0, 60),
      CityName: address.city.trim().slice(0, 200),
      StateInitials: address.state.trim().toUpperCase().slice(0, 2),
      CountryName: 'Brasil',
    };
  }
  return out;
}

/** Validade do Pix: até o fim do dia do vencimento, entre 1 hora e 30 dias. */
export function pixSeconds(dueDate: string, now: Date, timeZone: string): number {
  const end = zonedTime(`${dueDate}T23:59:59`, timeZone);
  const seconds = Math.floor((end.getTime() - now.getTime()) / 1000);
  return Math.max(PIX_MIN_SECONDS, Math.min(PIX_MAX_SECONDS, seconds));
}

/** Centavos em reais, como a Safe2Pay pede: 4050 → 40.5. */
export function reais(cents: Cents): number {
  return Number((cents / 100).toFixed(2));
}

function brazilianDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

function statusCode(value: unknown): number | undefined {
  const raw = isRecord(value) ? (value.Code ?? value.Id) : value;
  const code = Number.parseInt(text_(raw), 10);
  return Number.isNaN(code) ? undefined : code;
}

function statusOf(code: number): ProviderChargeStatus {
  if (PAID.has(code)) return 'paid';
  // Em disputa, devolvido, chargeback ou desconhecido: fica em aberto para conferência.
  return CLOSED[code] ?? 'pending';
}

function labelOf(code: number): ProviderStatus {
  return { code: String(code), label: SAFE2PAY_STATUS[code] ?? `status ${code}` };
}

function text_(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
