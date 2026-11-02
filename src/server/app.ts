import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { AccountError, saveAccount } from '../accounts/save-account.js';
import type { AccountRepository } from '../accounts/types.js';
import type { ChargeService } from '../charges/charge-service.js';
import { ChargeError } from '../charges/errors.js';
import type { CreateChargeInput } from '../charges/types.js';
import { ProviderError } from '../providers/errors.js';
import type { SimulatedPayment, SimulatedProvider } from '../providers/simulated-provider.js';
import type { PaymentProvider } from '../providers/types.js';
import { accountBody, createChargeBody, simulatedPaymentBody } from './schemas.js';

export interface AppDeps {
  /** Chave que o sistema cliente manda em "Authorization: Bearer <chave>". */
  apiKey: string;
  service: ChargeService;
  accounts: AccountRepository;
  provider: PaymentProvider;
  /** Só com o parceiro simulado: abre a rota que paga uma cobrança de teste. */
  simulator?: SimulatedProvider;
  /** Confere o banco no /health. */
  checkDatabase?: () => Promise<void>;
  now?: () => Date;
  logger?: boolean;
}

/**
 * A API do DocPay. Rotas:
 * - GET  /health
 * - PUT  /v1/accounts/:id e GET /v1/accounts/:id
 * - POST /v1/charges, GET /v1/charges/:id e POST /v1/charges/:id/sync
 * - POST /v1/jobs/reconcile (conciliação e avisos pendentes)
 * - POST /v1/providers/:provider/webhook (aviso do parceiro, sem a chave da API)
 * - POST /v1/simulator/charges/:providerChargeId/pay (só com o parceiro simulado)
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    bodyLimit: 256 * 1024,
    // Sem conversão de tipos nem remoção de campos: pedido errado é recusado, não "consertado".
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, allErrors: true } },
    logger: deps.logger
      ? {
          redact: ['req.headers.authorization'],
          // O endereço do aviso leva uma chave no parâmetro k: o log guarda só o caminho.
          serializers: { req: (request) => ({ method: request.method, url: request.url.split('?')[0] }) },
        }
      : false,
  });

  app.setErrorHandler((error, request, reply) => {
    const { status, body } = errorResponse(error);
    if (status >= 500) request.log.error(error);
    return reply.code(status).send(body);
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: 'NOT_FOUND', message: 'Endereço não encontrado.' }),
  );

  app.get('/health', async () => {
    await deps.checkDatabase?.();
    return { ok: true, provider: deps.provider.name };
  });

  // Aviso do parceiro: chega sem a chave da API; quem confere é o adaptador do parceiro.
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => done(null, body));

    scope.post<{ Params: { provider: string }; Querystring: Record<string, string> }>(
      '/v1/providers/:provider/webhook',
      async (request, reply) => {
        if (request.params.provider !== deps.provider.name) {
          return reply.code(404).send({ error: 'NOT_FOUND', message: 'Parceiro não configurado neste DocPay.' });
        }
        const body = typeof request.body === 'string' ? request.body : '';
        const outcomes = await deps.service.handleWebhook({ body, query: request.query });
        return { ok: true, outcomes };
      },
    );
  });

  app.register(async (api) => {
    api.addHook('onRequest', async (request, reply) => {
      if (!validBearer(request.headers.authorization, deps.apiKey)) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Chave de acesso inválida ou ausente.' });
      }
    });

    api.put<{ Params: { id: string }; Body: { name: string; providerRefs?: Record<string, string> } }>(
      '/v1/accounts/:id',
      { schema: { body: accountBody } },
      async (request) => saveAccount(deps.accounts, { id: request.params.id, ...request.body }, now()),
    );

    api.get<{ Params: { id: string } }>('/v1/accounts/:id', async (request, reply) => {
      const account = await deps.accounts.get(request.params.id);
      return account ?? reply.code(404).send({ error: 'ACCOUNT_NOT_FOUND', message: 'Conta não encontrada.' });
    });

    api.post<{ Body: CreateChargeInput }>('/v1/charges', { schema: { body: createChargeBody } }, async (request) =>
      deps.service.create(request.body),
    );

    api.get<{ Params: { id: string } }>('/v1/charges/:id', async (request, reply) => {
      const charge = await deps.service.get(request.params.id);
      return charge ?? reply.code(404).send({ error: 'CHARGE_NOT_FOUND', message: 'Cobrança não encontrada.' });
    });

    api.post<{ Params: { id: string } }>('/v1/charges/:id/sync', async (request) => {
      const result = await deps.service.sync(request.params.id);
      return { result, charge: await deps.service.get(request.params.id) };
    });

    api.post('/v1/jobs/reconcile', async () => ({
      reconciliation: await deps.service.reconcilePending(),
      notifications: await deps.service.deliverPendingNotifications(),
    }));

    const simulator = deps.simulator;
    if (simulator) {
      api.post<{ Params: { providerChargeId: string }; Body: SimulatedPayment | undefined }>(
        '/v1/simulator/charges/:providerChargeId/pay',
        { schema: { body: simulatedPaymentBody } },
        async (request) => {
          const webhook = simulator.pay(request.params.providerChargeId, request.body ?? {});
          return { ok: true, outcomes: await deps.service.handleWebhook({ body: webhook, query: {} }) };
        },
      );
    }
  });

  return app;
}

/** Traduz cada erro para o código HTTP e uma resposta que o sistema cliente entende. */
export function errorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof ChargeError) {
    const status = { INVALID_CHARGE: 422, IDEMPOTENCY_CONFLICT: 409, IN_PROGRESS: 409, CHARGE_NOT_FOUND: 404 }[
      error.code
    ];
    return { status, body: { error: error.code, message: error.message, issues: error.issues } };
  }
  if (error instanceof AccountError) {
    return { status: 422, body: { error: error.code, message: error.message, issues: error.issues } };
  }
  if (error instanceof ProviderError) {
    const status = {
      INVALID_REQUEST: 422,
      IDEMPOTENCY_CONFLICT: 409,
      CHARGE_NOT_FOUND: 404,
      ALREADY_PAID: 409,
      INVALID_WEBHOOK: 400,
      UNAUTHORIZED_WEBHOOK: 401,
      // Sem resposta do parceiro: o aviso volta com erro para o parceiro tentar de novo.
      UNAVAILABLE: 502,
    }[error.code];
    return {
      status,
      body: { error: `PROVIDER_${error.code}`, message: error.message, provider: error.provider, providerCode: error.providerCode },
    };
  }
  const fastifyError = error as Partial<FastifyError>;
  if (fastifyError.validation) {
    return { status: 400, body: { error: 'INVALID_REQUEST_FORMAT', message: `Pedido em formato inválido: ${fastifyError.message}` } };
  }
  if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
    return { status: fastifyError.statusCode, body: { error: fastifyError.code ?? 'BAD_REQUEST', message: fastifyError.message } };
  }
  return { status: 500, body: { error: 'INTERNAL', message: 'Erro interno no DocPay.' } };
}

function validBearer(header: string | undefined, apiKey: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!match || !apiKey) return false;
  const received = Buffer.from(match[1] ?? '');
  const expected = Buffer.from(apiKey);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
