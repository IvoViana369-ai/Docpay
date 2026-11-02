import { randomUUID } from 'node:crypto';
import type { Ledger } from '../ledger/types.js';
import type { IncomingWebhook, PaymentProvider } from '../providers/types.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { DEFAULT_TIME_ZONE, todayIn } from '../shared/dates.js';
import { calculateSplit } from '../split/calculate-split.js';
import { SplitError } from '../split/errors.js';
import type { SplitResult } from '../split/types.js';
import { ChargeError, type ChargeIssue } from './errors.js';
import type { ChargeRepository, PendingCursor, WebhookInbox } from './repositories.js';
import { findDivergences, requestedTransfers, settlementTransaction } from './settlement.js';
import type { Charge, CreateChargeInput } from './types.js';
import { validateChargeFields } from './validate-charge.js';

export interface ChargeServiceDeps {
  provider: PaymentProvider;
  ledger: Ledger;
  charges: ChargeRepository;
  webhooks: WebhookInbox;
  now?: () => Date;
  newId?: () => string;
  /** Fuso usado para saber a data de hoje. Padrão: America/Sao_Paulo. */
  timeZone?: string;
  /** Quantas cobranças a conciliação busca por vez. Padrão: 100. */
  reconciliationPageSize?: number;
}

export interface SyncResult {
  /**
   * settled: a cobrança foi paga e a baixa foi lançada agora. updated: mudou
   * de status sem dinheiro envolvido (vencida, cancelada, recusada).
   * unchanged: nada a fazer.
   */
  status: 'settled' | 'updated' | 'unchanged';
  chargeId: string;
}

export type WebhookOutcome = { providerChargeId: string } & (SyncResult | { status: 'unknown_charge' });

export interface ReconciliationReport {
  /** Cobranças em aberto consultadas no parceiro. */
  checked: number;
  /** Cobranças que estavam pagas no parceiro e receberam baixa agora: o aviso delas se perdeu. */
  settled: string[];
  /** Cobranças que mudaram de status sem pagamento (vencidas, canceladas, recusadas). */
  updated: string[];
  /** Cobranças que não deu para conferir, com o motivo. A próxima conciliação tenta de novo. */
  failed: { chargeId: string; message: string }[];
}

/**
 * O caminho de uma cobrança: emissão no parceiro, aviso de pagamento e baixa
 * no razão. O dinheiro nunca passa pelo DocPay; aqui só se decide quanto vai
 * para cada conta, registra-se o que aconteceu e confere-se com o parceiro.
 */
export class ChargeService {
  readonly #provider: PaymentProvider;
  readonly #ledger: Ledger;
  readonly #charges: ChargeRepository;
  readonly #webhooks: WebhookInbox;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #timeZone: string;
  readonly #reconciliationPageSize: number;

  constructor(deps: ChargeServiceDeps) {
    this.#provider = deps.provider;
    this.#ledger = deps.ledger;
    this.#charges = deps.charges;
    this.#webhooks = deps.webhooks;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => randomUUID());
    this.#timeZone = deps.timeZone ?? DEFAULT_TIME_ZONE;
    this.#reconciliationPageSize = deps.reconciliationPageSize ?? 100;
  }

