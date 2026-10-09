-- V002__types.sql
CREATE TYPE izl_typ_user_role            AS ENUM ('PROPRIETAIRE','LOCATAIRE');
CREATE TYPE izl_typ_lease_status         AS ENUM ('ACTIF','RESILIE','TERMINE');
CREATE TYPE izl_typ_installment_type     AS ENUM ('LOYER','REPRISE');
CREATE TYPE izl_typ_payment_status       AS ENUM ('EN_ATTENTE','PARTIEL','PAYE');
CREATE TYPE izl_typ_session_status       AS ENUM ('OUVERTE','PAYEE','ECHOUEE','EXPIREE');
CREATE TYPE izl_typ_verification_status  AS ENUM ('EN_VERIFICATION','VERIFIE','REJETE');
CREATE TYPE izl_typ_event_source         AS ENUM ('WEBHOOK','RECONCILIATION','VERIF_VOIE_B');
CREATE TYPE izl_typ_payment_channel      AS ENUM ('A','B','OUVERTURE');
CREATE TYPE izl_typ_allocation_source    AS ENUM ('PAIEMENT','CREDIT');
CREATE TYPE izl_typ_receipt_type         AS ENUM ('ACOMPTE','SOLDE','AVANCE','CAUTION');
CREATE TYPE izl_typ_receipt_status       AS ENUM ('A_GENERER','GENEREE','ECHEC');
CREATE TYPE izl_typ_deposit_status       AS ENUM ('DETENUE','RESTITUEE');
CREATE TYPE izl_typ_wave_account_status  AS ENUM ('ACTIF','SUSPENDU');
CREATE TYPE izl_typ_sms_status           AS ENUM ('A_ENVOYER','ENVOYE','ECHEC');