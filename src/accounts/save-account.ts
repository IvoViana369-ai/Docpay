import { isFilled } from '../shared/text.js';
import type { Account, AccountInput, AccountRepository } from './types.js';

/** Ids de conta: letras, números e . _ : - (até 100). Viram parte das contas do razão. */
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,100}$/;

export interface AccountIssue {
  code: 'INVALID_ACCOUNT_ID' | 'MISSING_ACCOUNT_NAME' | 'INVALID_PROVIDER_REF';
  message: string;
  path: string;
}

export class AccountError extends Error {
  override readonly name = 'AccountError';
  readonly code = 'INVALID_ACCOUNT';
  readonly issues: readonly AccountIssue[];

  constructor(issues: readonly AccountIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.issues = issues;
  }
}

export function validateAccountInput(input: AccountInput): AccountIssue[] {
  const issues: AccountIssue[] = [];
  if (typeof input.id !== 'string' || !ACCOUNT_ID.test(input.id)) {
    issues.push({
      code: 'INVALID_ACCOUNT_ID',
      path: 'id',
      message: `Id de conta inválido (${String(input.id)}). Use letras, números e . _ : - (até 100).`,
    });
  }
  if (!isFilled(input.name)) {
    issues.push({ code: 'MISSING_ACCOUNT_NAME', path: 'name', message: 'Informe o nome da conta.' });
  }
  for (const [provider, ref] of Object.entries(input.providerRefs ?? {})) {
    if (!isFilled(ref)) {
      issues.push({
        code: 'INVALID_PROVIDER_REF',
        path: `providerRefs.${provider}`,
        message: `Informe a identificação da conta no parceiro ${provider}, ou tire o campo.`,
      });
    }
  }
  return issues;
}

/** Confere e grava a conta. Lança AccountError com todos os problemas. */
export async function saveAccount(
  repository: AccountRepository,
  input: AccountInput,
  now: Date,
): Promise<Account> {
  const issues = validateAccountInput(input);
  if (issues.length > 0) throw new AccountError(issues);

  const providerRefs = Object.fromEntries(
    Object.entries(input.providerRefs ?? {}).map(([provider, ref]) => [provider, ref.trim()]),
  );
  return repository.upsert({ id: input.id, name: input.name.trim(), providerRefs }, now.toISOString());
}