  /**
   * Emite uma cobrança. Repetir a chamada com a mesma chave devolve a mesma
   * cobrança, inclusive quando a resposta do parceiro se perdeu no caminho e
   * o parceiro reconhece a chave.
   */
  async create(input: CreateChargeInput): Promise<Charge> {
    const split = this.#prepare(input);

    const existing = await this.#charges.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return sameRequestOrConflict(existing, input);

    const reference = input.reference ?? input.idempotencyKey;
    const transfers = requestedTransfers({ expectedShares: split.shares });
    const remote = await this.#provider.createCharge({
      idempotencyKey: input.idempotencyKey,
      reference,
      beneficiary: input.rule.beneficiary,
      method: input.method,
      amountCents: input.amountCents,
      dueDate: input.dueDate,
      payer: input.payer,
      transfers,
      ...(input.description === undefined ? {} : { description: input.description }),
    });

    const charge: Charge = {
      id: this.#newId(),
      idempotencyKey: input.idempotencyKey,
      reference,
      method: input.method,
      status: 'pending',
      amountCents: input.amountCents,
      dueDate: input.dueDate,
      payer: structuredClone(input.payer),
      rule: structuredClone(input.rule),
      expectedShares: split.shares,
      provider: this.#provider.name,
      providerChargeId: remote.id,
      providerStatus: remote.providerStatus,
      divergences: [],
      createdAt: this.#now().toISOString(),
    };
    if (input.description !== undefined) charge.description = input.description;
    if (input.fiscalDocumentKey !== undefined) charge.fiscalDocumentKey = input.fiscalDocumentKey;
    if (remote.paymentUrl !== undefined) charge.paymentUrl = remote.paymentUrl;
    if (remote.digitableLine !== undefined) charge.digitableLine = remote.digitableLine;
    if (remote.pixCopyPaste !== undefined) charge.pixCopyPaste = remote.pixCopyPaste;

    if (await this.#charges.insert(charge)) {
      // O parceiro pode já devolver a cobrança paga ou recusada. Se a consulta
      // falhar agora, a cobrança já está criada e a conciliação confere depois.
      if (remote.status !== 'pending') await this.sync(charge.id).catch(() => undefined);
      return (await this.#charges.findById(charge.id)) ?? charge;
    }

    // Outra chamada com a mesma chave gravou primeiro.
    const winner = await this.#charges.findByIdempotencyKey(input.idempotencyKey);
    if (!winner) throw new Error(`A cobrança com a chave ${input.idempotencyKey} sumiu durante a gravação.`);
    return sameRequestOrConflict(winner, input);
  }

  async get(chargeId: string): Promise<Charge | undefined> {
    return this.#charges.findById(chargeId);
  }

  /**
   * Consulta a cobrança no parceiro e registra o que mudou: se foi paga, lança
   * a baixa no razão; se venceu, foi cancelada ou recusada, muda o status. É o
   * que o aviso do parceiro dispara, e o que a conciliação chama para as
   * cobranças cujo aviso se perdeu. Chamar de novo não lança de novo.
   */
  async sync(chargeId: string): Promise<SyncResult> {
    const charge = await this.#charges.findById(chargeId);
    if (!charge) throw new ChargeError('CHARGE_NOT_FOUND', `Cobrança ${chargeId} não encontrada.`);
    if (charge.status === 'paid') return { status: 'unchanged', chargeId };

    const remote = await this.#provider.getCharge({
      id: charge.providerChargeId,
      method: charge.method,
      amountCents: charge.amountCents,
      transfers: requestedTransfers(charge),
    });

    if (remote.status === 'paid') {
      if (!remote.payment) {
        throw new Error(`O parceiro informou a cobrança ${chargeId} como paga, sem os dados do pagamento.`);
      }
      // A chave do lançamento é a mesma em toda tentativa: se a baixa já foi
      // lançada e a gravação da cobrança falhou, o razão devolve o mesmo lançamento.
      const transaction = await this.#ledger.post(settlementTransaction(charge, remote.payment));
      await this.#charges.update({
        ...charge,
        status: 'paid',
        providerStatus: remote.providerStatus,
        payment: { ...remote.payment, ledgerTransactionId: transaction.id },
        divergences: findDivergences(charge, remote.payment),
      });
      return { status: 'settled', chargeId };
    }

    // Vencida, cancelada ou recusada: muda o status; nenhum dinheiro se mexeu.
    if (remote.status !== 'pending' && remote.status !== charge.status) {
      await this.#charges.update({ ...charge, status: remote.status, providerStatus: remote.providerStatus });
      return { status: 'updated', chargeId };
    }

    if (canonicalJson(remote.providerStatus) !== canonicalJson(charge.providerStatus)) {
      await this.#charges.update({ ...charge, providerStatus: remote.providerStatus });
    }
    return { status: 'unchanged', chargeId };
  }

  /**
   * Trata um aviso (webhook) do parceiro. Guarda o aviso bruto e nunca confia
   * no conteúdo: só usa o aviso para saber quais cobranças consultar.
   */
  async handleWebhook(webhook: IncomingWebhook): Promise<WebhookOutcome[]> {
    await this.#webhooks.save({
      provider: this.#provider.name,
      body: webhook.body,
      receivedAt: this.#now().toISOString(),
    });

    const { chargeIds } = this.#provider.parseWebhook(webhook);
    const outcomes: WebhookOutcome[] = [];
    for (const providerChargeId of chargeIds) {
      const charge = await this.#charges.findByProviderChargeId(this.#provider.name, providerChargeId);
      outcomes.push(
        charge
          ? { providerChargeId, ...(await this.sync(charge.id)) }
          : { providerChargeId, status: 'unknown_charge' },
      );
    }
    return outcomes;
  }

  /**
   * Conciliação: consulta no parceiro todas as cobranças ainda em aberto no
   * DocPay e registra o que mudou, recuperando avisos que se perderam. Uma
   * falha numa cobrança não interrompe as outras.
   */
  async reconcilePending(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = { checked: 0, settled: [], updated: [], failed: [] };
    let after: PendingCursor | undefined;

    for (;;) {
      const page = await this.#charges.findPending({ limit: this.#reconciliationPageSize, after });
      for (const charge of page) {
        report.checked += 1;
        try {
          const result = await this.sync(charge.id);
          if (result.status === 'settled') report.settled.push(charge.id);
          if (result.status === 'updated') report.updated.push(charge.id);
        } catch (error) {
          report.failed.push({
            chargeId: charge.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const last = page.at(-1);
      if (!last || page.length < this.#reconciliationPageSize) return report;
      after = { createdAt: last.createdAt, id: last.id };
    }
  }

  /** Confere tudo de uma vez e devolve a divisão; lança ChargeError com todos os problemas. */
  #prepare(input: CreateChargeInput): SplitResult {
    const issues: ChargeIssue[] = validateChargeFields(input, todayIn(this.#timeZone, this.#now()));
    let split: SplitResult | undefined;
    try {
      split = calculateSplit({ amountCents: input.amountCents, rule: input.rule });
    } catch (error) {
      if (!(error instanceof SplitError)) throw error;
      issues.push(...error.issues.map((issue) => ({ ...issue, path: rulePath(issue.path) })));
    }
    if (issues.length > 0 || split === undefined) {
      throw new ChargeError('INVALID_CHARGE', issues.map((issue) => issue.message).join(' '), issues);
    }
    return split;
  }
}

function sameRequestOrConflict(existing: Charge, input: CreateChargeInput): Charge {
  if (requestFingerprint(existing) === requestFingerprint(input)) return existing;
  throw new ChargeError(
    'IDEMPOTENCY_CONFLICT',
    `A chave ${input.idempotencyKey} já foi usada numa cobrança diferente.`,
  );
}

function requestFingerprint(request: CreateChargeInput | Charge): string {
  const { idempotencyKey, method, amountCents, dueDate, payer, rule, description, fiscalDocumentKey } = request;
  return canonicalJson({
    reference: request.reference ?? idempotencyKey,
    method,
    amountCents,
    dueDate,
    payer,
    rule,
    description,
    fiscalDocumentKey,
  });
}

/** Os caminhos do motor de divisão são relativos à regra, exceto o do valor. */
function rulePath(path: string | undefined): string | undefined {
  return path === undefined || path === 'amountCents' ? path : `rule.${path}`;
}
