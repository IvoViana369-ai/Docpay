# DocPay

Cobrança com divisão de pagamentos (split) para sistemas de gestão. O primeiro sistema a usar o DocPay é o DocLine Gestão 360.

O DocPay é só software. Ele calcula a divisão, emite as cobranças pela API de um parceiro autorizado pelo Banco Central, registra tudo numa contabilidade interna e confere os números com o parceiro. O dinheiro nunca passa pelo DocPay.

## Situação

- [x] Motor de divisão (`src/split`)
- [x] Razão contábil, por enquanto em memória (`src/ledger`)
- [x] Parceiro simulado (`src/providers`)
- [x] Fluxo de cobrança: emissão, aviso de pagamento e baixa (`src/charges`)
- [ ] Conciliação diária
- [ ] PostgreSQL
- [ ] API para o DocLine
- [ ] Parceiro real (depende da cotação)

## Como rodar

É preciso ter o Node.js 22.12 ou mais novo.

```sh
npm install
npm run check
```

## Documentação

- [Arquitetura](docs/arquitetura.md): as peças, o caminho de uma cobrança e as decisões em aberto.
- [CLAUDE.md](CLAUDE.md): regras do projeto, para pessoas e para o Claude Code.
