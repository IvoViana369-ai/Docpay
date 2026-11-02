# Arquitetura do DocPay

## O que é

O DocPay é a camada de software que emite cobranças, divide o dinheiro entre as contas (split), registra tudo numa contabilidade interna (o razão) e confere os números com o parceiro. É um produto separado do DocLine Gestão 360, que é o primeiro sistema a usá-lo, pela API.

O DocPay **não** é instituição de pagamento. O dinheiro entra, é dividido e sai sempre dentro de um parceiro autorizado pelo Banco Central. Hoje o parceiro real é a Safe2Pay, que o DocLine já usa. Cada conta do DocPay corresponde a uma subconta nesse parceiro.

No DocLine (venda de certificado digital): o **cliente** paga; o **parceiro** (contador) e o **P.A.** recebem a parte deles na subconta Safe2Pay de cada um; o resto fica na **conta principal da Docline**, que paga a tarifa da Safe2Pay.

## Peças

| Peça | O que é | Onde está |
|---|---|---|
| API | O que o DocLine chama: contas, cobranças, conciliação e o aviso do parceiro | `src/server` |
| Conta | Quem recebe dinheiro, com o nome e a subconta em cada parceiro (ex.: o Id Receiver da Safe2Pay) | `src/accounts` |
| Cobrança | Boleto ou Pix, com um beneficiário (o credor original) e a regra de divisão | `src/charges` |
| Regra de divisão | Quanto cada conta recebe: percentual, valor fixo ou os dois | `src/split` |
| Parceiro | Adaptador para um parceiro. Hoje: o simulado (para teste) e a Safe2Pay | `src/providers` |
| Razão | Contabilidade interna em partidas dobradas. Nada é apagado | `src/ledger` |
| Caixa de avisos | Cada aviso (webhook) do parceiro, do jeito que chegou | `src/charges` |
| Aviso ao sistema cliente | Chamada assinada ao DocLine quando o status de uma cobrança muda | `src/charges/notifier.ts` |
| Conciliação | Consulta as cobranças em aberto e reenvia os avisos que falharam (cron a cada 30 minutos) | `src/server/reconcile.ts` |
| Banco de dados | PostgreSQL. As regras também são garantidas pelo banco | `src/db`, `migrations/` |

## Caminho de uma cobrança

1. O DocLine cadastra (ou atualiza) as contas de quem recebe: `PUT /v1/accounts/:id`, com o nome e o Id Receiver da subconta.
2. O DocLine pede a cobrança: `POST /v1/charges`, com chave de idempotência, referência (ex.: `DOCLINE-13`), meio (boleto ou Pix), valor, vencimento, pagador e regra de divisão.
3. O DocPay confere os dados e calcula a divisão. No boleto, o endereço do pagador precisa estar completo.
4. O DocPay **reserva a chave** e confere de novo se a cobrança já existe. A Safe2Pay não reconhece chave de idempotência: sem a reserva, duas chamadas ao mesmo tempo criariam duas cobranças.
5. O DocPay pede a cobrança à Safe2Pay, com os repasses já em centavos, e devolve ao DocLine o link do boleto e a linha digitável, ou o QR e o copia e cola do Pix.
6. O cliente paga. A Safe2Pay divide o dinheiro entre as subcontas e manda um aviso ao DocPay.
7. O DocPay guarda o aviso bruto, **consulta a cobrança na Safe2Pay** (o aviso pode ser falso) e registra o que mudou: pagamento vira baixa no razão; boleto baixado, cancelamento ou recusa só mudam o status.
8. O DocPay avisa o DocLine (`DOCPAY_NOTIFY_URL`), com assinatura. O DocLine confere a assinatura e consulta a cobrança (`GET /v1/charges/:id`) antes de mudar a venda.
9. A cada 30 minutos, a conciliação consulta as cobranças em aberto (avisos perdidos) e reenvia os avisos que o DocLine não confirmou.

Repetir qualquer passo não duplica nada. Se a Safe2Pay não responder na emissão, a mensagem pede para conferir no painel dela se a cobrança com aquela referência não foi criada, antes de tentar de novo (o mesmo cuidado que o DocLine já tem).

### Status da cobrança

