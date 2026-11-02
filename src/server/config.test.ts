import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const KEY = 'k'.repeat(32);
const base = { DATABASE_URL: 'postgres://u:s@localhost/docpay', DOCPAY_API_KEY: KEY };

describe('readConfig', () => {
  it('sobe com o mínimo, com o parceiro simulado e o fuso de São Paulo', () => {
    expect(readConfig(base)).toEqual({
      ok: true,
      config: {
        port: 3000,
        databaseUrl: base.DATABASE_URL,
        databaseSsl: false,
        apiKey: KEY,
        publicUrl: undefined,
        timeZone: 'America/Sao_Paulo',
        notify: undefined,
        provider: { kind: 'simulated' },
      },
    });
  });

  it('lê a Safe2Pay, com o ambiente de teste ligado por padrão', () => {
    const result = readConfig({
      ...base,
      PORT: '10000',
      DOCPAY_PUBLIC_URL: 'https://docpay.onrender.com/',
      DOCPAY_TIMEZONE: 'America/Fortaleza',
      DOCPAY_NOTIFY_URL: 'https://docline-gestao-comercial.onrender.com/api/docpay/webhook',
      DOCPAY_NOTIFY_SECRET: 's'.repeat(40),
      DOCPAY_PROVIDER: 'safe2pay',
      SAFE2PAY_API_KEY: 'token',
      SAFE2PAY_MAIN_ACCOUNT: 'docline',
      SAFE2PAY_FEE_BOLETO: '100',
      SAFE2PAY_FEE_PIX: '0,99%',
    });

    expect(result).toEqual({
      ok: true,
      config: {
        port: 10_000,
        databaseUrl: base.DATABASE_URL,
        databaseSsl: false,
        apiKey: KEY,
        publicUrl: 'https://docpay.onrender.com',
        timeZone: 'America/Fortaleza',
        notify: { url: 'https://docline-gestao-comercial.onrender.com/api/docpay/webhook', secret: 's'.repeat(40) },
        provider: {
          kind: 'safe2pay',
          apiKey: 'token',
          sandbox: true,
          mainAccount: 'docline',
          fees: { boleto: { fixedCents: 100, percentBps: 0 }, pix: { fixedCents: 0, percentBps: 99 } },
        },
      },
    });
  });

  it('lista tudo o que falta ou está errado, de uma vez', () => {
    const result = readConfig({
      DOCPAY_API_KEY: 'curta',
      PORT: 'abc',
      DOCPAY_TIMEZONE: 'Lua/Base',
      DOCPAY_NOTIFY_URL: 'http://sem-https.example',
      DOCPAY_PROVIDER: 'safe2pay',
      SAFE2PAY_SANDBOX: 'talvez',
      SAFE2PAY_FEE_BOLETO: 'R$ 1,00',
    });

    expect(result.ok).toBe(false);
    const names = !result.ok ? result.problems.map((problem) => problem.split(':')[0]) : [];
    expect(names).toEqual([
      'DATABASE_URL',
      'DOCPAY_API_KEY',
      'PORT',
      'DOCPAY_TIMEZONE',
      'DOCPAY_NOTIFY_URL',
      'DOCPAY_NOTIFY_SECRET',
      'DOCPAY_PUBLIC_URL',
      'SAFE2PAY_API_KEY',
      'SAFE2PAY_SANDBOX',
      'SAFE2PAY_MAIN_ACCOUNT',
      'SAFE2PAY_FEE_BOLETO',
      'SAFE2PAY_FEE_PIX',
    ]);
  });

  it('recusa parceiro desconhecido', () => {
    expect(readConfig({ ...base, DOCPAY_PROVIDER: 'iugu' })).toEqual({
      ok: false,
      problems: ['DOCPAY_PROVIDER: use "simulated" ou "safe2pay" (está "iugu").'],
    });
  });
});
