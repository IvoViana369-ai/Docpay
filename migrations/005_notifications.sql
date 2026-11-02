-- Aviso ao sistema que pediu a cobrança (como o DocLine) quando o status
-- muda. notified_status é o último status avisado: enquanto for diferente de
-- status, falta avisar, e a conciliação tenta de novo.

ALTER TABLE charges ADD COLUMN notified_status text;
UPDATE charges SET notified_status = status;

CREATE INDEX charges_to_notify ON charges (created_at, id) WHERE notified_status IS DISTINCT FROM status;
