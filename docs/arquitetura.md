# Arquitetura do DocPay

## O que é

O DocPay é a camada de software que emite cobranças, divide o dinheiro entre as contas (split), registra tudo numa contabilidade interna (o razão) e confere os números com o parceiro. É um produto separado do DocLine Gestão 360, que é o primeiro sistema a usá-lo.

O DocPay **não** é instituição de pagamento. O dinheiro entra, é dividido e sai sempre dentro de um parceiro autorizado pelo Banco Central (iugu, Asaas, Safe2Pay ou outro). Cada conta do DocPay corresponde a uma subconta nesse parceiro.

## Peças

| Peça | O que é | Onde está |
|---|---|---|
| Conta | Quem recebe dinheiro: o beneficiário de uma cobrança ou um destinatário da divisão. No parceiro, é uma subconta, e a verificação de documentos (KYC) fica com o parceiro. | a fazer |
| Pagador | Quem paga: nome e CPF ou CNPJ. | `src/providers/types.ts` |
| Cobrança | Boleto com Pix. Tem um beneficiário, que é o credor original. | `src/charges` |
| Regra de divisão | Quanto cada conta recebe: percentual, valor fixo ou os dois. | `src/split` |
| Parceiro | Adaptador para um parceiro. Todos seguem a mesma interface. Hoje só existe o simulado. | `src/providers` |
| Razão | Contabilidade interna em partidas dobradas. Nada é apagado. | `src/ledger` |
| Caixa de avisos | Guarda cada aviso (webhook) do parceiro do jeito que chegou. | `src/charges` |
| Conciliação | Consulta no parceiro as cobranças em aberto e dá baixa nas que foram pagas. | `ChargeService.reconcilePending` |
| Banco de dados | PostgreSQL. As regras do razão e das cobranças também são garantidas pelo banco. | `src/db`, `migrations/` |

## Caminho de uma cobrança

1. O sistema que usa o DocPay (o DocLine) pede uma cobrança: valor, vencimento, pagador e regra de divisão, com uma chave de idempotência.
2. O DocPay confere os dados e calcula a divisão.
3. O DocPay pede a cobrança ao parceiro, com os repasses já em centavos e a mesma chave de idempotência.
4. O parceiro devolve a linha digitável e o Pix copia e cola, que o DocPay repassa a quem pediu.
5. O pagador paga. O parceiro divide o dinheiro entre as subcontas e manda um aviso.
6. O DocPay guarda o aviso bruto, **consulta a cobrança no parceiro** (o aviso pode ser falso) e, se ela foi paga, lança a baixa no razão.
7. A fazer: o DocPay avisa o DocLine, que dá baixa no título dele.
8. Todo dia, a conciliação consulta no parceiro as cobranças ainda em aberto e dá baixa nas que foram pagas, caso o aviso tenha se perdido. Falta agendar a execução diária, o que vem junto com a API.

Repetir qualquer passo não duplica nada. A emissão usa a chave de idempotência, e a baixa usa a chave `settlement:<id da cobrança>` no razão. Se a resposta do parceiro se perder na emissão, basta repetir o pedido com a mesma chave: o parceiro devolve a cobrança que já tinha criado.

## Motor de divisão (`src/split`)

- Cada destinatário recebe o valor fixo mais o percentual sobre o valor, arredondado para baixo.
- O beneficiário fica com o restante, inclusive os centavos de arredondamento.
- A soma das partes fecha exatamente o valor. Se não fechar, o cálculo é recusado com a lista de problemas.
- O motor sabe dividir a tarifa de três jeitos: o beneficiário paga, um destinatário paga, ou todos pagam na proporção do que recebem. Por enquanto, as cobranças só aceitam o primeiro (veja "Decisões em aberto").

Exemplo: cobrança de R$ 1.000,00, parceiro com 40%, pagamento por Pix com tarifa de R$ 2,40.

| Conta | Parte | Tarifa | Recebe |
|---|---|---|---|
| Beneficiário | R$ 600,00 | R$ 2,40 | R$ 597,60 |
| Parceiro | R$ 400,00 | — | R$ 400,00 |

O DocPay calcula e o parceiro só executa, porque cada parceiro trata a soma do split de um jeito: a Safe2Pay recusa se não fechar, a iugu ignora o split se somar 100% e a Asaas calcula sobre o valor líquido. Mandando valores fixos em centavos, o resultado é o mesmo em qualquer parceiro e bate com o razão.

## Razão (`src/ledger`)

O razão do DocPay é um espelho: mostra onde está o dinheiro dentro do parceiro. Não é a contabilidade da empresa DocPay.

- Cada lançamento tem partidas que somam zero. Valor positivo entra na conta, negativo sai.
- Nada é alterado nem apagado. Correção é um lançamento novo; o estorno é o lançamento inverso.
- Cada lançamento tem uma chave de idempotência. A mesma chave com o mesmo conteúdo devolve o lançamento já feito; com outro conteúdo, é recusada.

