import { beforeEach, describe, expect, it } from 'vitest';
import { InMemoryAccountRepository } from '../../accounts/repositories.js';
import { ChargeService } from '../../charges/charge-service.js';
import { InMemoryChargeClaims } from '../../charges/claims.js';
import { InMemoryChargeRepository, InMemoryWebhookInbox } from '../../charges/repositories.js';
import { PROVIDER_FEES, ledgerAccountFor } from '../../ledger/accounts.js';
import { InMemoryLedger } from '../../ledger/in-memory-ledger.js';
import { ProviderError } from '../errors.js';
import type { ProviderChargeRef, ProviderChargeRequest } from '../types.js';
import { parseFee } from './fees.js';
import {
  API_URL,
  PAYMENT_URL,
  Safe2PayProvider,
  parseSafe2PayDate,
  pixSeconds,
  reais,
  transactionIds,
  type Safe2PayOptions,
} from './safe2pay-provider.js';

// As respostas abaixo seguem o formato que o DocLine já validou em produção
// com a Safe2Pay (HasError, ErrorCode, ResponseDetail com IdTransaction...).

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Safe2Pay de mentira: devolve as respostas da fila, na ordem, e guarda as chamadas. */
function fakeSafe2Pay(...answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const answer = answers.shift();
    if (!answer) throw new Error('O teste não preparou resposta para esta chamada.');
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { fetch: fetchFake, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const NOW = new Date('2026-11-02T12:00:00.000Z'); // 09:00 em Fortaleza

const boleto: ProviderChargeRequest = {
  idempotencyKey: 'docline-venda-13',
  reference: 'DOCLINE-13',
  beneficiary: 'docline',
  method: 'boleto',
  amountCents: 13_500,
  dueDate: '2026-11-10',
  payer: {
    name: 'Maria Silva',
    document: '529.982.247-25',
    email: 'maria@example.com',
    phone: '(85) 99999-0000',
    address: { zipCode: '60160-230', street: 'Rua Silva Paulet', district: 'Meireles', city: 'Fortaleza', state: 'ce' },
  },
  transfers: [{ account: 'docline:parceiro:42', amountCents: 4_050 }],
  description: 'Certificado digital A1 · venda nº 13',
};

const ref: ProviderChargeRef = {
  id: '177277404',
  method: 'boleto',
  amountCents: 13_500,
  transfers: [{ account: 'docline:parceiro:42', amountCents: 4_050 }],
};

describe('Safe2PayProvider', () => {
  let accounts: InMemoryAccountRepository;

  beforeEach(async () => {
    accounts = new InMemoryAccountRepository();
    const at = NOW.toISOString();
    await accounts.upsert({ id: 'docline', name: 'Docline', providerRefs: {} }, at);
    await accounts.upsert({ id: 'docline:parceiro:42', name: 'Contabilidade Silva', providerRefs: { safe2pay: '123456' } }, at);
    await accounts.upsert({ id: 'sem-subconta', name: 'Sem Subconta', providerRefs: {} }, at);
    await accounts.upsert({ id: 'subconta-errada', name: 'Subconta Errada', providerRefs: { safe2pay: 'ABC' } }, at);
  });

  function provider(fetchFake: typeof fetch, options: Partial<Safe2PayOptions> = {}): Safe2PayProvider {
    return new Safe2PayProvider({
      apiKey: 'chave-de-teste',
      sandbox: false,
      mainAccount: 'docline',
      publicBaseUrl: 'https://docpay.example.com/',
      fees: { boleto: parseFee('100'), pix: parseFee('0,99%') },
      accounts,
      fetch: fetchFake,
      now: () => NOW,
      ...options,
    });
  }

  async function failure(promise: Promise<unknown>): Promise<ProviderError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof ProviderError) return error;
      throw error;
    }
    throw new Error('Esperava que a Safe2Pay recusasse, mas o pedido foi aceito.');
  }

  describe('criação', () => {
    it('gera o boleto com a divisão no formato do suporte da Safe2Pay', async () => {
      const safe2pay = fakeSafe2Pay(
        json({
          HasError: false,
          ResponseDetail: {
            IdTransaction: 177277404,
            Status: 1,
            BankSlipUrl: 'https://s2p.example/b.pdf',
            DigitableLine: '00190.00009 01234.567891',
          },
        }),
      );
      const s2p = provider(safe2pay.fetch);

      const charge = await s2p.createCharge(boleto);

      expect(charge).toEqual({
        id: '177277404',
        status: 'pending',
        providerStatus: { code: '1', label: 'Pendente' },
        paymentUrl: 'https://s2p.example/b.pdf',
        digitableLine: '00190.00009 01234.567891',
      });
      expect(safe2pay.calls).toHaveLength(1);
      const [call] = safe2pay.calls;
      expect(call?.url).toBe(PAYMENT_URL);
      expect(call?.method).toBe('POST');
      expect(call?.headers['x-api-key']).toBe('chave-de-teste');
      expect(call?.body).toEqual({
        IsSandbox: false,
        Application: 'DocPay',
        Vendor: 'Docline',
        CallbackUrl: s2p.webhookUrl,
        Reference: 'DOCLINE-13',
        PaymentMethod: '1',
        PaymentObject: {
          DueDate: '10/11/2026',
          Instruction: 'Certificado digital A1 · venda nº 13',
          IsEnablePartialPayment: false,
        },
        Customer: {
          Name: 'Maria Silva',
          Identity: '52998224725',
          Email: 'maria@example.com',
          Phone: '85999990000',
          Address: {
            ZipCode: '60160230',
            Street: 'Rua Silva Paulet',
            Number: 'S/N',
            Complement: '',
            District: 'Meireles',
            CityName: 'Fortaleza',
            StateInitials: 'CE',
            CountryName: 'Brasil',
          },
        },
        Products: [
          { Code: 'DOCLINE-13', Description: 'Certificado digital A1 · venda nº 13', UnitPrice: 135, Quantity: 1 },
        ],
        Splits: [{ CodeTaxType: 2, IdReceiver: 123456, Name: 'Contabilidade Silva', IsPayTax: false, Amount: 40.5 }],
      });
    });

    it('gera o Pix válido até o fim do dia do vencimento, com o QR e o copia e cola', async () => {
      const safe2pay = fakeSafe2Pay(
        json({
          HasError: false,
          ResponseDetail: [{ IdTransaction: 9, Status: '1', QrCode: 'https://s2p.example/qr.png', Key: '00020126pix' }],
        }),
      );
      const { address: _address, ...payer } = boleto.payer;

      const charge = await provider(safe2pay.fetch).createCharge({ ...boleto, method: 'pix', dueDate: '2026-11-02', payer });

      expect(charge).toEqual({
        id: '9',
        status: 'pending',
        providerStatus: { code: '1', label: 'Pendente' },
        pixQrCodeImage: 'https://s2p.example/qr.png',
        pixCopyPaste: '00020126pix',
      });
      const body = safe2pay.calls[0]?.body as Record<string, unknown>;
      expect(body.PaymentMethod).toBe('6');
      // Das 09:00 às 23:59:59 do mesmo dia, no horário de Brasília.
      expect(body.PaymentObject).toEqual({ Expiration: 53_999 });
      expect((body.Customer as Record<string, unknown>).Address).toBeUndefined();
    });

    it('sem repasses, a cobrança vai inteira para a conta principal', async () => {
      const safe2pay = fakeSafe2Pay(json({ HasError: false, ResponseDetail: { IdTransaction: 10, Status: 1 } }));
      await provider(safe2pay.fetch).createCharge({ ...boleto, transfers: [] });

      expect((safe2pay.calls[0]?.body as Record<string, unknown>).Splits).toEqual([]);
    });

    it('no ambiente de teste, marca IsSandbox e não tenta gerar Pix', async () => {
      const safe2pay = fakeSafe2Pay(json({ HasError: false, ResponseDetail: { IdTransaction: 11, Status: 1 } }));
      const s2p = provider(safe2pay.fetch, { sandbox: true });

      await s2p.createCharge(boleto);
      expect((safe2pay.calls[0]?.body as Record<string, unknown>).IsSandbox).toBe(true);

      const error = await failure(s2p.createCharge({ ...boleto, method: 'pix' }));
      expect(error).toMatchObject({ code: 'INVALID_REQUEST', providerCode: '301' });
      expect(safe2pay.calls).toHaveLength(1);
    });

    it('recusa, sem chamar a Safe2Pay, cobrança de outra conta, boleto sem endereço e subconta faltando', async () => {
      const safe2pay = fakeSafe2Pay();
      const s2p = provider(safe2pay.fetch);

      expect((await failure(s2p.createCharge({ ...boleto, beneficiary: 'outra' }))).message).toBe(
        'A chave da Safe2Pay configurada só emite cobranças da conta docline, não de outra.',
      );
      const noAddress = { ...boleto, payer: { ...boleto.payer, address: { ...boleto.payer.address!, district: '' } } };
      expect(await failure(s2p.createCharge(noAddress))).toMatchObject({ code: 'INVALID_REQUEST', providerCode: '022' });
      expect(
        (await failure(s2p.createCharge({ ...boleto, transfers: [{ account: 'sem-subconta', amountCents: 100 }] }))).message,
      ).toBe('A conta sem-subconta não tem a subconta da Safe2Pay (Id Receiver) no cadastro de contas do DocPay.');
      expect(
        (await failure(s2p.createCharge({ ...boleto, transfers: [{ account: 'nao-cadastrada', amountCents: 100 }] }))).code,
      ).toBe('INVALID_REQUEST');
      expect(
        (await failure(s2p.createCharge({ ...boleto, transfers: [{ account: 'subconta-errada', amountCents: 100 }] }))).message,
      ).toBe('O Id Receiver da conta subconta-errada precisa ter só números (está "ABC").');
      expect(safe2pay.calls).toHaveLength(0);
    });

    it('traduz a recusa da Safe2Pay (que chega com HTTP 200) e acrescenta a dica', async () => {
      const safe2pay = fakeSafe2Pay(
        json({ HasError: true, Error: 'Recebedor informado não foi localizado', ErrorCode: '207' }),
      );

      const error = await failure(provider(safe2pay.fetch).createCharge(boleto));
      expect(error).toMatchObject({ code: 'INVALID_REQUEST', providerCode: '207', provider: 'safe2pay' });
      expect(error.message).toBe(
        'A Safe2Pay recusou: Recebedor informado não foi localizado (código 207) A Safe2Pay não achou a subconta. Confira o Id Receiver; se estiver certo, a subconta não está ligada ao Marketplace da conta principal.',
      );
    });

    it('sem resposta da Safe2Pay, pede para conferir o painel antes de tentar de novo', async () => {
      const network = fakeSafe2Pay(new TypeError('fetch failed'));
      const error = await failure(provider(network.fetch).createCharge(boleto));
      expect(error.code).toBe('UNAVAILABLE');
      expect(error.message).toBe(
        'Não consegui falar com a Safe2Pay agora. Antes de tentar de novo, confira no painel da Safe2Pay se a cobrança DOCLINE-13 não foi criada.',
      );

      const html = fakeSafe2Pay(new Response('<html>erro</html>', { status: 502 }));
      expect((await failure(provider(html.fetch).createCharge(boleto))).message).toContain(
        'A Safe2Pay respondeu HTTP 502 sem detalhes.',
      );

      const http500 = fakeSafe2Pay(json({ Message: 'erro interno' }, 500));
      expect((await failure(provider(http500.fetch).createCharge(boleto))).code).toBe('UNAVAILABLE');

      const withoutId = fakeSafe2Pay(json({ HasError: false, ResponseDetail: { Status: 1 } }));
      expect((await failure(provider(withoutId.fetch).createCharge(boleto))).message).toContain(
        'A Safe2Pay não devolveu o número da transação.',
      );
    });
  });

  describe('consulta', () => {
    it('cobrança paga traz o pagamento, com a tarifa do contrato e os repasses pedidos', async () => {
      const safe2pay = fakeSafe2Pay(
        json({ HasError: false, ResponseDetail: { IdTransaction: 177277404, Status: 3, PaymentDate: '2026-11-05T10:00:00' } }),
      );

      const charge = await provider(safe2pay.fetch).getCharge(ref);

      expect(safe2pay.calls[0]?.url).toBe(`${API_URL}/transaction/Get?Id=177277404`);
      expect(safe2pay.calls[0]?.method).toBe('GET');
      expect(charge).toEqual({
        id: '177277404',
        status: 'paid',
        providerStatus: { code: '3', label: 'Autorizado' },
        payment: {
          paidAt: '2026-11-05T13:00:00.000Z',
          method: 'boleto',
          paidAmountCents: 13_500,
          feeCents: 100,
          transfers: [{ account: 'docline:parceiro:42', amountCents: 4_050 }],
        },
      });
    });

    it('no Pix, a tarifa é o percentual do contrato', async () => {
      const safe2pay = fakeSafe2Pay(json({ HasError: false, ResponseDetail: { Status: 11 } }));
      const charge = await provider(safe2pay.fetch).getCharge({ ...ref, method: 'pix' });

      expect(charge.payment?.feeCents).toBe(133);
      // Sem a data do pagamento na resposta, vale a hora da consulta.
      expect(charge.payment?.paidAt).toBe(NOW.toISOString());
    });

    it('traduz cada status da Safe2Pay', async () => {
      const cases: [unknown, string, string][] = [
        [1, 'pending', 'Pendente'],
        [2, 'pending', 'Processamento'],
        [4, 'paid', 'Disponível'],
        [11, 'paid', 'Liberado'],
        [7, 'expired', 'Baixado'],
        [8, 'failed', 'Recusado'],
        [12, 'canceled', 'Em cancelamento'],
        [5, 'pending', 'Em disputa'],
        [99, 'pending', 'status 99'],
        [{ Code: '3' }, 'paid', 'Autorizado'],
      ];
      for (const [status, expected, label] of cases) {
        const safe2pay = fakeSafe2Pay(json({ HasError: false, ResponseDetail: { Status: status } }));
        const charge = await provider(safe2pay.fetch).getCharge(ref);
        expect([charge.status, charge.providerStatus.label], JSON.stringify(status)).toEqual([expected, label]);
      }
    });

    it('sem status na resposta, a consulta falha para tentar de novo depois', async () => {
      const safe2pay = fakeSafe2Pay(json({ HasError: false, ResponseDetail: {} }));
      expect((await failure(provider(safe2pay.fetch).getCharge(ref))).code).toBe('UNAVAILABLE');
    });
  });

  describe('aviso', () => {
    it('aceita só o aviso com a chave do endereço e tira os números de transação de qualquer nível', () => {
      const s2p = provider(fakeSafe2Pay().fetch);
      const key = new URL(s2p.webhookUrl).searchParams.get('k') ?? '';
      expect(s2p.webhookUrl).toMatch(/^https:\/\/docpay\.example\.com\/v1\/providers\/safe2pay\/webhook\?k=[0-9a-f]{32}$/);

      const body = JSON.stringify({ IdTransaction: 5, Itens: [{ TransactionId: '6' }], Outro: { IdTransaction: 'x' } });
      expect(s2p.parseWebhook({ body, query: { k: key } })).toEqual({ chargeIds: ['5', '6'] });
      expect(s2p.parseWebhook({ body: 'não é json', query: { k: key } })).toEqual({ chargeIds: [] });

      for (const k of [undefined, '', 'errada', `${key}x`]) {
        expect(() => s2p.parseWebhook({ body, query: { k } })).toThrow(ProviderError);
      }
    });

    it('a chave muda quando a chave da API muda', () => {
      const first = provider(fakeSafe2Pay().fetch).webhookUrl;
      const second = provider(fakeSafe2Pay().fetch, { apiKey: 'outra-chave' }).webhookUrl;
      expect(second).not.toBe(first);
    });
  });
});

