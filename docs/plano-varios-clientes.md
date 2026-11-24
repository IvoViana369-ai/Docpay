# Plano: o DocPay para vários clientes

Pedido de Ivo (24/11/2026): "Além de usar o DocPay na Docline como teste, eu quero rentabilizar isso, eu quero vender esse serviço." Os clientes pensados são outras ARs, clínicas e qualquer empresa que precise dividir valores.

Este plano é uma proposta para Ivo decidir. Nada aqui foi construído ainda.

## Onde estamos

Hoje o DocPay atende um cliente só, a Docline. Tudo o que é de um cliente fica nas variáveis do Render:

- **uma chave de acesso:** `DOCPAY_API_KEY`;
- **uma conta da Safe2Pay:** `SAFE2PAY_API_KEY`, `SAFE2PAY_MAIN_ACCOUNT` e as tarifas;
- **um endereço de aviso:** `DOCPAY_NOTIFY_URL` e `DOCPAY_NOTIFY_SECRET`.

O núcleo já é genérico:

- conta, pagador, cobrança e regra de divisão;
- o razão em partidas dobradas e a conciliação;
- o parceiro trocável;
- a API que qualquer sistema pode usar.

O que falta é separar os clientes e dar uma tela para eles.

## O que não muda

- **Cada cliente tem a própria conta num parceiro autorizado** (Safe2Pay, iugu ou Asaas), no CNPJ dele. O parceiro faz o cadastro e a verificação da empresa.
- **O DocPay nunca recebe nem guarda o dinheiro dos clientes.** O dinheiro entra na conta do cliente no parceiro, é dividido ali e sai para os recebedores.
- **O beneficiário de cada cobrança é o cliente,** nunca o DocPay. A exceção é a mensalidade do próprio DocPay (etapa 5).
- **As regras de dinheiro continuam as mesmas,** no código e no banco: centavos inteiros, divisão exata, razão imutável e idempotência.

## As etapas

O tamanho é comparativo. **Grande** mexe no banco, em quase todo o código e nos testes. **Médio** é uma parte nova, que usa o que já existe. **Pequeno** é um acréscimo.

### Etapa 1: vários clientes no mesmo DocPay (a base). Tamanho: grande

- **Cadastro de clientes,** com nome, CNPJ e situação (ativo ou suspenso).
- **Cada registro passa a ter o seu cliente:** cobranças, contas, lançamentos do razão, reservas de chave e avisos recebidos.
  - As chaves de idempotência passam a valer dentro de cada cliente.
  - O próprio banco garante que um cliente nunca lê nem grava dados de outro, com restrições, gatilhos e segurança por linha do PostgreSQL. É a mesma lógica das regras de dinheiro.
- **Chave de acesso por cliente:**
  - guardada só como resumo, nunca a chave em si;
  - dá para criar, trocar e revogar a de um cliente sem afetar os outros.
- **Credenciais do parceiro por cliente:**
  - o token da Safe2Pay de cada um fica cifrado no banco, com uma chave-mestra que fica só no Render;
  - as tarifas, a conta principal e o ambiente (teste ou produção) também passam a ser de cada cliente.
- **Aviso do parceiro com o cliente no endereço,** cada um com a chave do aviso dele.
- **Aviso ao sistema do cliente:** endereço e segredo de cada um.
- **A conciliação passa por todos os clientes.**
- **A Docline vira o cliente nº 1 sem perceber.** Os dados de hoje passam a ser dela, e a chave atual continua valendo.
- **Uma ferramenta de administração** para cadastrar cliente, gerar a chave e registrar as credenciais. Ela funciona antes de existir o painel.
- **Testes:** cada teste passa a rodar com dois clientes, para provar que um não enxerga o outro.

### Etapa 2: painel com login. Tamanho: médio a grande

- **Login de pessoas,** com e-mail, senha e verificação em duas etapas. Há três perfis:
  - o administrador do DocPay (Ivo);
  - o administrador do cliente;
  - o perfil de consulta.
- **Telas do cliente:**
  - cobranças, com filtros e status;
  - cada cobrança com a divisão prevista e a executada;
  - o extrato de cada recebedor;
  - as diferenças encontradas;
  - os avisos que falharam;
  - as configurações (chaves e endereço de aviso);
  - exportar em CSV e Excel.
- **Telas do administrador:** a lista de clientes e o volume de cada um no mês, que é a base da mensalidade.

### Etapa 3: tela para quem não tem sistema. Tamanho: médio

Uma clínica pequena não vai integrar uma API. Para ela, a etapa 3 traz:

- o cadastro dos recebedores, com a subconta de cada um no parceiro;
- modelos de divisão. Exemplo: "consulta: 70% para o médico, 30% para a clínica";
- a cobrança (boleto ou Pix) ou o link de pagamento gerado pela tela, enviado ao pagador por WhatsApp ou e-mail;
- a página de pagamento para o pagador, como a fatura do DocLine, com o QR e o copia e cola.

### Etapa 4: outros parceiros. Tamanho: médio, cada um

- **iugu e Asaas,** com as armadilhas que já estão anotadas no `CLAUDE.md`:
  - a iugu ignora o split que soma 100%;
  - o Asaas divide sobre o valor líquido.
- Com isso, o cliente usa a conta que já tem, sem precisar abrir outra.

### Etapa 5: a cobrança do próprio DocPay. Tamanho: pequeno a médio

- A contagem de uso de cada cliente no mês.
- Os planos, por faixa de volume.
- A fatura mensal emitida pela conta da empresa do DocPay num parceiro, como qualquer empresa. Nesse caso, o DocPay é o credor só da própria mensalidade.
- A nota fiscal de serviço, combinada com o contador.

## Em paralelo, com Ivo (não é código)

- **Advogado de pagamentos:**
  - confirmar o modelo de mensalidade;
  - avaliar se dá para cobrar um percentual de cada cobrança pela própria divisão (Resolução Conjunta 16/2025);
  - o contrato com os clientes: termos de uso, responsabilidades e LGPD. O DocPay trata os dados dos pagadores como operador, em nome do cliente.
- **Contador:**
  - a empresa do DocPay, com CNPJ próprio ou dentro da Docline Tecnologia;
  - a atividade de software;
  - as notas fiscais.
- **Preços:** a mensalidade por faixa de cobranças por mês, com os valores ainda a definir.
- **Parceiros:** perguntar à Safe2Pay, à iugu e ao Asaas se eles têm programa de parceria para plataformas que trazem clientes.
- **Apresentação:** nome, domínio e uma página para mostrar o produto.

## Ordem sugerida

1. Terminar o piloto da Docline com dinheiro de verdade, que é a prova de que funciona.
2. Fazer a etapa 1.
3. Fazer a etapa 2.
4. Conseguir o primeiro cliente de fora. A sugestão é outra AR, o caso mais parecido com o da Docline.
5. Fazer as etapas 3, 4 e 5 conforme os clientes pedirem.

## Decisões que são de Ivo

1. O primeiro cliente de fora é outra AR ou uma clínica?
2. O modelo de cobrança é a mensalidade, que é segura, ou o percentual, que precisa do parecer?
3. A empresa do DocPay tem CNPJ próprio ou fica dentro da Docline Tecnologia?
4. Para as ARs, vale vender também o DocLine com o DocPay dentro?
5. Com vários clientes, o plano do banco e do serviço no Render cresce. Qual é o limite de custo no começo?
