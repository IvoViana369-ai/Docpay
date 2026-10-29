import { randomUUID } from 'node:crypto';
import type { Ledger } from '../ledger/types.js';
import type { PaymentProvider } from '../providers/types.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { calculateSplit } from '../split/calculate-split.js';
import { SplitError } from '../split/errors.js';
import type { SplitResult } from '../split/types.js';
import { ChargeError, type ChargeIssue } from './errors.js';
import type { ChargeRepository, WebhookInbox } from './repositories.js';
import { findDivergences, settlementTransaction } from './settlement.js';
import type { Charge, CreateChargeInput } from './types.js';
import { validateChargeFields } from './validate-charge.js';

export interface ChargeServiceDeps {
  provider: PaymentProvider;
  ledger: Ledger;
  charges: ChargeRepository;
  webhooks: WebhookInbox;
  now?: () => Date;
  newId?: () => string;
}

export interface SyncResult {
  /** settled: a baixa foi lançada agora. unchanged: nada a fazer. */
  status: 'settled' | 'unchanged';
  chargeId: string;
}

export type WebhookResult = SyncResult | { status: 'unknown_charge' };

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

  constructor(deps: ChargeServiceDeps) {
    this.#provider = deps.provider;
    this.#ledger = deps.ledger;
    this.#charges = deps.charges;
    this.#webhooks = deps.webhooks;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? (() => randomUUID());
  }

  /**
   * Emite uma cobrança. Repetir a chamada com a mesma chave devolve a mesma
   * cobrança, inclusive quando a resposta do parceiro se perdeu no caminho:
   * o parceiro também recebe a chave e devolve a cobrança que já tinha criado.
   */
  async create(input: CreateChargeInput): Promise<Charge> {
    const split = this.#prepare(input);

    const existing = await this.#charges.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return sameRequestOrConflict(existing, input);

    const remote = await this.#provider.createCharge({
      idempotencyKey: input.idempotencyKey,
      beneficiary: input.rule.beneficiary,
      amountCents: input.amountCents,
      dueDate: input.dueDate,
      payer: input.payer,
      transfers: split.shares
        .filter((share) => share.role === 'recipient' && share.grossCents > 0)
        .map(({ account, grossCents }) => ({ account, amountCents: grossCents })),
      ...(input.description === undefined ? {} : { description: input.description }),
    });

    const charge: Charge = {
      id: this.#newId(),
      idempotencyKey: input.idempotencyKey,
      status: 'pending',
      amountCents: input.amountCents,
      dueDate: input.dueDate,
      payer: structuredClone(input.payer),
      rule: structuredClone(input.rule),
      expectedShares: split.shares,
      provider: this.#provider.name,
      providerChargeId: remote.id,
      digitableLine: remote.digitableLine,
      pixCopyPaste: remote.pixCopyPaste,
      divergences: [],
      createdAt: this.#now().toISOString(),
    };
    if (input.description !== undefined) charge.description = input.description;
    if (input.fiscalDocumentKey !== undefined) charge.fiscalDocumentKey = input.fiscalDocumentKey;

    if (await this.#charges.insert(charge)) return charge;

    // Outra chamada com a mesma chave gravou primeiro.
    const winner = await this.#charges.findByIdempotencyKey(input.idempotencyKey);
    if (!winner) throw new Error(`A cobrança com a chave ${input.idempotencyKey} sumiu durante a gravação.`);
    return sameRequestOrConflict(winner, input);
  }

  async get(chargeId: string): Promise<Charge | undefined> {
    return this.#charges.findById(chargeId);
  }

  /**
   * Consulta a cobrança no parceiro e dá baixa se ela foi paga. É o que o
   * aviso de pagamento dispara, e o que a conciliação vai chamar para as
   * cobranças cujo aviso se perdeu. Chamar de novo não lança de novo.
   */
  async sync(chargeId: string): Promise<SyncResult> {
    const charge = await this.#charges.findById(chargeId);
    if (!charge) throw new ChargeError('CHARGE_NOT_FOUND', `Cobrança ${chargeId} não encontrada.`);
    if (charge.status === 'paid') return { status: 'unchanged', chargeId };

    const remote = await this.#provider.getCharge(charge.providerChargeId);
    if (remote.status !== 'paid' || remote.payment === undefined) {
      return { status: 'unchanged', chargeId };
    }

    // A chave do lançamento é a mesma em toda tentativa: se a baixa já foi
    // lançada e a gravação da cobrança falhou, o razão devolve o mesmo lançamento.
    const transaction = await this.#ledger.post(settlementTransaction(charge, remote.payment));
    await this.#charges.update({
      ...charge,
      status: 'paid',
      payment: { ...remote.payment, ledgerTransactionId: transaction.id },
      divergences: findDivergences(charge, remote.payment),
    });
    return { status: 'settled', chargeId };
  }

  /**
   * Trata um aviso (webhook) do parceiro. Guarda o aviso bruto e nunca confia
   * no conteúdo: só usa o aviso para saber qual cobrança consultar.
   */
  async handleWebhook(body: string): Promise<WebhookResult> {
    await this.#webhooks.save({
      provider: this.#provider.name,
      body,
      receivedAt: this.#now().toISOString(),
    });

    const webhook = this.#provider.parseWebhook(body);
    const charge = await this.#charges.findByProviderChargeId(this.#provider.name, webhook.chargeId);
    if (!charge) return { status: 'unknown_charge' };
    return this.sync(charge.id);
  }

  /** Confere tudo de uma vez e devolve a divisão; lança ChargeError com todos os problemas. */
  #prepare(input: CreateChargeInput): SplitResult {
    const issues: ChargeIssue[] = validateChargeFields(input);
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

type ChargeRequestFields = Pick<
  CreateChargeInput,
  'amountCents' | 'dueDate' | 'payer' | 'rule' | 'description' | 'fiscalDocumentKey'
>;

function requestFingerprint(request: ChargeRequestFields): string {
  const { amountCents, dueDate, payer, rule, description, fiscalDocumentKey } = request;
  return canonicalJson({ amountCents, dueDate, payer, rule, description, fiscalDocumentKey });
}

/** Os caminhos do motor de divisão são relativos à regra, exceto o do valor. */
function rulePath(path: string | undefined): string | undefined {
  return path === undefined || path === 'amountCents' ? path : `rule.${path}`;
}
