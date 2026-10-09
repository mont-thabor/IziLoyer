-- V006__fonctions_triggers.sql

-- ============ 1. updated_at automatique ============
CREATE OR REPLACE FUNCTION izl_fn_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
 $$;

CREATE TRIGGER izl_tg_user_updated_at        BEFORE UPDATE ON izl_t_user                FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_site_updated_at        BEFORE UPDATE ON izl_t_site                FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_local_updated_at       BEFORE UPDATE ON izl_t_local               FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_lease_updated_at       BEFORE UPDATE ON izl_t_lease               FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_installment_updated_at BEFORE UPDATE ON izl_t_installment         FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_owa_updated_at         BEFORE UPDATE ON izl_t_owner_wave_account  FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_cs_updated_at          BEFORE UPDATE ON izl_t_checkout_session    FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_tv_updated_at          BEFORE UPDATE ON izl_t_transfer_verification FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_payment_updated_at     BEFORE UPDATE ON izl_t_payment             FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_deposit_updated_at     BEFORE UPDATE ON izl_t_security_deposit    FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_receipt_updated_at     BEFORE UPDATE ON izl_t_receipt             FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();

-- ============ 2. statut_paiement dérivé des montants (jamais saisi) ============
CREATE OR REPLACE FUNCTION izl_fn_installment_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  NEW.statut_paiement := CASE
    WHEN NEW.montant_percu >= NEW.montant_du THEN 'PAYE'::izl_typ_payment_status
    WHEN NEW.montant_percu > 0               THEN 'PARTIEL'::izl_typ_payment_status
    ELSE 'EN_ATTENTE'::izl_typ_payment_status
  END;
  RETURN NEW;
END;
 $$;
CREATE TRIGGER izl_tg_installment_status
  BEFORE INSERT OR UPDATE OF montant_du, montant_percu ON izl_t_installment
  FOR EACH ROW EXECUTE FUNCTION izl_fn_installment_status();

-- ============ 3. numéro séquentiel de quittance (par bail, anti-concurrence) ============
CREATE OR REPLACE FUNCTION izl_fn_next_receipt_seq() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  UPDATE izl_t_lease
     SET receipt_seq = receipt_seq + 1
   WHERE id = NEW.lease_id
  RETURNING receipt_seq INTO NEW.numero_sequence;
  RETURN NEW;
END;
 $$;
CREATE TRIGGER izl_tg_receipt_sequence
  BEFORE INSERT ON izl_t_receipt
  FOR EACH ROW WHEN (NEW.numero_sequence IS NULL)
  EXECUTE FUNCTION izl_fn_next_receipt_seq();

-- ============ 4. garde-fous quittance ↔ allocation / paiement / caution ============
CREATE OR REPLACE FUNCTION izl_fn_receipt_guards() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE
  v_installment_id bigint;
  v_lease_id       bigint;
  v_statut         izl_typ_payment_status;
BEGIN
  IF NEW.type IN ('ACOMPTE','SOLDE') THEN
    SELECT a.installment_id, p.lease_id, i.statut_paiement
      INTO v_installment_id, v_lease_id, v_statut
      FROM izl_t_payment_allocation a
      JOIN izl_t_payment     p ON p.id  = a.payment_id
      JOIN izl_t_installment i ON i.id  = a.installment_id
     WHERE a.id = NEW.allocation_id;
    IF v_installment_id IS NULL THEN
      RAISE EXCEPTION 'Quittance % : allocation % introuvable', NEW.type, NEW.allocation_id;
    END IF;
    IF NEW.installment_id IS DISTINCT FROM v_installment_id
       OR NEW.lease_id IS DISTINCT FROM v_lease_id THEN
      RAISE EXCEPTION 'Quittance % : incoherence allocation / echeance / bail', NEW.type;
    END IF;
    IF NEW.type = 'SOLDE'   AND v_statut <> 'PAYE'    THEN
      RAISE EXCEPTION 'Quittance SOLDE : echeance non soldee (statut=%)', v_statut;
    END IF;
    IF NEW.type = 'ACOMPTE' AND v_statut <> 'PARTIEL' THEN
      RAISE EXCEPTION 'Quittance ACOMPTE : echeance non partielle (statut=%)', v_statut;
    END IF;
  ELSIF NEW.type = 'AVANCE' THEN
    SELECT lease_id INTO v_lease_id FROM izl_t_payment WHERE id = NEW.payment_id;
    IF v_lease_id IS NULL OR NEW.lease_id IS DISTINCT FROM v_lease_id THEN
      RAISE EXCEPTION 'Quittance AVANCE : incoherence paiement / bail';
    END IF;
    IF NEW.installment_id IS NOT NULL OR NEW.allocation_id IS NOT NULL THEN
      RAISE EXCEPTION 'Quittance AVANCE : ni mois ni allocation rattachables';
    END IF;
  ELSE -- CAUTION
    SELECT lease_id INTO v_lease_id FROM izl_t_security_deposit WHERE id = NEW.deposit_id;
    IF v_lease_id IS NULL OR NEW.lease_id IS DISTINCT FROM v_lease_id THEN
      RAISE EXCEPTION 'Recu de caution : incoherence depot / bail';
    END IF;
  END IF;
  RETURN NEW;
