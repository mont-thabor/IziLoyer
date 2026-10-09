-- V010__vues_seed_delta.sql
-- Delta v1.2 : vues corrigées / ajoutées, grille tarifaire (D17).

-- =====================================================================
-- 0. Correctif de V009 : la borne 2147483647 d'un int4range inclusif déborde
--    (normalisée en 2147483648). On la remplace par une borne sûre.
-- =====================================================================
ALTER TABLE izl_t_subscription_tier DROP CONSTRAINT izl_ex_tier_no_overlap;
ALTER TABLE izl_t_subscription_tier ADD CONSTRAINT izl_ex_tier_no_overlap EXCLUDE USING gist
  (int4range(baux_min, COALESCE(baux_max, 1000000), '[]') WITH &&);

-- =====================================================================
-- 1. Grille tarifaire (SFD-07 §7.2, D17)
-- =====================================================================
INSERT INTO izl_t_subscription_tier (code, baux_min, baux_max, tarif_mensuel) VALUES
  ('STARTER',   1,    1,    0),
  ('T_2_9',     2,    9,    3000),
  ('T_10_19',   10,   19,   5000),
  ('T_20_50',   20,   50,   10000),
  ('T_51_PLUS', 51,   NULL, 25000)
ON CONFLICT (code) DO NOTHING;

-- Palier correspondant à un nombre de baux actifs (NULL si 0)
CREATE OR REPLACE FUNCTION izl_fn_tier_for(p_baux_actifs integer) RETURNS varchar LANGUAGE sql STABLE AS $$
  SELECT code FROM izl_t_subscription_tier
   WHERE p_baux_actifs BETWEEN baux_min AND COALESCE(baux_max, 1000000)
$$;

-- Nombre de baux actifs par bailleur + palier correspondant
CREATE OR REPLACE VIEW izl_v_owner_active_leases AS
SELECT
  st.proprietaire_id                                   AS owner_id,
  count(*) FILTER (WHERE l.statut = 'ACTIF')::int      AS nb_baux_actifs,
  izl_fn_tier_for(count(*) FILTER (WHERE l.statut = 'ACTIF')::int) AS tier_code
FROM izl_t_site st
JOIN izl_t_local lo ON lo.site_id = st.id
JOIN izl_t_lease l  ON l.local_id = lo.id
GROUP BY st.proprietaire_id;

-- =====================================================================
-- 2. Correction : izl_v_lease_debt renvoie une ligne pour TOUT bail (même sans échéance)
-- =====================================================================
CREATE OR REPLACE VIEW izl_v_lease_debt AS
SELECT
  l.id AS lease_id,
  COALESCE(sum(i.montant_du - i.montant_percu), 0)  AS dette_totale,
  COALESCE(sum(i.montant_du - i.montant_percu) FILTER (
    WHERE COALESCE(i.mois, i.date_echeance) < date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan')::date
  ), 0)                                             AS dont_reports,
  count(*) FILTER (WHERE i.montant_du > i.montant_percu) AS nb_echeances_ouvertes,
  COALESCE(bool_or(i.est_en_retard AND i.montant_du > i.montant_percu), false) AS a_un_retard
FROM izl_t_lease l
LEFT JOIN izl_t_installment i ON i.lease_id = l.id
GROUP BY l.id;

-- =====================================================================
-- 3. KPI bailleur : espèces (Voie C) comptées dans le « total perçu » (D22 c),
--    avec une colonne « dont espèces ». Les colonnes existantes gardent leur ordre.
--    Date effective : date de remise pour les espèces, date du paiement sinon.
-- =====================================================================
CREATE OR REPLACE VIEW izl_v_owner_month_kpis AS
WITH debut_mois AS (
  SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan')::date AS d
),
per_lease_cash AS (
  SELECT p.lease_id,
         sum(p.montant)                                        AS total_percu,
         COALESCE(sum(p.montant) FILTER (WHERE p.voie = 'C'), 0) AS total_especes
  FROM izl_t_payment p CROSS JOIN debut_mois m
  WHERE p.voie IN ('A','B','C')
    AND COALESCE(p.date_remise, (p.date_paiement AT TIME ZONE 'Africa/Abidjan')::date) >= m.d
  GROUP BY p.lease_id
),
per_lease_credit AS (
  SELECT i.lease_id, sum(a.montant) AS total_credit
  FROM izl_t_payment_allocation a
  JOIN izl_t_installment i ON i.id = a.installment_id
  CROSS JOIN debut_mois m
  WHERE a.source = 'CREDIT'
    AND (a.created_at AT TIME ZONE 'Africa/Abidjan') >= m.d
  GROUP BY i.lease_id
)
SELECT
  st.proprietaire_id,
  COALESCE(sum(c.total_percu), 0)   AS total_percu_mois,
  COALESCE(sum(cr.total_credit), 0) AS regle_par_credit_mois,
  COALESCE(sum(c.total_especes), 0) AS dont_especes_mois
FROM izl_t_site st
JOIN izl_t_local lo ON lo.site_id = st.id
JOIN izl_t_lease  l ON l.local_id = lo.id
LEFT JOIN per_lease_cash   c  ON c.lease_id  = l.id
LEFT JOIN per_lease_credit cr ON cr.lease_id = l.id
GROUP BY st.proprietaire_id;

-- =====================================================================
-- 4. Réconciliation : « SELECT * » est figé à la création de la vue, il faut la rafraîchir
--    pour exposer objet / owner_id (les nouvelles colonnes sont en fin de table : REPLACE autorisé).
-- =====================================================================
CREATE OR REPLACE VIEW izl_v_checkouts_to_reconcile AS
SELECT *
FROM izl_t_checkout_session
WHERE statut = 'OUVERTE'
  AND created_at <= now() - interval '15 minutes'
  AND expires_at  > now();

CREATE OR REPLACE VIEW izl_v_verifications_to_retry AS
SELECT *
FROM izl_t_transfer_verification
WHERE statut = 'EN_VERIFICATION'
  AND expire_at > now()
  AND (prochaine_tentative_at IS NULL OR prochaine_tentative_at <= now());

-- Correction : sessions OUVERTES mais expirées. Sans clôture, l'index unique partiel
-- (une seule session OUVERTE par bail / par bailleur) bloquerait tout nouveau checkout.
-- Le cron de réconciliation interroge Wave une dernière fois puis passe la session à EXPIREE.
CREATE OR REPLACE VIEW izl_v_checkouts_to_expire AS
SELECT *
FROM izl_t_checkout_session
WHERE statut = 'OUVERTE'
  AND expires_at <= now();

-- Vérifications Voie B arrivées à échéance sans résultat (→ REJETE + SMS)
CREATE OR REPLACE VIEW izl_v_verifications_to_reject AS
SELECT *
FROM izl_t_transfer_verification
WHERE statut = 'EN_VERIFICATION'
  AND expire_at <= now();

-- Quittances à produire au réabonnement (SFD-07 §7.4)
CREATE OR REPLACE VIEW izl_v_receipts_pending_subscription AS
SELECT r.*
FROM izl_t_receipt r
WHERE r.statut_generation = 'EN_ATTENTE_ABONNEMENT';
