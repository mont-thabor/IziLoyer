-- test_invariants.sql : tests des regles d'integrite IziLoyer (migrations V001-V010)
-- Tout s'execute dans UNE transaction annulee a la fin (ROLLBACK) : la base reste propre.
-- Fichier volontairement sans accents (compatibilite terminal Windows).
\set ON_ERROR_STOP on
\pset pager off
BEGIN;

-- ============================ HELPERS ============================
CREATE TEMP TABLE t_results (n serial, test text NOT NULL, ok boolean NOT NULL, detail text);
CREATE TEMP SEQUENCE s_tel;
CREATE TEMP SEQUENCE s_loc;

CREATE FUNCTION pg_temp.rec(p_test text, p_ok boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  INSERT INTO t_results(test, ok, detail) VALUES (p_test, p_ok, p_detail);
$$;

CREATE FUNCTION pg_temp.ok(p_test text, p_cond boolean, p_detail text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  SELECT pg_temp.rec(p_test, COALESCE(p_cond, false), p_detail);
$$;

-- Verdict d'un rejet attendu : XX999 = aucune erreur levee (donc FAIL)
CREATE FUNCTION pg_temp.verdict(p_test text, p_state text, p_msg text, p_expect text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_state = 'XX999' THEN
    PERFORM pg_temp.rec(p_test, false, 'aucun rejet alors qu''un rejet etait attendu');
  ELSIF p_expect IS NOT NULL AND p_state <> p_expect THEN
    PERFORM pg_temp.rec(p_test, false, 'mauvais code ' || p_state || ' : ' || left(p_msg, 150));
  ELSE
    PERFORM pg_temp.rec(p_test, true, left(p_msg, 110));
  END IF;
END $$;

-- Une instruction SQL qui DOIT etre rejetee (contraintes differees verifiees tout de suite)
CREATE FUNCTION pg_temp.expect_fail(p_test text, p_sql text, p_state text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'aucune erreur' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.verdict(p_test, SQLSTATE, SQLERRM, p_state);
  END;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- Une instruction SQL qui DOIT reussir (ses effets sont conserves)
CREATE FUNCTION pg_temp.expect_ok(p_test text, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
    SET CONSTRAINTS ALL IMMEDIATE;
    PERFORM pg_temp.rec(p_test, true);
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.rec(p_test, false, left(SQLERRM, 150));
  END;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- ---------- fabriques de donnees ----------
CREATE FUNCTION pg_temp.mk_user(p_role izl_typ_user_role DEFAULT 'LOCATAIRE') RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO izl_t_user(nom, prenoms, telephone, role)
  VALUES ('Test', 'User', '+22507' || lpad(nextval('s_tel')::text, 8, '0'), p_role) RETURNING id;
$$;

-- p_wave NULL = bailleur SANS compte Wave
CREATE FUNCTION pg_temp.mk_owner(p_wave izl_typ_wave_account_status DEFAULT 'ACTIF') RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  v := pg_temp.mk_user('PROPRIETAIRE');
  IF p_wave IS NOT NULL THEN
    INSERT INTO izl_t_owner_wave_account(owner_id, numero_wave, api_key_chiffree, api_secret_chiffre, webhook_secret_chiffre, statut)
    VALUES (v, '+2250100000000', 'k', 's', 'w', p_wave);
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION pg_temp.mk_local(p_owner bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_site bigint; v_local bigint;
BEGIN
  SELECT id INTO v_site FROM izl_t_site WHERE proprietaire_id = p_owner LIMIT 1;
  IF v_site IS NULL THEN
    INSERT INTO izl_t_site(proprietaire_id, nom, commune) VALUES (p_owner, 'Immeuble T', 'Cocody') RETURNING id INTO v_site;
  END IF;
  INSERT INTO izl_t_local(site_id, designation, type, loyer_mensuel)
  VALUES (v_site, 'L' || nextval('s_loc'), 'Studio', 100000) RETURNING id INTO v_local;
  RETURN v_local;
END $$;

CREATE FUNCTION pg_temp.mk_lease(p_local bigint, p_rent bigint DEFAULT 100000) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO izl_t_lease(local_id, locataire_id, numero_wave, loyer_mensuel, date_prise_effet)
  VALUES (p_local, pg_temp.mk_user('LOCATAIRE'), '+2250500000000', p_rent,
          date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan')::date)
  RETURNING id;
$$;

-- echeance LOYER du mois courant + p_offset mois
CREATE FUNCTION pg_temp.mk_installment(p_lease bigint, p_offset int, p_montant bigint DEFAULT 100000) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO izl_t_installment(lease_id, type, mois, montant_du, date_echeance)
  VALUES (p_lease, 'LOYER',
          (date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan') + make_interval(months => p_offset))::date,
          p_montant,
          (date_trunc('month', now() AT TIME ZONE 'Africa/Abidjan') + make_interval(months => p_offset) + interval '4 days')::date)
  RETURNING id;
$$;

CREATE FUNCTION pg_temp.mk_event(p_tx text, p_montant bigint) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO izl_t_wave_event(transaction_id, event_type, source, statut_brut, montant_brut, payload)
  VALUES (p_tx, 'checkout.session.completed', 'WEBHOOK', 'succeeded', p_montant, '{}'::jsonb) RETURNING id;
$$;

CREATE FUNCTION pg_temp.mk_pay(p_lease bigint, p_event bigint, p_voie izl_typ_payment_channel, p_montant bigint, p_surplus bigint DEFAULT 0) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO izl_t_payment(lease_id, wave_event_id, voie, montant, excedent_initial, excedent_restant)
  VALUES (p_lease, p_event, p_voie, p_montant, p_surplus, p_surplus) RETURNING id;
$$;

CREATE FUNCTION pg_temp.mk_cash(p_lease bigint, p_owner bigint, p_montant bigint, p_surplus bigint, p_key text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO izl_t_payment(lease_id, voie, montant, excedent_initial, excedent_restant, date_remise, saisi_par, idempotency_key)
  VALUES (p_lease, 'C', p_montant, p_surplus, p_surplus, (now() AT TIME ZONE 'Africa/Abidjan')::date, p_owner, p_key)
  RETURNING id;
$$;

CREATE FUNCTION pg_temp.mk_opening(p_lease bigint, p_owner bigint, p_montant bigint) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO izl_t_payment(lease_id, voie, montant, excedent_initial, excedent_restant, saisi_par)
  VALUES (p_lease, 'OUVERTURE', p_montant, p_montant, p_montant, p_owner) RETURNING id;
$$;

-- Allocation d'un paiement a une echeance + incrementation du montant percu
CREATE FUNCTION pg_temp.alloc(p_pay bigint, p_inst bigint, p_montant bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO izl_t_payment_allocation(payment_id, installment_id, montant, source)
  VALUES (p_pay, p_inst, p_montant, 'PAIEMENT') RETURNING id INTO v;
  UPDATE izl_t_installment SET montant_percu = montant_percu + p_montant WHERE id = p_inst;
  RETURN v;
END $$;

-- Application d'un credit : allocation CREDIT + decrement de excedent_restant
CREATE FUNCTION pg_temp.apply_credit(p_pay bigint, p_inst bigint, p_montant bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO izl_t_payment_allocation(payment_id, installment_id, montant, source)
  VALUES (p_pay, p_inst, p_montant, 'CREDIT') RETURNING id INTO v;
  UPDATE izl_t_installment SET montant_percu = montant_percu + p_montant WHERE id = p_inst;
  UPDATE izl_t_payment SET excedent_restant = excedent_restant - p_montant WHERE id = p_pay;
  RETURN v;
END $$;

-- Quittance ACOMPTE ou SOLDE selon le statut de l'echeance
CREATE FUNCTION pg_temp.mk_receipt(p_alloc bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_inst bigint; v_lease bigint; v_stat izl_typ_payment_status; v_id bigint;
BEGIN
  SELECT a.installment_id, i.lease_id, i.statut_paiement INTO v_inst, v_lease, v_stat
    FROM izl_t_payment_allocation a JOIN izl_t_installment i ON i.id = a.installment_id
   WHERE a.id = p_alloc;
  INSERT INTO izl_t_receipt(lease_id, installment_id, allocation_id, type)
  VALUES (v_lease, v_inst, p_alloc, (CASE WHEN v_stat = 'PAYE' THEN 'SOLDE' ELSE 'ACOMPTE' END)::izl_typ_receipt_type)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Paiement Voie B de 100000 + surplus : solde l'echeance (offset) et cree un credit + quittance d'avance
CREATE FUNCTION pg_temp.mk_paid_with_surplus(p_lease bigint, p_tx text, p_offset int, p_surplus bigint) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_i bigint; v_e bigint; v_p bigint; v_a bigint;
BEGIN
  v_i := pg_temp.mk_installment(p_lease, p_offset);
  v_e := pg_temp.mk_event(p_tx, 100000 + p_surplus);
  v_p := pg_temp.mk_pay(p_lease, v_e, 'B', 100000 + p_surplus, p_surplus);
  v_a := pg_temp.alloc(v_p, v_i, 100000);
  PERFORM pg_temp.mk_receipt(v_a);
  INSERT INTO izl_t_receipt(lease_id, payment_id, type) VALUES (p_lease, v_p, 'AVANCE');
  RETURN v_p;
END $$;

-- ============================ TESTS ============================

-- C01 : double livraison d'un webhook -> un seul effet (idempotence, 4 niveaux)
DO $$
DECLARE o bigint; l bigint; ls bigint; i bigint; e bigint; p bigint; a bigint;
BEGIN
  o := pg_temp.mk_owner(); l := pg_temp.mk_local(o); ls := pg_temp.mk_lease(l);
  i := pg_temp.mk_installment(ls, 0);
  e := pg_temp.mk_event('TX-C01', 100000);
  p := pg_temp.mk_pay(ls, e, 'A', 100000);
  a := pg_temp.alloc(p, i, 100000);
  PERFORM pg_temp.mk_receipt(a);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C01a paiement nominal : echeance PAYE',
    (SELECT statut_paiement FROM izl_t_installment WHERE id = i) = 'PAYE');
  PERFORM pg_temp.expect_fail('C01b evenement Wave rejoue refuse (niveau 1)',
    format('INSERT INTO izl_t_wave_event(transaction_id,event_type,source,payload) VALUES (%L,%L,%L,%L)',
           'TX-C01', 'checkout.session.completed', 'WEBHOOK', '{}'), '23505');
  PERFORM pg_temp.expect_fail('C01c second Payment sur le meme evenement refuse (niveau 2)',
    format('INSERT INTO izl_t_payment(lease_id,wave_event_id,voie,montant) VALUES (%s,%s,%L,%s)', ls, e, 'A', 100000), '23505');
  PERFORM pg_temp.expect_fail('C01d seconde allocation du meme paiement a la meme echeance refusee (niveau 3)',
    format('INSERT INTO izl_t_payment_allocation(payment_id,installment_id,montant) VALUES (%s,%s,%s)', p, i, 1000));
  PERFORM pg_temp.expect_fail('C01e seconde quittance sur la meme allocation refusee (niveau 4)',
    format('INSERT INTO izl_t_receipt(lease_id,installment_id,allocation_id,type) VALUES (%s,%s,%s,%L)', ls, i, a, 'SOLDE'), '23505');
END $$;

-- C02 : surplus -> credit, une seule quittance d'avance, credit applique a l'echeance suivante
DO $$
DECLARE o bigint; l bigint; ls bigint; p bigint; p2 bigint; i1 bigint; a bigint;
BEGIN
  o := pg_temp.mk_owner(); l := pg_temp.mk_local(o); ls := pg_temp.mk_lease(l);
  p := pg_temp.mk_paid_with_surplus(ls, 'TX-C02', 0, 20000);
  i1 := pg_temp.mk_installment(ls, 1);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C02a surplus de 20000 conserve en credit',
    (SELECT excedent_restant FROM izl_t_payment WHERE id = p) = 20000);
  PERFORM pg_temp.expect_fail('C02b une seule quittance d''avance par paiement',
    format('INSERT INTO izl_t_receipt(lease_id,payment_id,type) VALUES (%s,%s,%L)', ls, p, 'AVANCE'), '23505');

  a := pg_temp.apply_credit(p, i1, 20000);
  PERFORM pg_temp.mk_receipt(a);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C02c credit applique : restant 0, echeance PARTIEL',
    (SELECT excedent_restant FROM izl_t_payment WHERE id = p) = 0
    AND (SELECT statut_paiement FROM izl_t_installment WHERE id = i1) = 'PARTIEL');
  PERFORM pg_temp.ok('C02c2 KPI : credit hors total percu (D13)',
    (SELECT total_percu_mois = 120000 AND regle_par_credit_mois = 20000
       FROM izl_v_owner_month_kpis WHERE proprietaire_id = o));
  PERFORM pg_temp.expect_fail('C02d excedent_restant negatif refuse',
    format('UPDATE izl_t_payment SET excedent_restant = -1 WHERE id = %s', p), '23514');

  -- credit applique SANS decrementer excedent_restant -> invariant du credit viole
  p2 := pg_temp.mk_paid_with_surplus(ls, 'TX-C02b', 2, 30000);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  BEGIN
    INSERT INTO izl_t_payment_allocation(payment_id, installment_id, montant, source) VALUES (p2, i1, 10000, 'CREDIT');
    UPDATE izl_t_installment SET montant_percu = montant_percu + 10000 WHERE id = i1;
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'aucune erreur' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.verdict('C02e credit applique sans decrementer le restant : invariant viole', SQLSTATE, SQLERRM, 'P0001');
  END;
  SET CONSTRAINTS ALL DEFERRED;
END $$;

-- C03 / C11 : numerotation sequentielle des quittances par bail, sans doublon
DO $$
DECLARE o bigint; l bigint; ls bigint; e bigint; p bigint; i0 bigint; i1 bigint; i2 bigint; a0 bigint;
BEGIN
  o := pg_temp.mk_owner(); l := pg_temp.mk_local(o); ls := pg_temp.mk_lease(l);
  i0 := pg_temp.mk_installment(ls, 0); i1 := pg_temp.mk_installment(ls, 1); i2 := pg_temp.mk_installment(ls, 2);
  e := pg_temp.mk_event('TX-C03', 300000);
  p := pg_temp.mk_pay(ls, e, 'A', 300000);
  a0 := pg_temp.alloc(p, i0, 100000);
  PERFORM pg_temp.mk_receipt(a0);
  PERFORM pg_temp.mk_receipt(pg_temp.alloc(p, i1, 100000));
  PERFORM pg_temp.mk_receipt(pg_temp.alloc(p, i2, 100000));
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C03a un paiement couvre 3 mois : 3 quittances numerotees 1,2,3',
    (SELECT array_agg(numero_sequence ORDER BY numero_sequence) FROM izl_t_receipt WHERE lease_id = ls) = ARRAY[1,2,3]);
  PERFORM pg_temp.expect_fail('C11a numero de quittance en double refuse (par bail)',
    format('INSERT INTO izl_t_receipt(lease_id,payment_id,numero_sequence,type) VALUES (%s,%s,1,%L)', ls, p, 'AVANCE'), '23505');
  PERFORM pg_temp.expect_fail('C03b quittance ACOMPTE sur une echeance soldee refusee',
    format('INSERT INTO izl_t_receipt(lease_id,installment_id,allocation_id,type) VALUES (%s,%s,%s,%L)', ls, i0, a0, 'ACOMPTE'), 'P0001');
END $$;

-- C14 : un seul bail actif par local
DO $$
DECLARE o bigint; l bigint; ls bigint;
BEGIN
  o := pg_temp.mk_owner(); l := pg_temp.mk_local(o); ls := pg_temp.mk_lease(l);
  PERFORM pg_temp.expect_fail('C14a deuxieme bail ACTIF sur le meme local refuse',
    format('INSERT INTO izl_t_lease(local_id,locataire_id,numero_wave,loyer_mensuel,date_prise_effet) VALUES (%s,%s,%L,%s,%L)',
           l, pg_temp.mk_user('LOCATAIRE'), '+2250500000001', 100000, current_date), '23505');
  UPDATE izl_t_lease SET statut = 'RESILIE' WHERE id = ls;
  PERFORM pg_temp.expect_ok('C14b nouveau bail accepte apres resiliation',
    format('SELECT pg_temp.mk_lease(%s)', l));
END $$;

-- C24 : avance d'ouverture (credit d'ouverture, sans transaction Wave)
DO $$
DECLARE o bigint; l bigint; ls bigint; ls2 bigint; ls3 bigint; i0 bigint; p bigint; a bigint; e bigint;
BEGIN
  o := pg_temp.mk_owner(); l := pg_temp.mk_local(o); ls := pg_temp.mk_lease(l);
  ls2 := pg_temp.mk_lease(pg_temp.mk_local(o)); ls3 := pg_temp.mk_lease(pg_temp.mk_local(o));
  e := pg_temp.mk_event('TX-C24', 10000);
  p := pg_temp.mk_opening(ls, o, 60000);
  INSERT INTO izl_t_receipt(lease_id, payment_id, type) VALUES (ls, p, 'AVANCE');
  i0 := pg_temp.mk_installment(ls, 0);
  a := pg_temp.apply_credit(p, i0, 60000);
  PERFORM pg_temp.mk_receipt(a);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C24a avance appliquee a la premiere echeance : percu 60000, credit 0, PARTIEL',
    (SELECT montant_percu = 60000 AND statut_paiement = 'PARTIEL' FROM izl_t_installment WHERE id = i0)
    AND (SELECT excedent_restant FROM izl_t_payment WHERE id = p) = 0);
  PERFORM pg_temp.expect_fail('C24b seconde avance d''ouverture sur le meme bail refusee',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,excedent_initial,excedent_restant,saisi_par) VALUES (%s,%L,5000,5000,5000,%s)', ls, 'OUVERTURE', o), '23505');
  PERFORM pg_temp.expect_fail('C24c avance saisie par un autre que le bailleur refusee',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,excedent_initial,excedent_restant,saisi_par) VALUES (%s,%L,5000,5000,5000,%s)', ls2, 'OUVERTURE', pg_temp.mk_user('LOCATAIRE')), 'P0001');
  PERFORM pg_temp.expect_fail('C24d avance dont excedent_initial <> montant refusee (au commit)',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,saisi_par) VALUES (%s,%L,50000,%s)', ls3, 'OUVERTURE', o), 'P0001');
  PERFORM pg_temp.expect_fail('C24e avance rattachee a un evenement Wave refusee',
    format('INSERT INTO izl_t_payment(lease_id,wave_event_id,voie,montant,excedent_initial,excedent_restant,saisi_par) VALUES (%s,%s,%L,5000,5000,5000,%s)', ls3, e, 'OUVERTURE', o), '23514');
END $$;

-- C27 : plafond de 3 baux actifs pendant l'essai
DO $$
DECLARE o bigint; o2 bigint; l1 bigint; l2 bigint; l3 bigint; l4 bigint; ls1 bigint; k int;
BEGIN
  o := pg_temp.mk_owner();
  INSERT INTO izl_t_owner_subscription(owner_id, statut, essai_fin) VALUES (o, 'ESSAI', current_date + 90);
  l1 := pg_temp.mk_local(o); l2 := pg_temp.mk_local(o); l3 := pg_temp.mk_local(o); l4 := pg_temp.mk_local(o);
  ls1 := pg_temp.mk_lease(l1); PERFORM pg_temp.mk_lease(l2); PERFORM pg_temp.mk_lease(l3);
  PERFORM pg_temp.expect_fail('C27a 4e bail actif refuse pendant l''essai',
    format('SELECT pg_temp.mk_lease(%s)', l4), 'P0001');
  UPDATE izl_t_lease SET statut = 'RESILIE' WHERE id = ls1;
  PERFORM pg_temp.expect_ok('C27b place liberee apres resiliation : nouveau bail accepte',
    format('SELECT pg_temp.mk_lease(%s)', l4));
  -- hors essai : pas de plafond de 3
  o2 := pg_temp.mk_owner();
  INSERT INTO izl_t_owner_subscription(owner_id, statut, essai_fin) VALUES (o2, 'ACTIF', current_date - 1);
  FOR k IN 1..3 LOOP PERFORM pg_temp.mk_lease(pg_temp.mk_local(o2)); END LOOP;
  PERFORM pg_temp.expect_ok('C27c abonnement ACTIF : 4e bail accepte',
    format('SELECT pg_temp.mk_lease(%s)', pg_temp.mk_local(o2)));
END $$;

-- C39 / C40 : compte Wave du bailleur (D23)
DO $$
DECLARE o_none bigint; o_rec bigint; o_ok bigint;
BEGIN
  o_none := pg_temp.mk_owner(NULL);
  o_rec  := pg_temp.mk_owner('A_RECONNECTER');
  o_ok   := pg_temp.mk_owner();
  PERFORM pg_temp.expect_fail('C39a bail refuse sans compte Wave',
    format('SELECT pg_temp.mk_lease(%s)', pg_temp.mk_local(o_none)), 'P0001');
  PERFORM pg_temp.expect_fail('C39b bail refuse si compte Wave A_RECONNECTER',
    format('SELECT pg_temp.mk_lease(%s)', pg_temp.mk_local(o_rec)), 'P0001');
  PERFORM pg_temp.expect_ok('C39c bail accepte avec compte Wave ACTIF',
    format('SELECT pg_temp.mk_lease(%s)', pg_temp.mk_local(o_ok)));
  PERFORM pg_temp.expect_fail('C39d un seul compte Wave par bailleur',
    format('INSERT INTO izl_t_owner_wave_account(owner_id,numero_wave,api_key_chiffree,api_secret_chiffre,webhook_secret_chiffre) VALUES (%s,%L,%L,%L,%L)',
           o_ok, '+2250100000009', 'k', 's', 'w'), '23505');
  PERFORM pg_temp.ok('C40a chaque compte Wave a son propre webhook_token',
    (SELECT count(DISTINCT webhook_token) = count(*) FROM izl_t_owner_wave_account));
END $$;

-- C35 / C36 / C37 : Voie C (especes)
DO $$
DECLARE o bigint; l bigint; ls bigint; i0 bigint; i1 bigint; i2 bigint; p bigint; p2 bigint; p3 bigint; p4 bigint; a bigint; e bigint; prise date;
BEGIN
  o := pg_temp.mk_owner(); l := pg_temp.mk_local(o); ls := pg_temp.mk_lease(l);
  i0 := pg_temp.mk_installment(ls, 0); i1 := pg_temp.mk_installment(ls, 1);
  e := pg_temp.mk_event('TX-C37', 10000);
  SELECT date_prise_effet INTO prise FROM izl_t_lease WHERE id = ls;

  -- C35 : montant <= dette
  p := pg_temp.mk_cash(ls, o, 50000, 0, 'k35');
  a := pg_temp.alloc(p, i0, 50000);
  PERFORM pg_temp.mk_receipt(a);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C35a especes 50000 sur 100000 : PARTIEL, reste 50000',
    (SELECT statut_paiement = 'PARTIEL' AND montant_du - montant_percu = 50000 FROM izl_t_installment WHERE id = i0));
  PERFORM pg_temp.ok('C35b quittance ACOMPTE numero 1 liee a l''allocation',
    EXISTS (SELECT 1 FROM izl_t_receipt WHERE allocation_id = a AND type = 'ACOMPTE' AND numero_sequence = 1));
  p2 := pg_temp.mk_cash(ls, o, 50000, 0, 'k35b');
  PERFORM pg_temp.mk_receipt(pg_temp.alloc(p2, i0, 50000));
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C35c second versement : echeance PAYE',
    (SELECT statut_paiement FROM izl_t_installment WHERE id = i0) = 'PAYE');

  -- C36 : depassement confirme -> avoir
  p3 := pg_temp.mk_cash(ls, o, 150000, 50000, 'k36');
  PERFORM pg_temp.mk_receipt(pg_temp.alloc(p3, i1, 100000));
  INSERT INTO izl_t_receipt(lease_id, payment_id, type) VALUES (ls, p3, 'AVANCE');
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C36a depassement de 50000 converti en avoir avec quittance d''avance',
    (SELECT excedent_restant FROM izl_t_payment WHERE id = p3) = 50000
    AND EXISTS (SELECT 1 FROM izl_t_receipt WHERE payment_id = p3 AND type = 'AVANCE'));
  PERFORM pg_temp.ok('C36b KPI : les especes comptent dans le total percu (D22c)',
    (SELECT total_percu_mois = 250000 AND dont_especes_mois = 250000
       FROM izl_v_owner_month_kpis WHERE proprietaire_id = o));
  BEGIN
    i2 := pg_temp.mk_installment(ls, 2);
    p4 := pg_temp.mk_cash(ls, o, 150000, 0, 'k36b');
    PERFORM pg_temp.alloc(p4, i2, 100000);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'aucune erreur' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.verdict('C36c depassement non converti en avoir : incoherence refusee', SQLSTATE, SQLERRM, 'P0001');
  END;
  SET CONSTRAINTS ALL DEFERRED;

  -- C37 : garde-fous
  PERFORM pg_temp.expect_fail('C37a date de remise future refusee',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,date_remise,saisi_par,idempotency_key) VALUES (%s,%L,10000,%L,%s,%L)',
           ls, 'C', current_date + 1, o, 'k37a'), 'P0001');
  PERFORM pg_temp.expect_fail('C37b date de remise anterieure a la prise d''effet refusee',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,date_remise,saisi_par,idempotency_key) VALUES (%s,%L,10000,%L,%s,%L)',
           ls, 'C', prise - 1, o, 'k37b'), 'P0001');
  PERFORM pg_temp.expect_fail('C37c especes saisies par un autre que le bailleur refusees',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,date_remise,saisi_par,idempotency_key) VALUES (%s,%L,10000,%L,%s,%L)',
           ls, 'C', current_date, pg_temp.mk_user('LOCATAIRE'), 'k37c'), 'P0001');
  PERFORM pg_temp.expect_fail('C37d especes sans cle d''idempotence refusees',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,date_remise,saisi_par) VALUES (%s,%L,10000,%L,%s)',
           ls, 'C', current_date, o), '23514');
  PERFORM pg_temp.expect_fail('C37e especes rattachees a un evenement Wave refusees',
    format('INSERT INTO izl_t_payment(lease_id,wave_event_id,voie,montant,date_remise,saisi_par,idempotency_key) VALUES (%s,%s,%L,10000,%L,%s,%L)',
           ls, e, 'C', current_date, o, 'k37e'), '23514');
  PERFORM pg_temp.expect_fail('C37f double soumission (meme cle) : un seul paiement',
    format('INSERT INTO izl_t_payment(lease_id,voie,montant,date_remise,saisi_par,idempotency_key) VALUES (%s,%L,10000,%L,%s,%L)',
           ls, 'C', current_date, o, 'k35'), '23505');
