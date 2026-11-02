import { parseFee, type Fee } from '../providers/safe2pay/fees.js';
import { DEFAULT_TIME_ZONE } from '../shared/dates.js';

export type ProviderConfig =
  | { kind: 'simulated' }
  | {
      kind: 'safe2pay';
      apiKey: string;
      sandbox: boolean;
      mainAccount: string;
      fees: { boleto: Fee; pix: Fee };
    };

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  /** Chave que o sistema cliente (o DocLine) usa para chamar o DocPay. */
  apiKey: string;
  /** Endereço público do DocPay, para o parceiro mandar o aviso de pagamento. */
  publicUrl: string | undefined;
  timeZone: string;
  /** Para onde mandar o aviso de mudança de status (o DocLine), com o segredo combinado. */
  notify: { url: string; secret: string } | undefined;
  provider: ProviderConfig;
}

export type ConfigResult = { ok: true; config: ServerConfig } | { ok: false; problems: string[] };

/**
 * Lê a configuração das variáveis de ambiente (no Render, em Environment).
 * Devolve todos os problemas de uma vez, para o log dizer tudo o que falta.
 */
export function readConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
  const problems: string[] = [];
  const get = (name: string): string | undefined => env[name]?.trim() || undefined;
  const required = (name: string, what: string): string => {
    const value = get(name);
    if (!value) problems.push(`${name}: ${what}`);
    return value ?? '';
  };
  const flag = (name: string, fallback: boolean): boolean => {
    const value = get(name);
    if (value === undefined) return fallback;
    if (/^(1|true|sim|yes|on)$/i.test(value)) return true;
    if (/^(0|false|n[aã]o|no|off)$/i.test(value)) return false;
    problems.push(`${name}: use 1 (sim) ou 0 (não), está "${value}".`);
    return fallback;
  };
  const secret = (name: string, what: string): string => {
    const value = required(name, what);
    if (value && value.length < 32) problems.push(`${name}: use pelo menos 32 caracteres.`);
    return value;
  };

  const databaseUrl = required('DATABASE_URL', 'o endereço do banco PostgreSQL.');
  const apiKey = secret('DOCPAY_API_KEY', 'a chave que o DocLine usa para chamar o DocPay (pelo menos 32 caracteres).');

  const port = Number(get('PORT') ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) problems.push('PORT: número de porta inválido.');

  const publicUrl = get('DOCPAY_PUBLIC_URL')?.replace(/\/+$/, '');
  if (publicUrl !== undefined && !isHttpsUrl(publicUrl)) {
    problems.push('DOCPAY_PUBLIC_URL: precisa ser um endereço https://, sem parâmetros.');
  }

  const timeZone = get('DOCPAY_TIMEZONE') ?? DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    problems.push(`DOCPAY_TIMEZONE: fuso desconhecido ("${timeZone}"). Exemplo: America/Fortaleza.`);
  }

  let notify: ServerConfig['notify'];
  const notifyUrl = get('DOCPAY_NOTIFY_URL');
  if (notifyUrl !== undefined) {
    if (!isHttpsUrl(notifyUrl, { allowQuery: true })) problems.push('DOCPAY_NOTIFY_URL: precisa ser um endereço https://.');
    notify = {
      url: notifyUrl,
      secret: secret('DOCPAY_NOTIFY_SECRET', 'o segredo combinado com o sistema avisado (pelo menos 32 caracteres).'),
    };
  }

  const kind = get('DOCPAY_PROVIDER') ?? 'simulated';
  let provider: ProviderConfig = { kind: 'simulated' };
  if (kind === 'safe2pay') {
    if (publicUrl === undefined) {
      problems.push('DOCPAY_PUBLIC_URL: o endereço público do DocPay, para a Safe2Pay mandar o aviso de pagamento.');
    }
    const fee = (name: string, example: string): Fee => {
      const value = required(name, `a tarifa do contrato com a Safe2Pay (ex.: "${example}").`);
      if (!value) return { fixedCents: 0, percentBps: 0 };
      try {
        return parseFee(value);
      } catch (error) {
        problems.push(`${name}: ${(error as Error).message}`);
        return { fixedCents: 0, percentBps: 0 };
      }
    };
    provider = {
      kind: 'safe2pay',
      apiKey: required('SAFE2PAY_API_KEY', 'o token da conta principal na Safe2Pay.'),
      sandbox: flag('SAFE2PAY_SANDBOX', true),
      mainAccount: required('SAFE2PAY_MAIN_ACCOUNT', 'a conta do DocPay dona do token (ex.: docline).'),
      fees: { boleto: fee('SAFE2PAY_FEE_BOLETO', '100'), pix: fee('SAFE2PAY_FEE_PIX', '0,99%') },
    };
  } else if (kind !== 'simulated') {
    problems.push(`DOCPAY_PROVIDER: use "simulated" ou "safe2pay" (está "${kind}").`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      port,
      databaseUrl,
      databaseSsl: flag('DATABASE_SSL', false),
      apiKey,
      publicUrl,
      timeZone,
      notify,
      provider,
    },
  };
}

function isHttpsUrl(value: string, options: { allowQuery?: boolean } = {}): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && !url.hash && (options.allowQuery || !url.search);
  } catch {
    return false;
  }
}
