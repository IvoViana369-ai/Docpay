import { isValidTaxId } from '../documents/tax-id.js';
import { isFilled } from '../shared/text.js';
import type { ChargeIssue } from './errors.js';
import type { CreateChargeInput } from './types.js';

/**
 * Confere os dados da cobrança que não são da divisão. O valor e a regra de
 * divisão são conferidos pelo motor de divisão.
 */
export function validateChargeFields(input: CreateChargeInput): ChargeIssue[] {
  const issues: ChargeIssue[] = [];

  if (!isFilled(input.idempotencyKey)) {
    issues.push({
      code: 'MISSING_IDEMPOTENCY_KEY',
      path: 'idempotencyKey',
      message: 'Informe a chave de idempotência da cobrança.',
    });
  }
  if (!isRealDate(input.dueDate)) {
    issues.push({
      code: 'INVALID_DUE_DATE',
      path: 'dueDate',
      message: `Vencimento inválido (${String(input.dueDate)}). Use uma data real no formato AAAA-MM-DD.`,
    });
  }
  if (!isFilled(input.payer?.name)) {
    issues.push({
      code: 'MISSING_PAYER_NAME',
      path: 'payer.name',
      message: 'Informe o nome do pagador.',
    });
  }
  if (typeof input.payer?.document !== 'string' || !isValidTaxId(input.payer.document)) {
    issues.push({
      code: 'INVALID_PAYER_DOCUMENT',
      path: 'payer.document',
      message: 'CPF ou CNPJ do pagador inválido.',
    });
  }

  const { beneficiary, feePolicy } = input.rule;
  if (
    feePolicy?.kind === 'proportional' ||
    (feePolicy?.kind === 'single' && feePolicy.payer !== beneficiary)
  ) {
    issues.push({
      code: 'UNSUPPORTED_FEE_POLICY',
      path: 'rule.feePolicy',
      message:
        'Por enquanto, a tarifa do parceiro é sempre paga pelo beneficiário. Dividir a tarifa ou cobrá-la de um destinatário depende de um recurso do parceiro que ainda não temos.',
    });
  }

  return issues;
}

function isRealDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}
