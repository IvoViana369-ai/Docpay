import { formatBRL } from '../money/cents.js';
import { isFilled } from '../shared/text.js';
import type { LedgerIssue } from './errors.js';
import type { NewLedgerTransaction } from './types.js';

/** Confere um lançamento antes de gravar. Lista vazia significa lançamento válido. */
export function validateTransaction(transaction: NewLedgerTransaction): LedgerIssue[] {
  const { idempotencyKey, description, entries } = transaction;
  const issues: LedgerIssue[] = [];

  if (!isFilled(idempotencyKey)) {
    issues.push({
      code: 'MISSING_IDEMPOTENCY_KEY',
      path: 'idempotencyKey',
      message: 'Informe a chave de idempotência do lançamento.',
    });
  }
  if (!isFilled(description)) {
    issues.push({
      code: 'MISSING_DESCRIPTION',
      path: 'description',
      message: 'Informe a descrição do lançamento.',
    });
  }
  if (entries.length < 2) {
    issues.push({
      code: 'TOO_FEW_ENTRIES',
      path: 'entries',
      message: 'Um lançamento precisa de pelo menos duas partidas.',
    });
  }

  const accounts = new Set<string>();
  let allAccountsFilled = true;
  let allAmountsValid = true;
  // Soma em BigInt: somados como número comum, valores altos podem dar zero por arredondamento.
  let total = 0n;

  entries.forEach(({ account, amountCents }, index) => {
    const label = `Partida ${index + 1}`;
    if (isFilled(account)) {
      accounts.add(account);
    } else {
      allAccountsFilled = false;
      issues.push({
        code: 'MISSING_ACCOUNT',
        path: `entries[${index}].account`,
        message: `${label}: informe a conta.`,
      });
    }
    if (Number.isSafeInteger(amountCents) && amountCents !== 0) {
      total += BigInt(amountCents);
    } else {
      allAmountsValid = false;
      issues.push({
        code: 'INVALID_AMOUNT',
        path: `entries[${index}].amountCents`,
        message: `${label}: valor inválido (${String(amountCents)}). Use centavos inteiros diferentes de zero.`,
      });
    }
  });

  if (entries.length >= 2 && allAccountsFilled && accounts.size < 2) {
    issues.push({
      code: 'SINGLE_ACCOUNT',
      path: 'entries',
      message: 'As partidas precisam movimentar pelo menos duas contas.',
    });
  }
  if (allAmountsValid && total !== 0n) {
    issues.push({
      code: 'UNBALANCED',
      path: 'entries',
      message: `As partidas somam ${formatBRL(total)}, mas um lançamento precisa somar zero.`,
    });
  }

  return issues;
}
