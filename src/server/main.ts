/*
 * Servidor do DocPay (no Render: npm start). Lê a configuração, aplica as
 * migrações pendentes e sobe a API.
 */
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { createRuntime } from './runtime.js';

const result = readConfig(process.env);
if (!result.ok) {
  console.error(`O DocPay não pode subir. Falta configurar:\n${result.problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}
const { config } = result;

const runtime = await createRuntime(config);
const app = buildApp({
  apiKey: config.apiKey,
  service: runtime.service,
  accounts: runtime.accounts,
  provider: runtime.provider,
  checkDatabase: runtime.checkDatabase,
  logger: true,
  ...(runtime.simulator ? { simulator: runtime.simulator } : {}),
});

const sandbox = config.provider.kind === 'safe2pay' && config.provider.sandbox ? ' (ambiente de teste)' : '';
app.log.info(
  `DocPay com o parceiro ${runtime.provider.name}${sandbox}. Migrações aplicadas agora: ${runtime.migrations.join(', ') || 'nenhuma'}.`,
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info(`Recebi ${signal}: encerrando.`);
  await app.close();
  await runtime.close();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.port });