END $$;

-- C08 / C06 : sessions de checkout et verifications Voie B
DO $$
DECLARE o bigint; ls bigint;
BEGIN
  o := pg_temp.mk_owner(); ls := pg_temp.mk_lease(pg_temp.mk_local(o));
  INSERT INTO izl_t_checkout_session(lease_id, client_reference, montant, statut, expires_at, wave_session_id)
  VALUES (ls, 'CR-1', 50000, 'OUVERTE', now() - interval '1 hour', 'WS-1');
  PERFORM pg_temp.ok('C08a session expiree encore OUVERTE : visible dans izl_v_checkouts_to_expire',
    (SELECT count(*) FROM izl_v_checkouts_to_expire WHERE lease_id = ls) = 1
    AND (SELECT count(*) FROM izl_v_checkouts_to_reconcile WHERE lease_id = ls) = 0);
  PERFORM pg_temp.expect_fail('C08b seconde session OUVERTE sur le meme bail refusee',
    format('INSERT INTO izl_t_checkout_session(lease_id,client_reference,montant,statut,expires_at) VALUES (%s,%L,10000,%L,now()+interval %L)',
           ls, 'CR-2', 'OUVERTE', '30 minutes'), '23505');
  PERFORM pg_temp.expect_ok('C08c session d''abonnement (sans bail, avec bailleur)',
    format('INSERT INTO izl_t_checkout_session(objet,owner_id,client_reference,montant,statut,expires_at) VALUES (%L,%s,%L,3000,%L,now()+interval %L)',
           'ABONNEMENT', o, 'CR-S1', 'OUVERTE', '30 minutes'));
  PERFORM pg_temp.expect_fail('C08d seconde session d''abonnement ouverte refusee',
    format('INSERT INTO izl_t_checkout_session(objet,owner_id,client_reference,montant,statut,expires_at) VALUES (%L,%s,%L,3000,%L,now()+interval %L)',
           'ABONNEMENT', o, 'CR-S2', 'OUVERTE', '30 minutes'), '23505');
  PERFORM pg_temp.expect_fail('C08e session LOYER avec owner_id refusee (CHECK objet)',
    format('INSERT INTO izl_t_checkout_session(lease_id,owner_id,client_reference,montant,statut,expires_at) VALUES (%s,%s,%L,3000,%L,now()+interval %L)',
           ls, o, 'CR-S3', 'EXPIREE', '30 minutes'), '23514');

  INSERT INTO izl_t_transfer_verification(lease_id, montant_declare, reference_declaree, expire_at)
  VALUES (ls, 50000, 'REF-1', now() + interval '24 hours');
  PERFORM pg_temp.expect_fail('C21a reference Voie B deja declaree refusee',
    format('INSERT INTO izl_t_transfer_verification(lease_id,montant_declare,reference_declaree,expire_at) VALUES (%s,50000,%L,now()+interval %L)',
           ls, 'REF-1', '24 hours'), '23505');
  UPDATE izl_t_transfer_verification SET statut = 'REJETE' WHERE reference_declaree = 'REF-1';
  PERFORM pg_temp.expect_ok('C21b reference reutilisable apres un REJETE',
    format('INSERT INTO izl_t_transfer_verification(lease_id,montant_declare,reference_declaree,expire_at) VALUES (%s,50000,%L,now()+interval %L)',
           ls, 'REF-1', '24 hours'));
  INSERT INTO izl_t_transfer_verification(lease_id, montant_declare, wave_transaction_id, expire_at)
  VALUES (ls, 50000, 'WTX-9', now() + interval '24 hours');
  PERFORM pg_temp.expect_fail('C06a meme transaction Wave revendiquee deux fois refusee',
    format('INSERT INTO izl_t_transfer_verification(lease_id,montant_declare,wave_transaction_id,expire_at) VALUES (%s,50000,%L,now()+interval %L)',
           ls, 'WTX-9', '24 hours'), '23505');
