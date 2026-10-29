export type SplitIssueCode =
  // Problemas da regra (validateSplitRule)
  | 'MISSING_BENEFICIARY'
  | 'MISSING_ACCOUNT'
  | 'BENEFICIARY_AS_RECIPIENT'
  | 'DUPLICATE_ACCOUNT'
  | 'INVALID_PERCENT'
  | 'INVALID_FIXED'
  | 'EMPTY_SHARE'
  | 'PERCENT_OVER_100'
  | 'INVALID_FEE_POLICY'
  | 'UNKNOWN_FEE_PAYER'
  // Problemas do cálculo (calculateSplit)
  | 'INVALID_AMOUNT'
  | 'INVALID_FEE'
  | 'FEE_EXCEEDS_AMOUNT'
  | 'SPLIT_EXCEEDS_AMOUNT'
  | 'FEE_EXCEEDS_SHARE';

export interface SplitIssue {
  code: SplitIssueCode;
  /** Explicação em português, pronta para mostrar a quem configurou a regra. */
  message: string;
  /** Campo com problema, por exemplo "recipients[1].percentBps". */
  path?: string;
}

/** Divisão recusada. Traz todos os problemas encontrados, não só o primeiro. */
export class SplitError extends Error {
  override readonly name = 'SplitError';
  readonly issues: readonly SplitIssue[];

  constructor(issues: readonly SplitIssue[]) {
    super(issues.map((issue) => issue.message).join(' '));
    this.issues = issues;
  }
}
