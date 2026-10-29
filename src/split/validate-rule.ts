import {
  formatPercent,
  isBasisPoints,
  isCents,
  ONE_HUNDRED_PERCENT,
} from '../money/cents.js';
import { isFilled } from '../shared/text.js';
import type { SplitIssue } from './errors.js';
import type { AccountId, SplitRule } from './types.js';

/**
 * Confere uma regra de divisão sem depender do valor da cobrança. Use ao
 * salvar uma regra, para mostrar todos os problemas de uma vez.
 * Lista vazia significa regra válida.
 */
export function validateSplitRule(rule: SplitRule): SplitIssue[] {
  const issues: SplitIssue[] = [];

  if (!isFilled(rule.beneficiary)) {
    issues.push({
      code: 'MISSING_BENEFICIARY',
      path: 'beneficiary',
      message: 'Informe a conta beneficiária.',
    });
  }

  const recipientAccounts = new Set<AccountId>();
  let totalPercent = 0;

  rule.recipients.forEach(({ account, percentBps, fixedCents }, index) => {
    const path = `recipients[${index}]`;
    const label = `Destinatário ${index + 1}`;

    if (!isFilled(account)) {
      issues.push({
        code: 'MISSING_ACCOUNT',
        path: `${path}.account`,
        message: `${label}: informe a conta.`,
      });
    } else if (account === rule.beneficiary) {
      issues.push({
        code: 'BENEFICIARY_AS_RECIPIENT',
        path: `${path}.account`,
        message: `${label}: a conta ${account} já é a beneficiária e fica com o restante; não a repita como destinatário.`,
      });
    } else if (recipientAccounts.has(account)) {
      issues.push({
        code: 'DUPLICATE_ACCOUNT',
        path: `${path}.account`,
        message: `${label}: a conta ${account} aparece mais de uma vez.`,
      });
    } else {
      recipientAccounts.add(account);
    }

    if (percentBps !== undefined && !isBasisPoints(percentBps)) {
      issues.push({
        code: 'INVALID_PERCENT',
        path: `${path}.percentBps`,
        message: `${label}: percentual inválido (${String(percentBps)}). Use pontos-base inteiros de 0 a ${ONE_HUNDRED_PERCENT} (${ONE_HUNDRED_PERCENT} = 100%).`,
      });
    } else if (percentBps !== undefined) {
      totalPercent += percentBps;
    }

    if (fixedCents !== undefined && !isCents(fixedCents)) {
      issues.push({
        code: 'INVALID_FIXED',
        path: `${path}.fixedCents`,
        message: `${label}: valor fixo inválido (${String(fixedCents)}). Use centavos inteiros e não negativos.`,
      });
    }

    if ((percentBps ?? 0) === 0 && (fixedCents ?? 0) === 0) {
      issues.push({
        code: 'EMPTY_SHARE',
        path,
        message: `${label}: informe um percentual ou um valor fixo maior que zero.`,
      });
    }
  });

  if (totalPercent > ONE_HUNDRED_PERCENT) {
    issues.push({
      code: 'PERCENT_OVER_100',
      path: 'recipients',
      message: `Os percentuais dos destinatários somam ${formatPercent(totalPercent)}, mais que 100%.`,
    });
  }

  const { feePolicy } = rule;
  if (feePolicy?.kind === 'single') {
    if (feePolicy.payer !== rule.beneficiary && !recipientAccounts.has(feePolicy.payer)) {
      issues.push({
        code: 'UNKNOWN_FEE_PAYER',
        path: 'feePolicy.payer',
        message: `A conta ${String(feePolicy.payer)}, indicada para pagar a tarifa, não participa da divisão.`,
      });
    }
  } else if (feePolicy !== undefined && feePolicy.kind !== 'proportional') {
    issues.push({
      code: 'INVALID_FEE_POLICY',
      path: 'feePolicy',
      message: 'Política de tarifa inválida. Use "single" com a conta que paga, ou "proportional".',
    });
  }

  return issues;
}