END;
 $$;
CREATE TRIGGER izl_tg_receipt_guards
  BEFORE INSERT ON izl_t_receipt
  FOR EACH ROW EXECUTE FUNCTION izl_fn_receipt_guards();

-- ============ 5. WaveEvent append-only (seul traite est modifiable) ============
CREATE OR REPLACE FUNCTION izl_fn_wave_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'izl_t_wave_event est en append-only : suppression interdite (id=%)', OLD.id;
  END IF;
  IF (NEW.transaction_id, NEW.event_type, NEW.source, NEW.statut_brut,
      NEW.montant_brut, NEW.payload, NEW.date_reception)
     IS DISTINCT FROM
     (OLD.transaction_id, OLD.event_type, OLD.source, OLD.statut_brut,
      OLD.montant_brut, OLD.payload, OLD.date_reception) THEN
    RAISE EXCEPTION 'izl_t_wave_event est en append-only : seul le champ traite est modifiable (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
 $$;
CREATE TRIGGER izl_tg_wave_event_immutable
  BEFORE UPDATE OR DELETE ON izl_t_wave_event
  FOR EACH ROW EXECUTE FUNCTION izl_fn_wave_event_immutable();

-- ============ 6. allocations : cohérence de bail + plafond PAIEMENT ============
CREATE OR REPLACE FUNCTION izl_fn_allocation_guards() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE
  v_voie   izl_typ_payment_channel;
  v_please bigint;
  v_ilease bigint;
  v_montant bigint;
  v_deja   bigint;
BEGIN
  SELECT lease_id INTO v_please FROM izl_t_payment     WHERE id = NEW.payment_id;
  SELECT lease_id INTO v_ilease FROM izl_t_installment WHERE id = NEW.installment_id;
  IF v_please IS NULL OR v_ilease IS NULL OR v_please <> v_ilease THEN
    RAISE EXCEPTION 'Allocation : paiement % et echeance % de baux differents',
      NEW.payment_id, NEW.installment_id;
  END IF;
  IF NEW.source = 'PAIEMENT' THEN
    SELECT voie, montant INTO v_voie, v_montant FROM izl_t_payment WHERE id = NEW.payment_id;
    IF v_voie = 'OUVERTURE' THEN
      RAISE EXCEPTION 'Allocation PAIEMENT interdite depuis un paiement d''ouverture (avoir)';
    END IF;
    SELECT COALESCE(sum(montant), 0) INTO v_deja
      FROM izl_t_payment_allocation
     WHERE payment_id = NEW.payment_id AND source = 'PAIEMENT';
    IF v_deja + NEW.montant > v_montant THEN
      RAISE EXCEPTION 'Allocation PAIEMENT : % FCFA alloues au total pour un paiement de % FCFA',
        v_deja + NEW.montant, v_montant;
    END IF;
  END IF;
  RETURN NEW;
END;
 $$;
CREATE TRIGGER izl_tg_allocation_guards
  BEFORE INSERT ON izl_t_payment_allocation
  FOR EACH ROW EXECUTE FUNCTION izl_fn_allocation_guards();

-- ============ 7. allocations & remboursements : append-only ============
CREATE OR REPLACE FUNCTION izl_fn_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION '% est en append-only : operation % interdite (id=%)',
    TG_TABLE_NAME, TG_OP, COALESCE(OLD.id, NEW.id);
END;
 $$;
