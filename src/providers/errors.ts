export type ProviderErrorCode =
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CHARGE_NOT_FOUND'
  | 'ALREADY_PAID'
  | 'INVALID_WEBHOOK';

/** Erro devolvido por um parceiro, já traduzido para os códigos do DocPay. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly provider: string;
  readonly code: ProviderErrorCode;

  constructor(provider: string, code: ProviderErrorCode, message: string) {
    super(message);
    this.provider = provider;
    this.code = code;
  }
}