| Status | Quando | Safe2Pay |
|---|---|---|
| `pending` | Em aberto | 1 Pendente, 2 Processamento, 14 Pré-autorizado; também 5, 6 e 13 (disputa, devolução, chargeback), que ficam para conferência |
| `paid` | Paga, com a baixa no razão | 3 Autorizado, 4 Disponível, 11 Liberado |
| `expired` | Vencida e baixada | 7 Baixado |
| `failed` | Recusada depois de criada | 8 Recusado |
| `canceled` | Cancelada | 12 Em cancelamento |

Cobrança paga não muda mais de status. Vencida, cancelada ou recusada só pode passar a paga (pagamento atrasado que o parceiro aceitou). O banco garante as duas regras.

## API (`src/server`)

Todas as rotas `/v1`, menos a do aviso do parceiro, exigem `Authorization: Bearer <DOCPAY_API_KEY>`.

| Rota | O que faz |
|---|---|
| `GET /health` | Confere o serviço e o banco |
| `PUT /v1/accounts/:id` | Cria ou atualiza a conta: `{ "name": "...", "providerRefs": { "safe2pay": "123456" } }` |
| `GET /v1/accounts/:id` | Consulta a conta |
| `POST /v1/charges` | Emite a cobrança (repetir a chave devolve a mesma) |
| `GET /v1/charges/:id` | Consulta a cobrança |
| `POST /v1/charges/:id/sync` | Consulta o parceiro agora (para quando o aviso ainda não chegou) |
| `POST /v1/jobs/reconcile` | Roda a conciliação e reenvia os avisos pendentes |
| `POST /v1/providers/:parceiro/webhook` | Aviso do parceiro. A Safe2Pay manda com a chave no parâmetro `k` |
| `POST /v1/simulator/charges/:id/pay` | Só com o parceiro simulado: paga a cobrança de teste |

Respostas de erro: `400` (formato errado), `401` (chave), `404`, `409` (chave repetida com outro conteúdo, ou cobrança sendo gerada: `IN_PROGRESS`), `422` (cada problema com o campo e a explicação, ou recusa do parceiro com o código dele) e `502` (o parceiro não respondeu).

### Aviso ao sistema cliente

Quando o status muda, o DocPay faz `POST` em `DOCPAY_NOTIFY_URL` com:

```json
{ "event": "charge.updated", "chargeId": "…", "idempotencyKey": "…", "reference": "DOCLINE-13", "status": "paid", "occurredAt": "…" }
```

O cabeçalho `X-DocPay-Signature: t=<segundos>,v1=<HMAC-SHA256 de "<t>.<corpo>">` usa o `DOCPAY_NOTIFY_SECRET`. O sistema cliente confere a assinatura, recusa aviso com mais de 5 minutos de diferença e consulta a cobrança antes de agir. Se ele não responder com 2xx, a conciliação manda de novo.

## Motor de divisão (`src/split`)

- Cada destinatário recebe o valor fixo mais o percentual sobre o valor, arredondado para baixo.
- O beneficiário fica com o restante, inclusive os centavos de arredondamento.
- A soma das partes fecha exatamente o valor. Se não fechar, o cálculo é recusado com a lista de problemas.
- O motor sabe dividir a tarifa de três jeitos, mas as cobranças só aceitam o beneficiário pagando a tarifa, como no DocLine (a Docline assume as tarifas).

O DocPay calcula e o parceiro só executa, porque cada parceiro trata a soma do split de um jeito: a Safe2Pay recusa se não fechar, a iugu ignora o split se somar 100% e a Asaas calcula sobre o valor líquido. Mandando valores fixos em centavos, o resultado é o mesmo em qualquer parceiro e bate com o razão.

## Safe2Pay (`src/providers/safe2pay`)

O adaptador porta o que o DocLine já validou em produção (`safe2pay.py` e `docs/SAFE2PAY.md` do DocLine):

- boleto (`PaymentMethod` 1) e Pix (6, válido até o fim do dia do vencimento); o ambiente de teste não gera Pix;
- divisão no formato do suporte: `CodeTaxType` 2, `IdReceiver`, `Name`, `IsPayTax` false e `Amount` em reais; só as subcontas vão na divisão, e o resto fica na conta principal, dona do token;
- a Safe2Pay responde HTTP 200 mesmo com erro: as recusas viram mensagens com a dica de cada código já visto (022, 207, 256, 301, 1292);
- a consulta não traz a tarifa nem os repasses: vêm da tarifa do contrato (`SAFE2PAY_FEE_BOLETO`, `SAFE2PAY_FEE_PIX`) e da própria cobrança.

