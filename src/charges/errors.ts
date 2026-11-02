import type { SplitIssueCode } from '../split/errors.js';

export type ChargeIssueCode =
  | SplitIssueCode
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'INVALID_REFERENCE'
  | 'INVALID_METHOD'
  | 'INVALID_DUE_DATE'
  | 'PAST_DUE_DATE'
  | 'MISSING_PAYER_NAME'
  | 'INVALID_PAYER_DOCUMENT'
  | 'MISSING_PAYER_ADDRESS'
  | 'UNSUPPORTED_FEE_POLICY';

export interface ChargeIssue {
  code: ChargeIssueCode;
  /** Explicação em português, pronta para mostrar a quem pediu a cobrança. */
  message: string;
  /** Campo com problema, por exemplo "rule.recipients[0].percentBps". */
  path?: string;
}

export type ChargeErrorCode =
  | 'INVALID_CHARGE'
  | 'IDEMPOTENCY_CONFLICT'
  /** Outra chamada com a mesma chave ainda está gerando a cobrança. */
  | 'IN_PROGRESS'
  | 'CHARGE_NOT_FOUND';

export class ChargeError extends Error {
  override readonly name = 'ChargeError';
  readonly code: ChargeErrorCode;
  /** Todos os problemas encontrados, quando o código é INVALID_CHARGE. */
  readonly issues: readonly ChargeIssue[];

  constructor(code: ChargeErrorCode, message: string, issues: readonly ChargeIssue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}
