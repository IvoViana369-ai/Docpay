import pg from 'pg';
import { PostgresAccountRepository } from '../accounts/postgres-repository.js';
import type { AccountRepository } from '../accounts/types.js';
import { ChargeService } from '../charges/charge-service.js';
import { PostgresChargeClaims } from '../charges/claims.js';
import { WebhookNotifier } from '../charges/notifier.js';
import { PostgresChargeRepository, PostgresWebhookInbox } from '../charges/postgres-repositories.js';
import { migrate } from '../db/migrate.js';
import { nodePostgresDb } from '../db/node-postgres.js';
import { PostgresLedger } from '../ledger/postgres-ledger.js';
import { Safe2PayProvider } from '../providers/safe2pay/safe2pay-provider.js';
import { SimulatedProvider } from '../providers/simulated-provider.js';
import type { PaymentProvider } from '../providers/types.js';
import type { ServerConfig } from './config.js';

export interface Runtime {
  service: ChargeService;
  accounts: AccountRepository;
  provider: PaymentProvider;
  /** Só com o parceiro simulado. */
  simulator: SimulatedProvider | undefined;
  /** Migrações aplicadas ao subir. */
  migrations: string[];
  checkDatabase(): Promise<void>;
  close(): Promise<void>;
}

/** Liga as peças do DocPay ao banco e ao parceiro configurados. Aplica as migrações pendentes. */
export async function createRuntime(config: ServerConfig): Promise<Runtime> {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    ...(config.databaseSsl ? { ssl: true } : {}),
  });
  const db = nodePostgresDb(pool);
  const migrations = await migrate(db);
  const accounts = new PostgresAccountRepository(db);

  let provider: PaymentProvider;
  let simulator: SimulatedProvider | undefined;
  if (config.provider.kind === 'safe2pay') {
    const { apiKey, sandbox, mainAccount, fees } = config.provider;
    provider = new Safe2PayProvider({
      apiKey,
      sandbox,
      mainAccount,
      fees,
      publicBaseUrl: config.publicUrl ?? '',
      accounts,
      timeZone: config.timeZone,
    });
  } else {
    // O simulado guarda as cobranças em memória: só serve para teste, e elas somem ao reiniciar.
    // A numeração parte do relógio (em milissegundos) para que, depois de reiniciar, o simulador
    // não repita o número de uma cobrança que já está no banco.
    simulator = new SimulatedProvider({ firstChargeNumber: Date.now() });
    provider = simulator;
  }

  const service = new ChargeService({
    provider,
    ledger: new PostgresLedger(db),
    charges: new PostgresChargeRepository(db),
    claims: new PostgresChargeClaims(db),
    webhooks: new PostgresWebhookInbox(db),
    timeZone: config.timeZone,
    ...(config.notify ? { notifier: new WebhookNotifier(config.notify) } : {}),
  });

  return {
    service,
    accounts,
    provider,
    simulator,
    migrations,
    checkDatabase: async () => {
      await db.query('SELECT 1');
    },
    close: () => pool.end(),
  };
}
