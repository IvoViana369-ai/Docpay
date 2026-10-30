-- Razão, cobranças e caixa de avisos.
--
-- O código confere tudo antes de gravar, mas o banco garante as regras de
-- novo, para que um bug não consiga quebrar o razão.

-- Razão ----------------------------------------------------------------------

CREATE TABLE ledger_transactions (
  id text PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  fingerprint text NOT NULL,
  description text NOT NULL CHECK (btrim(description) <> ''),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  posted_at timestamptz NOT NULL
);

CREATE TABLE ledger_entries (
  transaction_id text NOT NULL REFERENCES ledger_transactions (id),
  position integer NOT NULL CHECK (position >= 0),
  account text NOT NULL CHECK (btrim(account) <> ''),
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  memo text,
  PRIMARY KEY (transaction_id, position)
);

CREATE INDEX ledger_entries_by_account ON ledger_entries (account);

-- No fim de cada transação do banco, confere que as partidas de cada
-- lançamento somam zero e movimentam pelo menos duas contas.
CREATE FUNCTION ledger_check_balanced() RETURNS trigger
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  checked_id text;
  total numeric;
  accounts integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_transactions' THEN
    checked_id := NEW.id;
  ELSE
    checked_id := NEW.transaction_id;
  END IF;

  SELECT coalesce(sum(amount_cents), 0), count(DISTINCT account)
    INTO total, accounts
    FROM ledger_entries
   WHERE transaction_id = checked_id;

  IF total <> 0 OR accounts < 2 THEN
    RAISE EXCEPTION 'Lançamento % inválido: as partidas somam % centavo(s) em % conta(s).',
      checked_id, total, accounts
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_transactions_balanced
  AFTER INSERT ON ledger_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();

-- O razão é imutável: correção é um lançamento novo.
CREATE FUNCTION ledger_forbid_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'O razão é imutável: % em % não é permitido.', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_forbid_change();

CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_change();

-- Cobranças ------------------------------------------------------------------

-- O documento guarda a cobrança inteira. As colunas servem para buscar e
-- para o banco garantir as regras, e precisam bater com o documento.
CREATE TABLE charges (
  -- Ordenação byte a byte, igual em qualquer banco e no código.
  id text COLLATE "C" PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  provider text NOT NULL,
  provider_charge_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'paid')),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (provider, provider_charge_id),
  CONSTRAINT charges_document_matches CHECK (
    document ->> 'id' = id
    AND document ->> 'idempotencyKey' = idempotency_key
    AND document ->> 'provider' = provider
    AND document ->> 'providerChargeId' = provider_charge_id
    AND document ->> 'status' = status
  )
);

CREATE INDEX charges_pending ON charges (created_at, id) WHERE status = 'pending';

-- Cobrança não é apagada, não muda de identidade e, depois de paga, não
-- volta a ficar em aberto.
CREATE FUNCTION charges_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cobranças não são apagadas (%).', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.idempotency_key <> OLD.idempotency_key
     OR NEW.provider <> OLD.provider
     OR NEW.provider_charge_id <> OLD.provider_charge_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A identidade da cobrança % não pode mudar.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'paid' AND NEW.status <> 'paid' THEN
    RAISE EXCEPTION 'A cobrança % já foi paga e não pode voltar a ficar em aberto.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER charges_guarded
  BEFORE UPDATE OR DELETE ON charges
  FOR EACH ROW EXECUTE FUNCTION charges_guard();

-- Caixa de avisos ------------------------------------------------------------

-- Cada aviso do parceiro, do jeito que chegou, para auditoria e reprocessamento.
CREATE TABLE webhook_inbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider text NOT NULL,
  body text NOT NULL,
  received_at timestamptz NOT NULL
);