## Razão (`src/ledger`)

O razão do DocPay é um espelho: mostra onde está o dinheiro dentro do parceiro. Não é a contabilidade da empresa.

- Cada lançamento tem partidas que somam zero. Valor positivo entra na conta, negativo sai.
- Nada é alterado nem apagado. Correção é um lançamento novo; o estorno é o lançamento inverso.
- Cada lançamento tem uma chave de idempotência. A mesma chave com o mesmo conteúdo devolve o lançamento já feito; com outro conteúdo, é recusada.

| Conta do razão | O que mostra |
|---|---|
| `account:<conta>` | Saldo da conta do DocPay no parceiro |
| `external:payers` | Dinheiro que entrou dos pagadores (fica negativo) |
| `external:provider-fees` | Tarifas cobradas pelo parceiro |

Baixa de uma venda de R$ 135,00 com 30% para o parceiro, paga por boleto (tarifa de R$ 1,00):

| Conta do razão | Valor | Descrição |
|---|---|---|
| `external:payers` | −R$ 135,00 | Pagamento recebido |
| `account:docline` | +R$ 135,00 | Pagamento recebido |
| `account:docline` | −R$ 40,50 | Repasse para o parceiro |
| `account:docline:parceiro:42` | +R$ 40,50 | Repasse da Docline |
| `account:docline` | −R$ 1,00 | Tarifa do parceiro |
| `external:provider-fees` | +R$ 1,00 | Tarifa do parceiro |

## Banco de dados (`src/db`, `migrations/`)

O código confere tudo antes de gravar, e o banco garante as regras de novo:

- as partidas de cada lançamento somam zero e movimentam pelo menos duas contas, conferido no fim da transação;
- nada no razão pode ser alterado nem apagado;
- cobrança não é apagada, não muda de identidade e segue as regras de status acima;
- as colunas da cobrança batem com o documento guardado nela;
- o id da conta segue o formato combinado.

**Migrações.** Ficam em `migrations/`, uma por arquivo, e são aplicadas em ordem ao subir o serviço, numa transação só e com trava. Migração já aplicada nunca é editada: toda mudança é uma migração nova.

**Testes.** Por padrão, usam o PGlite, um PostgreSQL que roda dentro do processo. Com `DATABASE_URL`, usam o servidor indicado. O CI roda dos dois jeitos.

## Publicação

No Render, pelo `render.yaml`: o serviço `docpay`, o banco `docpay-db` e o cron `docpay-conciliacao`. O passo a passo está em [`docs/RENDER.md`](RENDER.md).

## Decisões em aberto

- **Tarifa do Pix no contrato.** A do boleto, pelo painel, é R$ 1,00. A do Pix precisa ser conferida no contrato ou no painel da Safe2Pay.
- **Juros, multa e desconto.** Hoje o boleto não leva juros nem multa, e o pagamento parcial está desligado. Se um dia tiver, a proposta é: os repasses valem sobre o valor original, e a diferença fica com o beneficiário.
- **Estorno e chargeback.** Falta definir como dividir a devolução entre as contas. Proposta: na mesma proporção da divisão original (`allocateProportionally`). Até lá, disputa, devolução e chargeback ficam em aberto para conferência.
- **Saldos.** A conciliação ainda não compara o saldo de cada conta com o saldo no parceiro. Isso depende de registrar os saques e os depósitos das subcontas.
- **Receita do DocPay.** Mensalidade (caminho seguro) ou parte da cobrança (depende de parecer jurídico sobre a Resolução Conjunta 16/2025).
- **Plano de contas.** As contas do razão acima são uma proposta e precisam ser validadas pelo contador.
- **Mais de um sistema usando o DocPay.** Quando entrar um segundo sistema além do DocLine, cada um precisa da própria chave de API, e as chaves de idempotência precisam levar o nome do sistema.
- **Documentação da Safe2Pay.** O ambiente onde o DocPay foi escrito não acessa o site da Safe2Pay. O adaptador segue o que o DocLine já validou; vale conferir na primeira cobrança de teste.

## Tecnologia

- TypeScript com Node.js 22, Fastify na API.
- PostgreSQL, com o driver node-postgres. Nos testes, PGlite.
- Testes com Vitest. As regras de dinheiro também têm testes de propriedade (fast-check).
