export type LedgerIssueCode =
  | 'MISSING_IDEMPOTENCY_KEY'
  | 'MISSING_DESCRIPTION'
  | 'TOO_FEW_ENTRIES'
  | 'MISSING_ACCOUNT'
  | 'INVALID_AMOUNT'
  | 'SINGLE_ACCOUNT'
  | 'UNBALANCED';

export interface LedgerIssue {
  code: LedgerIssueCode;
  message: string;
  path?: string;
}

export type LedgerErrorCode = 'INVALID_TRANSACTION' | 'IDEMPOTENCY_CONFLICT' | 'TRANSACTION_NOT_FOUND';

export class LedgerError extends Error {
  override readonly name = 'LedgerError';
  readonly code: LedgerErrorCode;
  /** Problemas encontrados, quando o código é INVALID_TRANSACTION. */
  readonly issues: readonly LedgerIssue[];

  constructor(code: LedgerErrorCode, message: string, issues: readonly LedgerIssue[] = []) {
    super(message);
    this.code = code;
    this.issues = issues;
  }
}