CREATE TRIGGER izl_tg_allocation_immuable BEFORE UPDATE OR DELETE ON izl_t_payment_allocation
  FOR EACH ROW EXECUTE FUNCTION izl_fn_append_only();
CREATE TRIGGER izl_tg_refund_immuable    BEFORE UPDATE OR DELETE ON izl_t_credit_refund
  FOR EACH ROW EXECUTE FUNCTION izl_fn_append_only();

-- ============ 8. invariant du crédit (STD §3), vérifié AU COMMIT ============
-- excedent_initial = excedent_restant + SUM(allocations CREDIT) + SUM(remboursements)
CREATE OR REPLACE FUNCTION izl_fn_check_credit_invariant(p_payment_id bigint) RETURNS void LANGUAGE plpgsql AS $$ DECLARE
  v_ini bigint; v_rest bigint; v_credit bigint; v_refund bigint;
BEGIN
  SELECT excedent_initial, excedent_restant INTO v_ini, v_rest
    FROM izl_t_payment WHERE id = p_payment_id;
  SELECT COALESCE(sum(montant), 0) INTO v_credit
    FROM izl_t_payment_allocation
   WHERE payment_id = p_payment_id AND source = 'CREDIT';
  SELECT COALESCE(sum(montant), 0) INTO v_refund
    FROM izl_t_credit_refund WHERE payment_id = p_payment_id;
  IF (v_ini - v_rest) <> (v_credit + v_refund) THEN
    RAISE EXCEPTION 'Invariant credit viole (paiement %) : initial-restant (%) <> allocations CREDIT + remboursements (%)',
      p_payment_id, v_ini - v_rest, v_credit + v_refund;
  END IF;
END;
 $$;

CREATE OR REPLACE FUNCTION izl_fn_credit_invariant_alloc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM izl_fn_check_credit_invariant(NEW.payment_id);
  RETURN NULL;
END;
 $$;
CREATE OR REPLACE FUNCTION izl_fn_credit_invariant_refund() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM izl_fn_check_credit_invariant(NEW.payment_id);
  RETURN NULL;
END;
 $$;

-- DEFERRABLE : l'application peut decrementer excedent_restant apres l'INSERT
-- dans la meme transaction ; la coherence est exigee au COMMIT.
CREATE CONSTRAINT TRIGGER izl_tg_allocation_credit_invariant
  AFTER INSERT ON izl_t_payment_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source = 'CREDIT')
  EXECUTE FUNCTION izl_fn_credit_invariant_alloc();

CREATE CONSTRAINT TRIGGER izl_tg_refund_credit_invariant
  AFTER INSERT ON izl_t_credit_refund
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION izl_fn_credit_invariant_refund();

-- ============ 9. double partie : SUM(allocations) = montant_percu (au COMMIT) ============
CREATE OR REPLACE FUNCTION izl_fn_check_installment_coherence(p_installment_id bigint) RETURNS void LANGUAGE plpgsql AS $$ DECLARE
  v_percu bigint; v_alloc bigint;
BEGIN
  SELECT montant_percu INTO v_percu FROM izl_t_installment WHERE id = p_installment_id;
  SELECT COALESCE(sum(montant), 0) INTO v_alloc
    FROM izl_t_payment_allocation WHERE installment_id = p_installment_id;
  IF v_percu <> v_alloc THEN
    RAISE EXCEPTION 'Coherence violee (echeance %) : montant_percu (%) <> somme des allocations (%)',
      p_installment_id, v_percu, v_alloc;
  END IF;
END;
 $$;
CREATE OR REPLACE FUNCTION izl_fn_coherence_alloc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM izl_fn_check_installment_coherence(NEW.installment_id);
  RETURN NULL;
END;
 $$;
CREATE CONSTRAINT TRIGGER izl_tg_allocation_coherence
  AFTER INSERT ON izl_t_payment_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION izl_fn_coherence_alloc();

-- ============ 10. maintenance ============
CREATE OR REPLACE FUNCTION izl_fn_purge_otp() RETURNS integer LANGUAGE plpgsql AS $$ DECLARE v_rows integer;
BEGIN
  DELETE FROM izl_t_otp_code WHERE expires_at < now() - interval '24 hours';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
 $$;
COMMENT ON FUNCTION izl_fn_purge_otp IS 'A programmer (pg_cron ou job applicatif quotidien) : purge des OTP expirés.';