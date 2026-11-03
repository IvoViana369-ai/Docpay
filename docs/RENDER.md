# Publicar o DocPay no Render

Este guia é para quem tem acesso ao painel do Render (o Ivo). As chaves e os segredos vão **só no Render**, nunca no chat nem no repositório.

O DocPay sobe em três partes, descritas no `render.yaml`:

| Parte | Nome no Render | O que faz |
|---|---|---|
| Banco | `docpay-db` | PostgreSQL do DocPay, separado do banco do DocLine |
| Serviço web | `docpay` | A API que o DocLine chama |
| Cron | `docpay-conciliacao` | A cada 30 minutos, confere as cobranças em aberto e reenvia os avisos que falharam |

O DocPay cria as tabelas sozinho ao subir.

## 1. Criar os serviços

1. No Render, **New › Blueprint**, escolha o repositório **Docpay** e o ramo `main`.
2. O Render lê o `render.yaml` e mostra as três partes. Ele pede os valores marcados como `sync: false`. Por enquanto, preencha só os do passo 2 e deixe os outros em branco: `DOCPAY_PROVIDER` em branco é o parceiro simulado, e `SAFE2PAY_SANDBOX` em branco é o ambiente de teste.
3. **Custos:** o Render cobra à parte cada parte do DocPay (o serviço web, o banco e o cron). Confira os planos e os preços na hora de criar. Não use o plano gratuito no serviço web, porque ele dorme depois de um tempo parado e o DocLine esperaria ele acordar. O banco gratuito do Render tem prazo de validade, então também não serve.

O `DOCPAY_PROVIDER` e o `SAFE2PAY_SANDBOX` ficam só no painel, de propósito: assim, uma sincronização do Blueprint nunca desfaz a troca do parceiro ou do ambiente feita por você.

## 2. Começar com o parceiro simulado (sem dinheiro de verdade)

Com `DOCPAY_PROVIDER=simulated`, o DocPay finge ser a Safe2Pay. Serve para testar o DocLine de ponta a ponta antes de ligar a Safe2Pay.

No serviço **docpay**, em **Environment**:

| Variável | Valor |
|---|---|
| `DOCPAY_API_KEY` | uma senha longa e aleatória, com pelo menos 32 caracteres (gere num gerenciador de senhas). A mesma vai no DocLine |
| `DOCPAY_PUBLIC_URL` | o endereço do serviço, que o Render mostra no topo da página (ex.: `https://docpay.onrender.com`) |
| `DOCPAY_NOTIFY_URL` | `https://docline-gestao-comercial.onrender.com/api/docpay/webhook` (o endereço do DocLine que recebe os avisos) |
| `DOCPAY_NOTIFY_SECRET` | outra senha longa e aleatória, com pelo menos 32 caracteres. A mesma vai no DocLine |

No cron **docpay-conciliacao**, repita `DOCPAY_PUBLIC_URL`, `DOCPAY_NOTIFY_URL` e `DOCPAY_NOTIFY_SECRET` com os mesmos valores.

**Conferir:** abra `https://<endereço do docpay>/health`. Deve aparecer `{"ok":true,"provider":"simulated"}`. Se o serviço não subir, o log mostra a lista do que falta configurar.

**No DocLine** (serviço **docline-gestao-comercial**, versão 7.52.0 ou mais nova), em **Environment**:

| Variável | Valor |
|---|---|
| `PAGAMENTOS_VIA_DOCPAY` | `1` |
| `DOCPAY_URL` | o endereço do DocPay (o mesmo do `DOCPAY_PUBLIC_URL`) |
| `DOCPAY_API_KEY` | a mesma do DocPay |
| `DOCPAY_NOTIFY_SECRET` | o mesmo do DocPay |

O guia do lado do DocLine, com o roteiro de teste e como voltar atrás, está no `docs/DOCPAY.md` do repositório do DocLine. Com `PAGAMENTOS_VIA_DOCPAY=0`, o DocLine volta a chamar a Safe2Pay direto.

**Atenção:** o parceiro simulado guarda as cobranças na memória. Elas somem quando o serviço reinicia, e o cron não as enxerga. É só para teste.

## 3. Ligar a Safe2Pay no ambiente de teste

No serviço **docpay** e também no cron:

| Variável | Valor |
|---|---|
| `DOCPAY_PROVIDER` | `safe2pay` |
| `SAFE2PAY_API_KEY` | o token de **sandbox** da conta da Docline na Safe2Pay (o mesmo que o DocLine usa hoje no teste) |
| `SAFE2PAY_SANDBOX` | `1` |
| `SAFE2PAY_MAIN_ACCOUNT` | `docline` (a conta do DocPay que representa a conta principal da Docline) |
| `SAFE2PAY_FEE_BOLETO` | a tarifa do boleto no contrato. Pelo painel, hoje é R$ 1,00: `100` |
| `SAFE2PAY_FEE_PIX` | a tarifa do Pix no contrato, em centavos (`100`), percentual (`0,99%`) ou os dois (`100+0,99%`) |

Sobre as tarifas: a consulta da Safe2Pay não informa a tarifa, então o DocPay usa a do contrato para registrar quanto saiu da conta da Docline. Confira os valores no painel ou no contrato da Safe2Pay.

O endereço do aviso de pagamento vai em cada cobrança, então não é preciso configurar nada no painel da Safe2Pay.

**Lembrete:** o ambiente de teste da Safe2Pay não gera Pix, só boleto.

## 4. Produção

Quando o teste der certo:

1. Troque `SAFE2PAY_API_KEY` pelo token de **produção** e `SAFE2PAY_SANDBOX` para `0`, no serviço e no cron.
2. Faça uma venda pequena de verdade com boleto e outra com Pix, pagas pela própria equipe, e confira no painel da Safe2Pay a divisão na subconta do parceiro.

## Se algo der errado

| O que aparece | O que fazer |
|---|---|
| O serviço não sobe | O log lista cada variável que falta ou está errada |
| `401` nas chamadas do DocLine | A `DOCPAY_API_KEY` é diferente no DocPay e no DocLine |
| `A Safe2Pay recusou: … (código 207)` | O Id Receiver da subconta do parceiro está errado, ou a subconta não está ligada ao Marketplace da conta da Docline |
| `Não consegui falar com a Safe2Pay agora` | Antes de tentar de novo, confira no painel da Safe2Pay se a cobrança com aquela referência (ex.: `DOCLINE-13`) não foi criada |
| O DocLine não recebe os avisos | Confira `DOCPAY_NOTIFY_URL` e `DOCPAY_NOTIFY_SECRET`. O cron reenvia o que falhou a cada 30 minutos |