describe('Safe2Pay de ponta a ponta com o ChargeService', () => {
  it('emite, recebe o aviso, consulta e lança a baixa com a tarifa do contrato', async () => {
    const accounts = new InMemoryAccountRepository();
    await accounts.upsert({ id: 'docline', name: 'Docline', providerRefs: {} }, NOW.toISOString());
    await accounts.upsert(
      { id: 'docline:parceiro:42', name: 'Contabilidade Silva', providerRefs: { safe2pay: '123456' } },
      NOW.toISOString(),
    );
    const safe2pay = fakeSafe2Pay(
      json({ HasError: false, ResponseDetail: { IdTransaction: 177277404, Status: 1, BankSlipUrl: 'https://s2p.example/b.pdf' } }),
      json({ HasError: false, ResponseDetail: { IdTransaction: 177277404, Status: 3, PaymentDate: '2026-11-05T10:00:00' } }),
    );
    const s2p = new Safe2PayProvider({
      apiKey: 'chave-de-teste',
      sandbox: false,
      mainAccount: 'docline',
      publicBaseUrl: 'https://docpay.example.com',
      fees: { boleto: parseFee('100'), pix: parseFee('0,99%') },
      accounts,
      fetch: safe2pay.fetch,
      now: () => NOW,
    });
    const ledger = new InMemoryLedger({ now: () => NOW });
    const service = new ChargeService({
      provider: s2p,
      ledger,
      charges: new InMemoryChargeRepository(),
      claims: new InMemoryChargeClaims(),
      webhooks: new InMemoryWebhookInbox(),
      now: () => NOW,
    });

    const charge = await service.create({
      idempotencyKey: 'docline-venda-13',
      reference: 'DOCLINE-13',
      method: 'boleto',
      amountCents: 13_500,
      dueDate: '2026-11-10',
      payer: boleto.payer,
      rule: { beneficiary: 'docline', recipients: [{ account: 'docline:parceiro:42', percentBps: 3_000 }] },
    });
    expect(charge).toMatchObject({ provider: 'safe2pay', providerChargeId: '177277404', paymentUrl: 'https://s2p.example/b.pdf' });

    const key = new URL(s2p.webhookUrl).searchParams.get('k') ?? '';
    const outcomes = await service.handleWebhook({ body: JSON.stringify({ IdTransaction: 177277404 }), query: { k: key } });
    expect(outcomes).toEqual([{ providerChargeId: '177277404', status: 'settled', chargeId: charge.id }]);

    // 30% de R$ 135,00 = R$ 40,50 para o parceiro; R$ 1,00 de tarifa sai da Docline.
    expect(await ledger.balance(ledgerAccountFor('docline:parceiro:42'))).toBe(4_050);
    expect(await ledger.balance(ledgerAccountFor('docline'))).toBe(13_500 - 4_050 - 100);
    expect(await ledger.balance(PROVIDER_FEES)).toBe(100);
    expect(await service.get(charge.id)).toMatchObject({
      status: 'paid',
      providerStatus: { code: '3', label: 'Autorizado' },
      payment: { paidAt: '2026-11-05T13:00:00.000Z', feeCents: 100 },
      divergences: [],
    });
  });
});

