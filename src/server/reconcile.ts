/*
 * Conciliação (no Render, o cron: npm run reconcile). Consulta no parceiro as
 * cobranças em aberto, registra o que mudou e manda os avisos que ficaram
 * para trás. Escreve o relatório no log e sai.
 */
import { readConfig } from './config.js';
import { createRuntime } from './runtime.js';

const result = readConfig(process.env, { requireApiKey: false });
if (!result.ok) {
  console.error(`A conciliação não pode rodar. Falta configurar:\n${result.problems.map((problem) => `- ${problem}`).join('\n')}`);
  process.exit(1);
}

const runtime = await createRuntime(result.config);
try {
  const reconciliation = await runtime.service.reconcilePending();
  const notifications = await runtime.service.deliverPendingNotifications();
  console.log(JSON.stringify({ at: new Date().toISOString(), reconciliation, notifications }));
  if (reconciliation.failed.length > 0 || notifications.failed.length > 0) process.exitCode = 2;
} finally {
  await runtime.close();
}
