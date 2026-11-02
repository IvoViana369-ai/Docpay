-- Reserva da chave de idempotência enquanto o DocPay fala com o parceiro.
-- Alguns parceiros (como a Safe2Pay) não reconhecem a chave: sem a reserva,
-- duas chamadas ao mesmo tempo criariam duas cobranças. A reserva some quando
-- a cobrança é gravada ou o parceiro recusa.

CREATE TABLE charge_claims (
  idempotency_key text PRIMARY KEY,
  fingerprint text NOT NULL,
  claimed_at timestamptz NOT NULL
);
