import type { Charge } from './types.js';

/** Posição numa lista de cobranças em aberto: a última cobrança da página anterior. */
export interface PendingCursor {
  createdAt: string;
  id: string;
}

export interface ChargeRepository {
  /** Grava uma cobrança nova. Devolve false se já existe uma com a mesma chave de idempotência. */
  insert(charge: Charge): Promise<boolean>;
  update(charge: Charge): Promise<void>;
  findById(id: string): Promise<Charge | undefined>;
  findByIdempotencyKey(idempotencyKey: string): Promise<Charge | undefined>;
  findByProviderChargeId(provider: string, providerChargeId: string): Promise<Charge | undefined>;
  /**
   * Cobranças em aberto, das mais antigas para as mais novas. Para a próxima
   * página, passe em `after` a última cobrança da página anterior.
   */
  findPending(options: { limit: number; after?: PendingCursor }): Promise<Charge[]>;
}

export interface ReceivedWebhook {
  provider: string;
  body: string;
  receivedAt: string;
}

/** Guarda cada aviso recebido do jeito que chegou, para auditoria e reprocessamento. */
export interface WebhookInbox {
  save(webhook: ReceivedWebhook): Promise<void>;
  /** Avisos mais recentes primeiro. */
  recent(limit: number): Promise<ReceivedWebhook[]>;
}

/** Cobranças em memória. Guarda e devolve cópias, como um banco de dados faria. */
export class InMemoryChargeRepository implements ChargeRepository {
  readonly #charges = new Map<string, Charge>();

  async insert(charge: Charge): Promise<boolean> {
    if (this.#find((stored) => stored.idempotencyKey === charge.idempotencyKey)) return false;
    if (this.#charges.has(charge.id)) throw new Error(`Já existe cobrança com o id ${charge.id}.`);
    this.#charges.set(charge.id, structuredClone(charge));
    return true;
  }

  async update(charge: Charge): Promise<void> {
    if (!this.#charges.has(charge.id)) throw new Error(`Cobrança ${charge.id} não existe.`);
    this.#charges.set(charge.id, structuredClone(charge));
  }

  async findById(id: string): Promise<Charge | undefined> {
    return this.#copy(this.#charges.get(id));
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<Charge | undefined> {
    return this.#copy(this.#find((charge) => charge.idempotencyKey === idempotencyKey));
  }

  async findByProviderChargeId(provider: string, providerChargeId: string): Promise<Charge | undefined> {
    return this.#copy(
      this.#find((charge) => charge.provider === provider && charge.providerChargeId === providerChargeId),
    );
  }

  async findPending({ limit, after }: { limit: number; after?: PendingCursor }): Promise<Charge[]> {
    return [...this.#charges.values()]
      .filter((charge) => charge.status === 'pending' && (!after || comesAfter(charge, after)))
      .sort((a, b) => (comesAfter(a, b) ? 1 : comesAfter(b, a) ? -1 : 0))
      .slice(0, limit)
      .map((charge) => structuredClone(charge));
  }

  #find(predicate: (charge: Charge) => boolean): Charge | undefined {
    return [...this.#charges.values()].find(predicate);
  }

  #copy(charge: Charge | undefined): Charge | undefined {
    return charge && structuredClone(charge);
  }
}

/** Ordem das cobranças em aberto: data de criação e, no empate, o id. */
function comesAfter(charge: PendingCursor, cursor: PendingCursor): boolean {
  return (
    charge.createdAt > cursor.createdAt ||
    (charge.createdAt === cursor.createdAt && charge.id > cursor.id)
  );
}

export class InMemoryWebhookInbox implements WebhookInbox {
  readonly #webhooks: ReceivedWebhook[] = [];

  async save(webhook: ReceivedWebhook): Promise<void> {
    this.#webhooks.push({ ...webhook });
  }

  async recent(limit: number): Promise<ReceivedWebhook[]> {
    return [...this.#webhooks]
      .reverse()
      .slice(0, limit)
      .map((webhook) => ({ ...webhook }));
  }
}
