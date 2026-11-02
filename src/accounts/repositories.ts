import type { AccountId } from '../split/types.js';
import type { Account, AccountInput, AccountRepository } from './types.js';

/** Contas em memória. Guarda e devolve cópias, como um banco de dados faria. */
export class InMemoryAccountRepository implements AccountRepository {
  readonly #accounts = new Map<AccountId, Account>();

  async upsert(input: Required<AccountInput>, now: string): Promise<Account> {
    const previous = this.#accounts.get(input.id);
    const account: Account = {
      id: input.id,
      name: input.name,
      providerRefs: { ...input.providerRefs },
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    this.#accounts.set(account.id, account);
    return structuredClone(account);
  }

  async get(id: AccountId): Promise<Account | undefined> {
    const account = this.#accounts.get(id);
    return account && structuredClone(account);
  }

  async getMany(ids: readonly AccountId[]): Promise<Map<AccountId, Account>> {
    const found = new Map<AccountId, Account>();
    for (const id of ids) {
      const account = this.#accounts.get(id);
      if (account) found.set(id, structuredClone(account));
    }
    return found;
  }
}
