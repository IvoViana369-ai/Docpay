# DocPay

DocPay é a camada de software de cobrança com divisão de pagamentos (split). É um produto separado do DocLine Gestão 360, que é o primeiro sistema a usá-lo. O DocPay é genérico: não conhece as regras de negócio do DocLine. Ele fala em conta, pagador, cobrança e regra de divisão.

Leia `docs/arquitetura.md` antes de mudar o fluxo de cobrança, o razão ou o motor de divisão.

## Regras que não se negociam

- **O DocPay nunca recebe nem guarda dinheiro.** Todo valor entra, é dividido e sai dentro de um parceiro autorizado pelo Banco Central. Não crie conta própria para receber e repassar: isso exige licença (Res. BCB 494/2025 e 443/2024, Resolução Conjunta 16/2025).
- **O beneficiário da cobrança é o credor original**, nunca o DocPay.
- **Dinheiro é sempre inteiro, em centavos** (`Cents`). Nunca use número com casas decimais para dinheiro. Percentuais vão em pontos-base (`10000 = 100%`). Multiplicações e somas que podem crescer usam `BigInt`.
- **O DocPay calcula, o parceiro executa.** O parceiro recebe valores fixos em centavos calculados por `calculateSplit`. Nunca mande percentuais para o parceiro arredondar do jeito dele.
- **Arredondamento:** percentuais arredondam para baixo, e o que sobra fica com o beneficiário. Rateios usam o maior resto; no empate, ganha quem vem primeiro.
- **Razão em partidas dobradas e imutável.** Todo lançamento soma zero. Nada é alterado nem apagado: correção é um lançamento novo (estorno).
- **Idempotência em tudo que move dinheiro.** Emissão de cobrança, lançamento no razão e baixa levam chave de idempotência. Repetir a mesma chamada não pode duplicar nada.
- **Aviso (webhook) não dá baixa sozinho.** Guarde o aviso bruto, consulte a cobrança no parceiro e só então lance no razão.

## Armadilhas dos parceiros

- Safe2Pay: responde HTTP 200 mesmo com erro (veja o campo `HasError`). O webhook não tem assinatura HMAC e é reenviado até 5 vezes, com 5 h de intervalo. No split, a soma tem de fechar exatamente o valor, senão a transação é recusada.
- iugu: subcontas só podem ser criadas em produção, exigem assinatura RSA e não podem ser excluídas. O webhook chega em form-urlencoded, sem HMAC, vindo de um IP fixo. Se os splits somarem 100%, a iugu ignora o split.
- Asaas: calcula o split sobre o valor líquido (depois da tarifa) e bloqueia o valor por 2 dias úteis quando há divergência.

## Convenções

- Nomes no código em inglês. Comentários, documentação, mensagens de erro e descrições de teste em português.
- TypeScript estrito, ESM. Imports relativos com a extensão `.js`.
- Testes ao lado do código (`*.test.ts`). Regras de dinheiro também têm testes de propriedade com fast-check.
- Interfaces de armazenamento e de parceiro são assíncronas, mesmo nas versões em memória.
- Use só chaves de sandbox. Nunca leia `.env` nem a pasta `secrets/`.
- Mudanças em `src/split`, `src/ledger` e no tratamento de avisos precisam de revisão humana antes do merge.

## Comandos

- `npm run check`: checagem de tipos e testes. Rode antes de cada commit.
- `npm test`: só os testes.
- `npm run typecheck`: só a checagem de tipos.