describe('ajudantes da Safe2Pay', () => {
  it('transactionIds não repete números e ignora o que não é número', () => {
    expect(transactionIds({ IdTransaction: '7', Lista: [{ IdTransaction: 7 }, { TransactionID: '8' }] })).toEqual(['7', '8']);
    expect(transactionIds([1, 2, 3])).toEqual([]);
  });

  it('parseSafe2PayDate lê os dois formatos no horário de Brasília', () => {
    expect(parseSafe2PayDate('2026-11-05T10:00:00', 'America/Sao_Paulo')).toBe('2026-11-05T13:00:00.000Z');
    expect(parseSafe2PayDate('05/11/2026 10:00:00', 'America/Sao_Paulo')).toBe('2026-11-05T13:00:00.000Z');
    expect(parseSafe2PayDate('2026-11-05', 'America/Sao_Paulo')).toBe('2026-11-05T03:00:00.000Z');
    expect(parseSafe2PayDate('', 'America/Sao_Paulo')).toBeUndefined();
    expect(parseSafe2PayDate(undefined, 'America/Sao_Paulo')).toBeUndefined();
  });

  it('pixSeconds fica entre 1 hora e 30 dias', () => {
    expect(pixSeconds('2026-11-02', new Date('2026-11-03T02:30:00Z'), 'America/Sao_Paulo')).toBe(3600);
    expect(pixSeconds('2027-02-01', NOW, 'America/Sao_Paulo')).toBe(30 * 24 * 3600);
  });

  it('reais converte centavos sem sobra de arredondamento', () => {
    expect([reais(13_500), reais(4_050), reais(7), reais(1)]).toEqual([135, 40.5, 0.07, 0.01]);
    expect(JSON.stringify({ Amount: reais(4_050) })).toBe('{"Amount":40.5}');
  });
});
