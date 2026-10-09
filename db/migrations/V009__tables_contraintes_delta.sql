-- V009__tables_contraintes_delta.sql
-- Delta v1.2 : Voie C, abonnements, D23 + corrections d'intégrité.
-- Dépend de V008 (valeurs d'enum committées).

-- =====================================================================
-- 1. D23 : compte Wave du bailleur
-- =====================================================================
UPDATE izl_t_owner_wave_account SET statut = 'A_RECONNECTER' WHERE statut = 'SUSPENDU';

ALTER TABLE izl_t_owner_wave_account
  ADD COLUMN webhook_token            uuid        NOT NULL DEFAULT gen_random_uuid(),  -- /webhooks/wave/:webhook_token (non secret)
  ADD COLUMN derniere_verification_at timestamptz,
  ADD CONSTRAINT izl_uq_owa_webhook_token UNIQUE (webhook_token);

-- =====================================================================
-- 2. WaveEvent : distinction compte bailleur / compte plateforme
-- =====================================================================
ALTER TABLE izl_t_wave_event
  ADD COLUMN compte izl_typ_wave_account_scope NOT NULL DEFAULT 'OWNER';

-- Append-only : `compte` rejoint les colonnes immuables (seul `traite` reste modifiable)
CREATE OR REPLACE FUNCTION izl_fn_wave_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'izl_t_wave_event est en append-only : suppression interdite (id=%)', OLD.id;
  END IF;
  IF (NEW.transaction_id, NEW.event_type, NEW.source, NEW.statut_brut,
      NEW.montant_brut, NEW.payload, NEW.date_reception, NEW.compte)
     IS DISTINCT FROM
     (OLD.transaction_id, OLD.event_type, OLD.source, OLD.statut_brut,
      OLD.montant_brut, OLD.payload, OLD.date_reception, OLD.compte) THEN
    RAISE EXCEPTION 'izl_t_wave_event est en append-only : seul le champ traite est modifiable (id=%)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

-- =====================================================================
-- 3. Sessions de checkout et vérifications Voie B : objet LOYER / ABONNEMENT
-- =====================================================================
ALTER TABLE izl_t_checkout_session
  ALTER COLUMN lease_id DROP NOT NULL,
  ADD COLUMN objet    izl_typ_checkout_object NOT NULL DEFAULT 'LOYER',
  ADD COLUMN owner_id bigint,
  ADD CONSTRAINT izl_fk_cs_owner  FOREIGN KEY (owner_id) REFERENCES izl_t_user (id),
  ADD CONSTRAINT izl_ck_cs_objet  CHECK (
       (objet = 'LOYER'      AND lease_id IS NOT NULL AND owner_id IS NULL)
    OR (objet = 'ABONNEMENT' AND lease_id IS NULL     AND owner_id IS NOT NULL));
-- ⚠️ Une seule session d'abonnement ouverte par bailleur
CREATE UNIQUE INDEX izl_ix_cs_owner_ouverte ON izl_t_checkout_session (owner_id)
  WHERE objet = 'ABONNEMENT' AND statut = 'OUVERTE';

ALTER TABLE izl_t_transfer_verification
  ALTER COLUMN lease_id DROP NOT NULL,
  ADD COLUMN objet    izl_typ_checkout_object NOT NULL DEFAULT 'LOYER',
  ADD COLUMN owner_id bigint,
  ADD CONSTRAINT izl_fk_tv_owner  FOREIGN KEY (owner_id) REFERENCES izl_t_user (id),
  ADD CONSTRAINT izl_ck_tv_objet  CHECK (
       (objet = 'LOYER'      AND lease_id IS NOT NULL AND owner_id IS NULL)
    OR (objet = 'ABONNEMENT' AND lease_id IS NULL     AND owner_id IS NOT NULL));

-- Correction : une référence déclarée ne peut servir qu'une fois (SFD-06 §6.4),
-- sauf si la vérification précédente a été REJETEE (le locataire peut redéclarer).
CREATE UNIQUE INDEX izl_ix_tv_reference_declaree ON izl_t_transfer_verification (reference_declaree)
  WHERE reference_declaree IS NOT NULL AND statut <> 'REJETE';

-- =====================================================================
-- 4. Payment : Voie C (espèces)
-- =====================================================================
ALTER TABLE izl_t_payment
  ADD COLUMN date_remise     date,          -- Voie C : date de remise des fonds
  ADD COLUMN saisi_par       bigint,        -- Voie C et OUVERTURE : le bailleur
  ADD COLUMN idempotency_key varchar(64),   -- Voie C : anti double-soumission
  ADD CONSTRAINT izl_fk_payment_saisi_par FOREIGN KEY (saisi_par) REFERENCES izl_t_user (id);

ALTER TABLE izl_t_payment DROP CONSTRAINT izl_ck_payment_ouverture;
ALTER TABLE izl_t_payment
  ADD CONSTRAINT izl_ck_payment_sans_wave  CHECK ((voie IN ('OUVERTURE','C')) = (wave_event_id IS NULL)),
  ADD CONSTRAINT izl_ck_payment_date_remise CHECK ((voie = 'C') = (date_remise IS NOT NULL)),
  ADD CONSTRAINT izl_ck_payment_saisi_par   CHECK ((voie IN ('OUVERTURE','C')) = (saisi_par IS NOT NULL)),
  ADD CONSTRAINT izl_ck_payment_idem_c      CHECK ((voie = 'C') = (idempotency_key IS NOT NULL));
-- ⚠️ Double soumission d'un paiement en espèces : un seul Payment par (bail, clé)
CREATE UNIQUE INDEX izl_ix_payment_idem_c ON izl_t_payment (lease_id, idempotency_key) WHERE voie = 'C';

-- Garde-fous Voie C / OUVERTURE : saisie par le bailleur du bail ; dates de remise valides
CREATE OR REPLACE FUNCTION izl_fn_payment_declaratif_guards() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE
  v_owner bigint;
  v_prise date;
BEGIN
  SELECT st.proprietaire_id, l.date_prise_effet INTO v_owner, v_prise
    FROM izl_t_lease l
    JOIN izl_t_local lo ON lo.id = l.local_id
    JOIN izl_t_site  st ON st.id = lo.site_id
   WHERE l.id = NEW.lease_id;
  IF v_owner IS NULL OR v_owner IS DISTINCT FROM NEW.saisi_par THEN
    RAISE EXCEPTION 'Paiement % : seul le bailleur du bail peut le declarer', NEW.voie;
  END IF;
  IF NEW.voie = 'C' THEN
    IF NEW.date_remise > (now() AT TIME ZONE 'Africa/Abidjan')::date THEN
      RAISE EXCEPTION 'Paiement en especes : date de remise dans le futur (%)', NEW.date_remise;
    END IF;
    IF NEW.date_remise < v_prise THEN
      RAISE EXCEPTION 'Paiement en especes : date de remise (%) anterieure a la prise d''effet (%)',
        NEW.date_remise, v_prise;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER izl_tg_payment_declaratif_guards
  BEFORE INSERT ON izl_t_payment
  FOR EACH ROW WHEN (NEW.voie IN ('OUVERTURE','C'))
  EXECUTE FUNCTION izl_fn_payment_declaratif_guards();

-- =====================================================================
-- 5. Correction : cohérence des montants d'un paiement (vérifiée au COMMIT)
--    A/B/C : montant = SUM(allocations PAIEMENT) + excedent_initial
--    OUVERTURE : montant = excedent_initial et aucune allocation PAIEMENT
-- =====================================================================
CREATE OR REPLACE FUNCTION izl_fn_check_payment_amount(p_payment_id bigint) RETURNS void LANGUAGE plpgsql AS $$ DECLARE
  v_voie izl_typ_payment_channel; v_montant bigint; v_ini bigint; v_alloc bigint;
BEGIN
  SELECT voie, montant, excedent_initial INTO v_voie, v_montant, v_ini
    FROM izl_t_payment WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(sum(montant), 0) INTO v_alloc
    FROM izl_t_payment_allocation WHERE payment_id = p_payment_id AND source = 'PAIEMENT';
  IF v_voie = 'OUVERTURE' THEN
    IF v_ini <> v_montant OR v_alloc <> 0 THEN
      RAISE EXCEPTION 'Paiement OUVERTURE % : excedent_initial (%) doit egaler le montant (%) sans allocation PAIEMENT (%)',
        p_payment_id, v_ini, v_montant, v_alloc;
    END IF;
  ELSIF v_montant <> v_alloc + v_ini THEN
    RAISE EXCEPTION 'Paiement % : montant (%) <> allocations PAIEMENT (%) + surplus (%)',
      p_payment_id, v_montant, v_alloc, v_ini;
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION izl_fn_payment_amount_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_TABLE_NAME = 'izl_t_payment' THEN
    PERFORM izl_fn_check_payment_amount(NEW.id);
  ELSE
    PERFORM izl_fn_check_payment_amount(NEW.payment_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER izl_tg_payment_amount
  AFTER INSERT ON izl_t_payment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION izl_fn_payment_amount_trg();
CREATE CONSTRAINT TRIGGER izl_tg_allocation_payment_amount
  AFTER INSERT ON izl_t_payment_allocation
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.source = 'PAIEMENT')
  EXECUTE FUNCTION izl_fn_payment_amount_trg();

-- =====================================================================
-- 6. Correction : double partie aussi sur modification directe de montant_percu
-- =====================================================================
CREATE OR REPLACE FUNCTION izl_fn_coherence_installment_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  PERFORM izl_fn_check_installment_coherence(NEW.id);
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER izl_tg_installment_coherence
  AFTER INSERT OR UPDATE OF montant_percu ON izl_t_installment
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION izl_fn_coherence_installment_trg();

-- =====================================================================
-- 7. Correction : une créance REPRISE est toujours saisie par le bailleur
-- =====================================================================
ALTER TABLE izl_t_installment
  ADD CONSTRAINT izl_ck_installment_saisi_par_reprise CHECK (type <> 'REPRISE' OR saisi_par IS NOT NULL);

-- =====================================================================
-- 8. Abonnements (SFD-07)
-- =====================================================================
CREATE TABLE izl_t_platform_wave_account (
  id                      bigint GENERATED BY DEFAULT AS IDENTITY,
  numero_wave             varchar(16) NOT NULL,
  api_key_chiffree        text        NOT NULL,
  api_secret_chiffre      text        NOT NULL,
  webhook_secret_chiffre  text        NOT NULL,       -- signature distincte de celle des bailleurs
  statut                  izl_typ_wave_account_status NOT NULL DEFAULT 'ACTIF',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT izl_pk_pwa           PRIMARY KEY (id),
  CONSTRAINT izl_ck_pwa_telephone CHECK (numero_wave ~ '^\+[0-9]{8,15}$')
);
-- ⚠️ Une seule ligne active
CREATE UNIQUE INDEX izl_ix_pwa_unique_actif ON izl_t_platform_wave_account ((true)) WHERE statut = 'ACTIF';

CREATE TABLE izl_t_subscription_tier (
  code           varchar(20) NOT NULL,
  baux_min       integer     NOT NULL,
  baux_max       integer,                         -- NULL = sans plafond
  tarif_mensuel  bigint      NOT NULL,            -- FCFA entiers
  CONSTRAINT izl_pk_subscription_tier PRIMARY KEY (code),
  CONSTRAINT izl_ck_tier_bornes  CHECK (baux_min >= 1 AND (baux_max IS NULL OR baux_max >= baux_min)),
  CONSTRAINT izl_ck_tier_tarif   CHECK (tarif_mensuel >= 0),
  -- pas de chevauchement de paliers
  CONSTRAINT izl_ex_tier_no_overlap EXCLUDE USING gist
    (int4range(baux_min, COALESCE(baux_max, 2147483647), '[]') WITH &&)
);

CREATE TABLE izl_t_owner_subscription (
  id                bigint GENERATED BY DEFAULT AS IDENTITY,
  owner_id          bigint      NOT NULL,
  statut            izl_typ_subscription_status NOT NULL DEFAULT 'ESSAI',
  essai_fin         date        NOT NULL,         -- created_at du bailleur + 90 jours (Africa/Abidjan = UTC)
  tier_code         varchar(20),
  periode_debut     date,
  periode_fin       date,
  grace_fin         date,
  solde_abonnement  bigint      NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT izl_pk_owner_subscription PRIMARY KEY (id),
  CONSTRAINT izl_uq_os_owner           UNIQUE (owner_id),
  CONSTRAINT izl_fk_os_owner           FOREIGN KEY (owner_id)  REFERENCES izl_t_user (id),
  CONSTRAINT izl_fk_os_tier            FOREIGN KEY (tier_code) REFERENCES izl_t_subscription_tier (code),
  CONSTRAINT izl_ck_os_solde           CHECK (solde_abonnement >= 0),
  CONSTRAINT izl_ck_os_periode         CHECK (periode_fin IS NULL OR periode_debut IS NULL OR periode_fin > periode_debut)
);

CREATE TABLE izl_t_subscription_payment (
  id               bigint GENERATED BY DEFAULT AS IDENTITY,
  owner_id         bigint      NOT NULL,
  voie             izl_typ_subscription_channel NOT NULL,
  wave_event_id    bigint,                         -- NULL ssi voie = C (administrateur)
  montant          bigint      NOT NULL,
  mois_couverts    smallint    NOT NULL,
  periode_debut    date        NOT NULL,
  periode_fin      date        NOT NULL,
  date_reception   timestamptz NOT NULL DEFAULT now(),
  saisi_par        bigint,                         -- administrateur (voie C)
  note             text,
  idempotency_key  varchar(64),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT izl_pk_subscription_payment    PRIMARY KEY (id),
  CONSTRAINT izl_uq_sp_wave_event           UNIQUE (wave_event_id),
  CONSTRAINT izl_uq_sp_owner_periode        UNIQUE (owner_id, periode_debut),      -- une période créditée une seule fois
  CONSTRAINT izl_uq_sp_owner_idem           UNIQUE (owner_id, idempotency_key),
  CONSTRAINT izl_fk_sp_owner                FOREIGN KEY (owner_id)      REFERENCES izl_t_user (id),
  CONSTRAINT izl_fk_sp_wave_event           FOREIGN KEY (wave_event_id) REFERENCES izl_t_wave_event (id),
  CONSTRAINT izl_fk_sp_saisi_par            FOREIGN KEY (saisi_par)     REFERENCES izl_t_user (id),
  CONSTRAINT izl_ck_sp_montant              CHECK (montant > 0),
  CONSTRAINT izl_ck_sp_mois                 CHECK (mois_couverts >= 1),
  CONSTRAINT izl_ck_sp_periode              CHECK (periode_fin > periode_debut),
  CONSTRAINT izl_ck_sp_voie_c_sans_wave     CHECK ((voie = 'C') = (wave_event_id IS NULL)),
  CONSTRAINT izl_ck_sp_voie_c_admin         CHECK ((voie = 'C') = (saisi_par IS NOT NULL)),
  CONSTRAINT izl_ck_sp_voie_c_idem          CHECK (voie <> 'C' OR idempotency_key IS NOT NULL)
);
CREATE INDEX izl_ix_sp_owner ON izl_t_subscription_payment (owner_id, periode_debut DESC);

-- La voie C n'est réservée qu'au rôle ADMIN
CREATE OR REPLACE FUNCTION izl_fn_subscription_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE
  v_role izl_typ_user_role;
BEGIN
  IF NEW.voie = 'C' THEN
    SELECT role INTO v_role FROM izl_t_user WHERE id = NEW.saisi_par;
    IF v_role IS DISTINCT FROM 'ADMIN' THEN
      RAISE EXCEPTION 'Abonnement voie C : reserve au role ADMIN (utilisateur %)', NEW.saisi_par;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER izl_tg_subscription_payment_guard
  BEFORE INSERT ON izl_t_subscription_payment
  FOR EACH ROW EXECUTE FUNCTION izl_fn_subscription_payment_guard();

CREATE TRIGGER izl_tg_subscription_payment_immuable BEFORE UPDATE OR DELETE ON izl_t_subscription_payment
  FOR EACH ROW EXECUTE FUNCTION izl_fn_append_only();

CREATE TRIGGER izl_tg_pwa_updated_at BEFORE UPDATE ON izl_t_platform_wave_account
  FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();
CREATE TRIGGER izl_tg_os_updated_at  BEFORE UPDATE ON izl_t_owner_subscription
  FOR EACH ROW EXECUTE FUNCTION izl_fn_touch_updated_at();

-- =====================================================================
-- 9. Garde-fous de création de bail (D23, D16, critères 27 et 39)
-- =====================================================================
CREATE OR REPLACE FUNCTION izl_fn_lease_guards() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE
  v_owner bigint;
  v_wave  izl_typ_wave_account_status;
  v_sub   izl_typ_subscription_status;
  v_n     integer;
BEGIN
  SELECT st.proprietaire_id INTO v_owner
    FROM izl_t_local lo JOIN izl_t_site st ON st.id = lo.site_id
   WHERE lo.id = NEW.local_id;

  -- D23 : aucun bail sans compte Wave actif du bailleur
  IF TG_OP = 'INSERT' THEN
    SELECT statut INTO v_wave FROM izl_t_owner_wave_account WHERE owner_id = v_owner;
    IF v_wave IS DISTINCT FROM 'ACTIF' THEN
      RAISE EXCEPTION 'Bail refuse : le compte Wave du bailleur % n''est pas actif', v_owner;
    END IF;
  END IF;

  -- D16 : plafond de 3 baux actifs pendant l'essai ; le verrou sérialise les créations concurrentes
  SELECT statut INTO v_sub FROM izl_t_owner_subscription WHERE owner_id = v_owner FOR UPDATE;
  IF FOUND AND v_sub = 'ESSAI' THEN
    SELECT count(*) INTO v_n
      FROM izl_t_lease l
      JOIN izl_t_local lo ON lo.id = l.local_id
      JOIN izl_t_site  st ON st.id = lo.site_id
     WHERE st.proprietaire_id = v_owner AND l.statut = 'ACTIF' AND l.id IS DISTINCT FROM NEW.id;
    IF v_n >= 3 THEN
      RAISE EXCEPTION 'Bail refuse : l''essai est limite a 3 baux actifs';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER izl_tg_lease_guards
  BEFORE INSERT OR UPDATE OF statut ON izl_t_lease
  FOR EACH ROW WHEN (NEW.statut = 'ACTIF')
  EXECUTE FUNCTION izl_fn_lease_guards();
