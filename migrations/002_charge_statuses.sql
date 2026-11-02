-- Novos status da cobrança: vencida (expired), cancelada (canceled) e
-- recusada (failed), além de em aberto (pending) e paga (paid).

ALTER TABLE charges DROP CONSTRAINT charges_status_check;
ALTER TABLE charges ADD CONSTRAINT charges_status_check
  CHECK (status IN ('pending', 'paid', 'expired', 'canceled', 'failed'));

-- Regras de mudança de status, garantidas pelo banco:
-- - cobrança paga não muda mais de status;
-- - vencida, cancelada ou recusada só pode passar a paga (pagamento atrasado
--   que o parceiro ainda aceitou), nunca voltar a ficar em aberto.
CREATE OR REPLACE FUNCTION charges_guard() RETURNS trigger
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
    RAISE EXCEPTION 'A cobrança % já foi paga e não pode mudar de status.', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('expired', 'canceled', 'failed') AND NEW.status NOT IN (OLD.status, 'paid') THEN
    RAISE EXCEPTION 'A cobrança % está encerrada (%) e só pode passar a paga.', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
