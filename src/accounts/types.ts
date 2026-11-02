import type { AccountId } from '../split/types.js';

/**
 * Conta que recebe dinheiro: o beneficiário de uma cobrança ou um
 * destinatário da divisão. No parceiro, é uma subconta.
 */
export interface Account {
  id: AccountId;
  /** Nome para mostrar e para a linha da divisão no parceiro (ex.: o nome do contador). */
  name: string;
  /** Identificação da conta em cada parceiro, como { safe2pay: '123456' } (o Id Receiver da subconta). */
  providerRefs: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** O que o sistema cliente manda para criar ou atualizar uma conta. */
export interface AccountInput {
  id: AccountId;
  name: string;
  providerRefs?: Record<string, string>;
}

/** Leitura das contas, usada pelos adaptadores dos parceiros. */
export interface AccountDirectory {
  /** As contas pedidas que existem, pelo id. */
  getMany(ids: readonly AccountId[]): Promise<Map<AccountId, Account>>;
}

export interface AccountRepository extends AccountDirectory {
  /** Cria a conta ou atualiza o nome e as identificações. A data de criação não muda. */
  upsert(input: Required<AccountInput>, now: string): Promise<Account>;
  get(id: AccountId): Promise<Account | undefined>;
}
