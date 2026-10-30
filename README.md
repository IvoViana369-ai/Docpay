# DocPay

Cobrança com divisão de pagamentos (split) para sistemas de gestão. O primeiro sistema a usar o DocPay é o DocLine Gestão 360.

O DocPay é só software. Ele calcula a divisão, emite as cobranças pela API de um parceiro autorizado pelo Banco Central, registra tudo numa contabilidade interna e confere os números com o parceiro. O dinheiro nunca passa pelo DocPay.

## Situação

- [x] Motor de divisão (`src/split`)
- [x] Razão contábil (`src/ledger`)
- [x] Parceiro simulado (`src/providers`)
- [x] Fluxo de cobrança: emissão, aviso de pagamento e baixa (`src/charges`)
- [x] PostgreSQL, com as regras também garantidas pelo banco (`src/db`, `migrations/`)
- [x] Conciliação das cobranças em aberto (falta agendar a execução diária)
- [ ] API para o DocLine
- [ ] Parceiro real (depende da cotação)

## Como rodar

É preciso ter o Node.js 22.12 ou mais novo. Não é preciso instalar banco de dados para os testes: eles usam o PGlite, um PostgreSQL que roda dentro do processo.

```sh
npm install
npm run check
```

Para rodar os testes contra um servidor PostgreSQL de verdade, como o CI faz:

```sh
DATABASE_URL=postgres://usuario:senha@localhost:5432/banco npm test
```

Cada teste cria e apaga um schema próprio nesse banco.

## Documentação

- [Arquitetura](docs/arquitetura.md): as peças, o caminho de uma cobrança e as decisões em aberto.
- [CLAUDE.md](CLAUDE.md): regras do projeto, para pessoas e para o Claude Code.