END $$;

-- C22 / C25 / C20 / double partie / append-only
DO $$
DECLARE o bigint; l bigint; ls bigint; ls_b bigint; i0 bigint; i1 bigint; ib bigint; e bigint; p bigint; pr bigint; dep bigint;
BEGIN
  o := pg_temp.mk_owner(); l := pg_temp.mk_local(o); ls := pg_temp.mk_lease(l);
  ls_b := pg_temp.mk_lease(pg_temp.mk_local(o));

  -- C22 : creances de reprise
  PERFORM pg_temp.expect_fail('C22a creance de reprise sans saisi_par refusee',
    format('INSERT INTO izl_t_installment(lease_id,type,libelle,montant_du,date_echeance) VALUES (%s,%L,%L,50000,current_date)',
           ls, 'REPRISE', 'Arrieres'), '23514');
  PERFORM pg_temp.expect_ok('C22b premiere creance de reprise acceptee',
    format('INSERT INTO izl_t_installment(lease_id,type,libelle,montant_du,date_echeance,saisi_par) VALUES (%s,%L,%L,50000,current_date,%s)',
           ls, 'REPRISE', 'Arrieres 2025', o));
  PERFORM pg_temp.expect_ok('C22c deuxieme creance de reprise acceptee (mois NULL non unique)',
    format('INSERT INTO izl_t_installment(lease_id,type,libelle,montant_du,date_echeance,saisi_par) VALUES (%s,%L,%L,30000,current_date,%s)',
           ls, 'REPRISE', 'Arrieres 2026', o));

  -- double partie
  i0 := pg_temp.mk_installment(ls, 0); i1 := pg_temp.mk_installment(ls, 1);
  ib := pg_temp.mk_installment(ls_b, 0);
  e := pg_temp.mk_event('TX-X01', 100000);
  p := pg_temp.mk_pay(ls, e, 'A', 100000);
  PERFORM pg_temp.alloc(p, i0, 100000);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.expect_fail('X01a montant_percu modifie sans allocation : double partie violee',
    format('UPDATE izl_t_installment SET montant_percu = 10000 WHERE id = %s', i1), 'P0001');
  PERFORM pg_temp.expect_fail('X01b allocation depassant le montant du paiement refusee',
    format('INSERT INTO izl_t_payment_allocation(payment_id,installment_id,montant) VALUES (%s,%s,1)', p, i1), 'P0001');
  PERFORM pg_temp.expect_fail('X01c allocation vers l''echeance d''un autre bail refusee',
    format('INSERT INTO izl_t_payment_allocation(payment_id,installment_id,montant) VALUES (%s,%s,1)', p, ib), 'P0001');
  PERFORM pg_temp.expect_fail('X01d paiement : montant different de allocations + surplus refuse',
    format('INSERT INTO izl_t_payment(lease_id,wave_event_id,voie,montant) VALUES (%s,%s,%L,5000)', ls_b, pg_temp.mk_event('TX-X01b', 5000), 'A'), 'P0001');

  -- WaveEvent append-only
  PERFORM pg_temp.expect_fail('X02a WaveEvent : modification du montant refusee (append-only)',
    format('UPDATE izl_t_wave_event SET montant_brut = 1 WHERE id = %s', e), 'P0001');
  PERFORM pg_temp.expect_fail('X02b WaveEvent : suppression refusee',
    format('DELETE FROM izl_t_wave_event WHERE id = %s', e), 'P0001');
  PERFORM pg_temp.expect_ok('X02c WaveEvent : le champ traite reste modifiable',
    format('UPDATE izl_t_wave_event SET traite = true WHERE id = %s', e));
  PERFORM pg_temp.expect_fail('X02d allocation : modification refusee (append-only)',
    format('UPDATE izl_t_payment_allocation SET montant = 1 WHERE payment_id = %s', p), 'P0001');

  -- C25 : caution
  INSERT INTO izl_t_security_deposit(lease_id, montant, date_reception, mode, saisi_par)
  VALUES (ls, 100000, current_date, 'especes', o) RETURNING id INTO dep;
  INSERT INTO izl_t_receipt(lease_id, deposit_id, type) VALUES (ls, dep, 'CAUTION');
  PERFORM pg_temp.expect_fail('C25a seconde caution sur le meme bail refusee',
    format('INSERT INTO izl_t_security_deposit(lease_id,montant,date_reception,mode,saisi_par) VALUES (%s,5000,current_date,%L,%s)', ls, 'especes', o), '23505');
  PERFORM pg_temp.expect_fail('C25b second recu de caution refuse',
    format('INSERT INTO izl_t_receipt(lease_id,deposit_id,type) VALUES (%s,%s,%L)', ls, dep, 'CAUTION'), '23505');
  PERFORM pg_temp.expect_fail('C25c restitution : restitue + retenu <> montant refuse',
    format('UPDATE izl_t_security_deposit SET statut=%L, montant_restitue=60000, montant_retenu=30000, date_restitution=current_date WHERE id=%s', 'RESTITUEE', dep), '23514');
  PERFORM pg_temp.expect_ok('C25d restitution avec retenue motivee acceptee',
    format('UPDATE izl_t_security_deposit SET statut=%L, montant_restitue=70000, montant_retenu=30000, motif_retenue=%L, date_restitution=current_date WHERE id=%s', 'RESTITUEE', 'Loyer impaye', dep));
  PERFORM pg_temp.ok('C25e la caution (100000) n''ajoute rien a la dette : 80000 de reprise + 200000 de loyers - 100000 payes',
    (SELECT dette_totale FROM izl_v_lease_debt WHERE lease_id = ls) = 180000);
