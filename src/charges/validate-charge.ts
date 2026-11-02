import { missingAddressFields } from '../documents/address.js';
import { isValidTaxId } from '../documents/tax-id.js';
import { isRealDate } from '../shared/dates.js';
import { isFilled } from '../shared/text.js';
import type { ChargeIssue } from './errors.js';
import type { CreateChargeInput } from './types.js';

/**
 * Confere os dados da cobrança que não são da divisão. O valor e a regra de
 * divisão são conferidos pelo motor de divisão. `today` é a data de hoje
 * (AAAA-MM-DD) no fuso do DocPay.
 */
export function validateChargeFields(input: CreateChargeInput, today: string): ChargeIssue[] {
  const issues: ChargeIssue[] = [];

  if (!isFilled(input.idempotencyKey)) {
    issues.push({
      code: 'MISSING_IDEMPOTENCY_KEY',
      path: 'idempotencyKey',
      message: 'Informe a chave de idempotência da cobrança.',
    });
  }
  if (input.reference !== undefined && !isFilled(input.reference)) {
    issues.push({
      code: 'INVALID_REFERENCE',
      path: 'reference',
      message: 'A referência da cobrança, quando informada, não pode ficar vazia.',
    });
  }
  if (input.method !== 'boleto' && input.method !== 'pix') {
    issues.push({
      code: 'INVALID_METHOD',
      path: 'method',
      message: `Meio de pagamento inválido (${String(input.method)}). Use "boleto" ou "pix".`,
    });
  }
  if (!isRealDate(input.dueDate)) {
    issues.push({
      code: 'INVALID_DUE_DATE',
      path: 'dueDate',
      message: `Vencimento inválido (${String(input.dueDate)}). Use uma data real no formato AAAA-MM-DD.`,
    });
  } else if (input.dueDate < today) {
    issues.push({
      code: 'PAST_DUE_DATE',
      path: 'dueDate',
      message: `O vencimento (${input.dueDate}) já passou. Use a data de hoje ou uma data futura.`,
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
  if (input.method === 'boleto') {
    for (const { field, label } of missingAddressFields(input.payer?.address)) {
      issues.push({
        code: 'MISSING_PAYER_ADDRESS',
        path: `payer.address.${field}`,
        message: `No boleto, o endereço do pagador precisa estar completo: falta ${label}.`,
      });
    }
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
