-- V007__vues.sql

-- Dette cumulée par bail. "reports" = échéances dont le mois (ou, pour une
-- créance REPRISE, la date limite) est antérieur au mois courant (Africa/Abidjan).
CREATE OR REPLACE VIEW izl_v_lease_debt AS
SELECT
  lease_id,
  COALESCE(sum(montant_du - montant_percu), 0)  AS dette_totale,
  COALESCE(sum(montant_du - montant_percu) FILTER (
    WHERE COALESCE(mois, date_echeance) < date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan')::date
  ), 0)                                         AS dont_reports,
  count(*) FILTER (WHERE montant_du > montant_percu) AS nb_echeances_ouvertes,
  bool_or(est_en_retard AND montant_du > montant_percu) AS a_un_retard
FROM izl_t_installment
GROUP BY lease_id;

-- Solde créditeur (avoir) par bail + équivalent en loyers (SMS d'avoir, SFD-04 §4.10).
CREATE OR REPLACE VIEW izl_v_lease_credit AS
SELECT
  l.id AS lease_id,
  COALESCE(sum(p.excedent_restant), 0)                                AS solde_crediteur,
  floor(COALESCE(sum(p.excedent_restant), 0) / l.loyer_mensuel)::int  AS nb_loyers_equivalents,
  COALESCE(sum(p.excedent_restant), 0) % l.loyer_mensuel              AS reste_fcfa
FROM izl_t_lease l
LEFT JOIN izl_t_payment p ON p.lease_id = l.id
GROUP BY l.id, l.loyer_mensuel;

-- Liste du tableau de bord bailleur (SFD-05) : échéances enrichies.
CREATE OR REPLACE VIEW izl_v_installments_dashboard AS
SELECT
  i.id                           AS installment_id,
  i.lease_id,
  i.type,
  i.mois,
  i.libelle,
  i.montant_du,
  i.montant_percu,
  i.montant_du - i.montant_percu AS reste_du,
  i.statut_paiement,
  i.est_en_retard,
  i.date_echeance,
  (COALESCE(i.mois, i.date_echeance) < date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan')::date
     AND i.montant_du > i.montant_percu) AS fait_partie_des_reports,
  lo.designation                 AS local_designation,
  lo.type                        AS local_type,
  st.nom                         AS site_nom,
  st.commune,
  st.ville,
  st.proprietaire_id,
  u.nom                          AS locataire_nom,
  u.prenoms                      AS locataire_prenoms,
  u.telephone                    AS locataire_telephone
FROM izl_t_installment i
JOIN izl_t_lease l  ON l.id  = i.lease_id
JOIN izl_t_local lo ON lo.id = l.local_id
JOIN izl_t_site  st ON st.id = lo.site_id
JOIN izl_t_user  u  ON u.id  = l.locataire_id;

-- KPI du mois courant par propriétaire (SFD-05) : versements Wave vs « réglé par crédit » (D13).
CREATE OR REPLACE VIEW izl_v_owner_month_kpis AS
WITH debut_mois AS (
  SELECT date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan')::date AS d
),
per_lease_cash AS (
  SELECT p.lease_id, sum(p.montant) AS total_percu
  FROM izl_t_payment p CROSS JOIN debut_mois m
  WHERE p.voie IN ('A','B')
    AND (p.date_paiement AT TIME ZONE 'Africa/Abidjan') >= m.d
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
  COALESCE(sum(cr.total_credit), 0) AS regle_par_credit_mois
FROM izl_t_site st
JOIN izl_t_local lo ON lo.site_id = st.id
JOIN izl_t_lease  l ON l.local_id = lo.id
LEFT JOIN per_lease_cash   c  ON c.lease_id  = l.id
LEFT JOIN per_lease_credit cr ON cr.lease_id = l.id
GROUP BY st.proprietaire_id;

-- Cron réconciliation Voie A (toutes les 15 min) : sessions ouvertes sans webhook
-- depuis plus de 15 minutes et pas encore expirées.
CREATE OR REPLACE VIEW izl_v_checkouts_to_reconcile AS
SELECT *
FROM izl_t_checkout_session
WHERE statut = 'OUVERTE'
  AND created_at <= now() - interval '15 minutes'
  AND expires_at  > now();

-- Jobs Voie B prêts à être tentés (alimente les jobs différés pg-boss).
CREATE OR REPLACE VIEW izl_v_verifications_to_retry AS
SELECT *
FROM izl_t_transfer_verification
WHERE statut = 'EN_VERIFICATION'
  AND expire_at > now()
  AND (prochaine_tentative_at IS NULL OR prochaine_tentative_at <= now());