END $$;

-- C20 : remboursement de credit en fin de bail
DO $$
DECLARE o bigint; ls bigint; p bigint; p2 bigint;
BEGIN
  o := pg_temp.mk_owner(); ls := pg_temp.mk_lease(pg_temp.mk_local(o));
  p  := pg_temp.mk_paid_with_surplus(ls, 'TX-C20a', 0, 20000);
  p2 := pg_temp.mk_paid_with_surplus(ls, 'TX-C20b', 1, 20000);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  -- remboursement declare correctement
  INSERT INTO izl_t_credit_refund(lease_id, payment_id, refund_ref, montant, date_remboursement, mode, declare_par)
  VALUES (ls, p, 'RF-1', 20000, current_date, 'especes', o);
  UPDATE izl_t_payment SET excedent_restant = excedent_restant - 20000 WHERE id = p;
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C20a remboursement declare : solde du credit ramene a 0',
    (SELECT excedent_restant FROM izl_t_payment WHERE id = p) = 0);
  -- remboursement sans decrement
  BEGIN
    INSERT INTO izl_t_credit_refund(lease_id, payment_id, refund_ref, montant, date_remboursement, mode, declare_par)
    VALUES (ls, p2, 'RF-2', 20000, current_date, 'especes', o);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'aucune erreur' USING ERRCODE = 'XX999';
  EXCEPTION WHEN OTHERS THEN
    PERFORM pg_temp.verdict('C20b remboursement sans decrement du credit : invariant viole', SQLSTATE, SQLERRM, 'P0001');
  END;
  SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.expect_fail('C20c remboursement superieur au solde refuse (restant negatif)',
    format('UPDATE izl_t_payment SET excedent_restant = excedent_restant - 30000 WHERE id = %s', p2), '23514');
