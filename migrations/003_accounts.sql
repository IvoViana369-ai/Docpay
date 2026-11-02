-- Contas: quem recebe dinheiro (beneficiário ou destinatário da divisão),
-- com a identificação da subconta em cada parceiro, como
-- {"safe2pay": "123456"} (o Id Receiver da subconta na Safe2Pay).

CREATE TABLE accounts (
  id text COLLATE "C" PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  provider_refs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_refs) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