| Conta do razão | O que mostra |
|---|---|
| `account:<conta>` | Saldo da conta do DocPay no parceiro |
| `external:payers` | Dinheiro que entrou dos pagadores (fica negativo) |
| `external:provider-fees` | Tarifas cobradas pelo parceiro |

Baixa da cobrança do exemplo:

| Conta do razão | Valor | Descrição |
|---|---|---|
| `external:payers` | −R$ 1.000,00 | Pagamento recebido |
| `account:vendedor` | +R$ 1.000,00 | Pagamento recebido |
| `account:vendedor` | −R$ 400,00 | Repasse para parceiro |
| `account:parceiro` | +R$ 400,00 | Repasse de vendedor |
| `account:vendedor` | −R$ 2,40 | Tarifa do parceiro |
| `external:provider-fees` | +R$ 2,40 | Tarifa do parceiro |

O beneficiário recebe o valor inteiro e repassa a parte do destinatário. Assim o extrato dele mostra o que de fato aconteceu: ele cobrou R$ 1.000,00 e repassou R$ 400,00.

O razão tem duas versões com a mesma interface e os mesmos testes: `PostgresLedger`, para produção, e `InMemoryLedger`, para testes rápidos.

## Banco de dados (`src/db`, `migrations/`)

O DocPay usa PostgreSQL. O código confere tudo antes de gravar, e o banco garante as regras de novo, para que um bug ou um comando manual não consiga quebrá-las:

- as partidas de cada lançamento somam zero e movimentam pelo menos duas contas, conferido no fim da transação;
- nada no razão pode ser alterado nem apagado;
- cobrança não é apagada, não muda de identidade e, depois de paga, não volta a ficar em aberto;
- as colunas da cobrança batem com o documento guardado nela.

**Migrações.** Ficam em `migrations/`, uma por arquivo, e são aplicadas em ordem por `migrate()`, numa transação só e com trava (se duas instâncias subirem juntas, uma espera a outra). Migração já aplicada nunca é editada: toda mudança é uma migração nova. A pasta `migrations/` precisa ir junto com o código para o servidor.

**Testes.** Por padrão, os testes usam o PGlite, um PostgreSQL de verdade que roda dentro do processo, sem instalar nada. Com a variável `DATABASE_URL`, usam o servidor indicado. O CI roda dos dois jeitos. Cada teste ganha um schema próprio e vazio.

**Driver.** O código fala com o banco por uma interface mínima (`Db`). Em produção, o adaptador é o do node-postgres (`nodePostgresDb`).

## Parceiro simulado (`src/providers/simulated-provider.ts`)

O parceiro simulado serve para desenvolver e testar sem contrato nem rede. Ele imita o que importa num parceiro real:

- a criação da cobrança é idempotente pela chave;
- a tarifa muda conforme o meio de pagamento (padrão: R$ 2,99 no boleto e R$ 2,40 no Pix);
- os repasses são executados exatamente como pedidos, e a tarifa sai do beneficiário;
- recusa repasses que não deixem para o beneficiário o suficiente para a tarifa;
- o aviso de pagamento só diz qual cobrança mudou.

O método `pay` existe só no simulador: paga a cobrança como se fosse o pagador.

## Decisões em aberto

- **Quem paga e quem recebe no DocLine.** Isso define as contas e as regras de divisão que o DocLine vai usar.
- **Tarifa.** Por enquanto, quem paga é sempre o beneficiário. No boleto com Pix, a tarifa muda conforme o pagador usa o código de barras ou o QR, e só esse modo deixa mandar os repasses já na emissão. Os outros modos dependem de um recurso do parceiro escolhido (a Safe2Pay tem o `IsPayTax`, por exemplo).
- **Juros, multa e desconto.** Proposta: os repasses valem sobre o valor original; juros e multa ficam com o beneficiário, e o desconto sai da parte dele. Quando o valor pago é diferente do valor da cobrança, a cobrança registra uma divergência para conferência.
- **Estorno e chargeback.** Falta definir como dividir a devolução entre as contas. Proposta: na mesma proporção da divisão original (`allocateProportionally`).
- **Receita do DocPay.** Mensalidade (caminho seguro) ou parte da cobrança (depende de parecer jurídico sobre a Resolução Conjunta 16/2025).
- **Plano de contas.** As contas do razão acima são uma proposta e precisam ser validadas pelo contador.
- **Mais de um sistema usando o DocPay.** Quando entrar um segundo sistema além do DocLine, as chaves de idempotência precisam levar o nome do sistema na frente, para não colidir.
- **Cobranças vencidas.** Hoje uma cobrança que nunca é paga fica em aberto para sempre, e a conciliação continua a consultá-la. Falta o status de vencida ou cancelada, e a regra de quando aplicá-lo.
- **Saldos.** A conciliação ainda não compara o saldo de cada conta no razão com o saldo no parceiro. Isso depende de registrar os saques das subcontas.

## Tecnologia

- TypeScript com Node.js 22, sem framework por enquanto.
- PostgreSQL, com o driver node-postgres. Nos testes, PGlite.
- Testes com Vitest. As regras de dinheiro também têm testes de propriedade (fast-check), que geram centenas de casos aleatórios.
