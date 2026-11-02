export type ProviderErrorCode =
  /** O parceiro recusou o pedido (dados inválidos, conta não encontrada...). Tentar de novo igual não adianta. */
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CHARGE_NOT_FOUND'
  | 'ALREADY_PAID'
  | 'INVALID_WEBHOOK'
  /** Aviso com a chave errada: não veio do parceiro. */
  | 'UNAUTHORIZED_WEBHOOK'
  /** Não deu para falar com o parceiro (rede, fora do ar). Dá para tentar de novo. */
  | 'UNAVAILABLE';

/** Erro devolvido por um parceiro, já traduzido para os códigos do DocPay. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly provider: string;
  readonly code: ProviderErrorCode;
  /** Código da recusa no parceiro, quando há (ex.: "207" na Safe2Pay). */
  readonly providerCode: string | undefined;

  constructor(provider: string, code: ProviderErrorCode, message: string, providerCode?: string) {
    super(message);
    this.provider = provider;
    this.code = code;
    this.providerCode = providerCode;
  }
}
