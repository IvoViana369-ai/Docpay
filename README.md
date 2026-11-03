# DocPay

Cobrança com divisão de pagamentos (split) para sistemas de gestão. O primeiro sistema a usar o DocPay é o DocLine Gestão 360.

O DocPay é só software. Ele calcula a divisão, emite as cobranças pela API de um parceiro autorizado pelo Banco Central (hoje, a Safe2Pay), registra tudo numa contabilidade interna e confere os números com o parceiro. O dinheiro nunca passa pelo DocPay.

## Situação

- [x] Motor de divisão (`src/split`)
- [x] Razão contábil, com as regras também garantidas pelo banco (`src/ledger`)
- [x] Cadastro de contas com a subconta em cada parceiro (`src/accounts`)
- [x] Fluxo de cobrança: emissão (boleto e Pix), aviso do parceiro, baixa, status e reserva da chave (`src/charges`)
- [x] Parceiros: simulado (teste) e Safe2Pay (`src/providers`)
- [x] API HTTP e aviso assinado ao sistema cliente (`src/server`)
- [x] Conciliação a cada 30 minutos (cron)
- [x] Publicação no Render (`render.yaml`, guia em `docs/RENDER.md`)
- [ ] DocLine ligado ao DocPay: o código está na versão 7.52.0 do DocLine, atrás da chave `PAGAMENTOS_VIA_DOCPAY`; falta aprovar e configurar no Render
- [ ] Primeira cobrança de teste na Safe2Pay (sandbox), pelo DocPay

## Como rodar

É preciso ter o Node.js 22.12 ou mais novo. Os testes não precisam de banco instalado: usam o PGlite, um PostgreSQL que roda dentro do processo.

```sh
npm install
npm run check        # checagem de tipos e testes
```

Contra um servidor PostgreSQL de verdade, como o CI faz:

```sh
DATABASE_URL=postgres://usuario:senha@localhost:5432/banco npm test
```

Para subir a API na própria máquina, com o parceiro simulado:

```sh
npm run build
DATABASE_URL=postgres://usuario:senha@localhost:5432/docpay \
DOCPAY_API_KEY=uma-chave-com-pelo-menos-32-caracteres \
npm start
```

## Documentação

- [Arquitetura](docs/arquitetura.md): as peças, o caminho de uma cobrança, a API e as decisões em aberto.
- [Publicar no Render](docs/RENDER.md): o passo a passo da configuração.
- [CLAUDE.md](CLAUDE.md): regras do projeto, para pessoas e para o Claude Code.