END $$;

-- C13 / dette : vue de dette cumulee
DO $$
DECLARE o bigint; ls bigint; ls0 bigint; i0 bigint; p bigint; e bigint;
BEGIN
  o := pg_temp.mk_owner(); ls0 := pg_temp.mk_lease(pg_temp.mk_local(o)); ls := pg_temp.mk_lease(pg_temp.mk_local(o));
  PERFORM pg_temp.ok('C13a bail sans echeance : la vue de dette renvoie une ligne a 0',
    (SELECT dette_totale = 0 FROM izl_v_lease_debt WHERE lease_id = ls0));
  i0 := pg_temp.mk_installment(ls, 0);
  PERFORM pg_temp.mk_installment(ls, -1);
  e := pg_temp.mk_event('TX-C13', 40000);
  p := pg_temp.mk_pay(ls, e, 'A', 40000);
  PERFORM pg_temp.alloc(p, i0, 40000);
  SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED;
  PERFORM pg_temp.ok('C13b dette cumulee = 160000, dont 100000 de report',
    (SELECT dette_totale = 160000 AND dont_reports = 100000 FROM izl_v_lease_debt WHERE lease_id = ls));
END $$;

-- C29 / C33 / C34 : abonnements
DO $$
DECLARE o bigint; adm bigint; e bigint;
BEGIN
  PERFORM pg_temp.ok('C29a paliers aux bornes (1,2,9,10,19,20,50,51)',
    (SELECT array_agg(izl_fn_tier_for(n) ORDER BY n)::text[] FROM unnest(ARRAY[1,2,9,10,19,20,50,51]) n)
    = ARRAY['STARTER','T_2_9','T_2_9','T_10_19','T_10_19','T_20_50','T_20_50','T_51_PLUS']::text[]);
  PERFORM pg_temp.ok('C29b grille D17 : 0 / 3000 / 5000 / 10000 / 25000 FCFA',
    (SELECT array_agg(tarif_mensuel ORDER BY baux_min) FROM izl_t_subscription_tier) = ARRAY[0,3000,5000,10000,25000]::bigint[]);
  PERFORM pg_temp.expect_fail('C29c palier chevauchant refuse',
    'INSERT INTO izl_t_subscription_tier(code,baux_min,baux_max,tarif_mensuel) VALUES (''X'',5,12,1000)', '23P01');

  o := pg_temp.mk_owner(); adm := pg_temp.mk_user('ADMIN');
  e := pg_temp.mk_event('TX-SUB1', 3000);
  INSERT INTO izl_t_subscription_payment(owner_id, voie, wave_event_id, montant, mois_couverts, periode_debut, periode_fin)
  VALUES (o, 'A', e, 3000, 1, current_date, current_date + 30);
  PERFORM pg_temp.expect_fail('C33a abonnement : meme evenement Wave rejoue refuse',
    format('INSERT INTO izl_t_subscription_payment(owner_id,voie,wave_event_id,montant,mois_couverts,periode_debut,periode_fin) VALUES (%s,%L,%s,3000,1,%L,%L)',
           o, 'A', e, current_date + 31, current_date + 61), '23505');
  PERFORM pg_temp.expect_fail('C34a abonnement voie C reservee au role ADMIN',
    format('INSERT INTO izl_t_subscription_payment(owner_id,voie,montant,mois_couverts,periode_debut,periode_fin,saisi_par,idempotency_key) VALUES (%s,%L,3000,1,%L,%L,%s,%L)',
           o, 'C', current_date + 31, current_date + 61, o, 'k34a'), 'P0001');
  PERFORM pg_temp.expect_ok('C34b abonnement voie C par un ADMIN accepte',
    format('INSERT INTO izl_t_subscription_payment(owner_id,voie,montant,mois_couverts,periode_debut,periode_fin,saisi_par,idempotency_key) VALUES (%s,%L,3000,1,%L,%L,%s,%L)',
           o, 'C', current_date + 31, current_date + 61, adm, 'k34b'));
  PERFORM pg_temp.expect_fail('C34c abonnement voie C : double soumission refusee',
    format('INSERT INTO izl_t_subscription_payment(owner_id,voie,montant,mois_couverts,periode_debut,periode_fin,saisi_par,idempotency_key) VALUES (%s,%L,3000,1,%L,%L,%s,%L)',
           o, 'C', current_date + 62, current_date + 92, adm, 'k34b'), '23505');
  PERFORM pg_temp.expect_fail('C34d paiement d''abonnement : modification refusee (append-only)',
    format('UPDATE izl_t_subscription_payment SET montant = 1 WHERE owner_id = %s', o), 'P0001');
END $$;

-- ============================ RESULTATS ============================
SELECT test, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END AS resultat, detail FROM t_results ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS pass, count(*) FILTER (WHERE NOT ok) AS fail, count(*) AS total FROM t_results;

ROLLBACK;
