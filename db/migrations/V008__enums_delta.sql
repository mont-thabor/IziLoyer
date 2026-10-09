-- V008__enums_delta.sql
-- Delta v1.2 (journal #38 à #42) : Voie C, abonnements, D23.
-- ⚠️ Cette migration ne contient QUE des ALTER TYPE ... ADD VALUE et des CREATE TYPE :
--    une valeur d'enum ajoutée ne peut pas être utilisée dans la transaction qui l'ajoute.
--    Les objets qui s'en servent sont dans V009 (transaction suivante).

-- Rôle interne back-office (SFD-01, SFD-07 §7.5)
ALTER TYPE izl_typ_user_role ADD VALUE IF NOT EXISTS 'ADMIN';

-- Voie C : paiement en espèces déclaré par le bailleur (SFD-04 §4.4 bis)
ALTER TYPE izl_typ_payment_channel ADD VALUE IF NOT EXISTS 'C';

-- Mode dégradé : quittance créée mais PDF non produit (SFD-07 §7.4, D18)
ALTER TYPE izl_typ_receipt_status ADD VALUE IF NOT EXISTS 'EN_ATTENTE_ABONNEMENT';

-- D23 : états du compte Wave du bailleur (ACTIF / A_RECONNECTER / INVALIDE).
-- 'SUSPENDU' (V002) ne peut pas être retiré d'un enum PostgreSQL : il devient inutilisé
-- (les lignes existantes sont migrées vers A_RECONNECTER dans V009).
ALTER TYPE izl_typ_wave_account_status ADD VALUE IF NOT EXISTS 'A_RECONNECTER';
ALTER TYPE izl_typ_wave_account_status ADD VALUE IF NOT EXISTS 'INVALIDE';

-- Nouveaux types
CREATE TYPE izl_typ_checkout_object      AS ENUM ('LOYER','ABONNEMENT');
CREATE TYPE izl_typ_wave_account_scope   AS ENUM ('OWNER','PLATFORM');
CREATE TYPE izl_typ_subscription_status  AS ENUM ('ESSAI','STARTER','ACTIF','GRACE','DEGRADE');
CREATE TYPE izl_typ_subscription_channel AS ENUM ('A','B','C');
