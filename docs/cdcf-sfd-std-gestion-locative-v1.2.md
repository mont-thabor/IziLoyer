# CAHIER DES CHARGES FONCTIONNEL, SPÉCIFICATIONS FONCTIONNELLES ET TECHNIQUES

**Projet :** IziLoyer — Application de Gestion Locative via Wave — Produit V1 (MVP)
**Cible :** Propriétaires et Locataires particuliers — Côte d'Ivoire
**Périmètre :** « Bail Direct Wave » : baux directs avec recouvrement automatisé par Wave uniquement
**Date :** Octobre 2026
**Statut :** **Document v1.2 (consolidée)** — la numérotation du document est distincte de la version du produit (V1 = MVP)

---

## Table des matières

1. Journal des modifications
2. PARTIE 1 — Cahier des charges fonctionnel (CdCF)
3. PARTIE 2 — Dossier de spécifications fonctionnelles (SFD)
4. PARTIE 3 — Spécifications techniques (STD)
5. Prérequis techniques ouverts
6. Décisions produit à valider

---

## Journal des modifications (v1.0 → v1.2)

### A. Corrections structurelles (révision post-analyse)

| # | Modification | Sections |
|---|---|---|
| 1 | Distinction version produit / version document ; profil « Gestionnaire » retiré de la cible V1 (→ V2) | En-tête, CdCF §2, SFD-01 |
| 2 | Contexte Côte d'Ivoire : fuseau Africa/Abidjan (UTC+0, pas d'heure d'été), devise FCFA (entiers), loi ivoirienne sur les données personnelles | Global, CdCF §3, STD §7 |
| 3 | Loyer mensuel porté par le **Bail** (le loyer du Local devient une valeur par défaut) | SFD-02, SFD-03, STD §3 |
| 4 | Relation Local–Bail : 1:N temporel + unicité du bail actif (index unique partiel) ; statut du Local dérivé, non stocké | SFD-02, STD §3 |
| 5 | Statuts en deux dimensions : `statut_paiement` (3 états) + `est_en_retard` ; « Échoué » devient un événement | SFD-04, SFD-05, Annexe 1 |
| 6 | Entité `Payment` (registre des versements acceptés) ; idempotence à trois niveaux | SFD-04, STD §3 |
| 7 | Sécurité renforcée : OTP hashé / usage unique / anti-flood, JWT révocable (`jti`), incrément atomique du montant perçu | SFD-01, STD §6 |
| 8 | Crons chiffrés (génération, retard, rappel, réconciliation) | SFD-04, STD §4 |
| 9 | Ajouts : glossaire FR/EN, critères d'acceptation testables, plan de tests, CI/CD, conformité, sauvegardes | Annexe 2, STD §7–§8 |

### B. Réintégration des décisions arrêtées précédemment

| # | Modification | Sections |
|---|---|---|
| 10 | **Deux voies de paiement** : Voie A (Checkout Wave + webhook) et Voie B (virement direct vérifié automatiquement par l'API Wave). L'ancienne décision « versements hors checkout non reconnus » est **abandonnée** | SFD-04, STD §4 |
| 11 | **Report de dette** : un reliquat impayé se cumule avec les mois suivants ; règlement en **FIFO** | SFD-04, SFD-05 |
| 12 | **Date limite par contrat** (défaut : le 5 du mois), et non plus par local | SFD-03, STD §3 |
| 13 | **Rappel SMS unique à J-3** par contrat, affichant le cumul dû (au lieu du calendrier de relances multiples) | SFD-04 |
| 14 | Montant retenu = **montant renvoyé par Wave**, jamais la saisie client | SFD-04, STD §6 |
| 15 | Un seul compte/numéro Wave par bailleur en V1 ; multi-propriétaire et litiges hors V1 | CdCF §2, STD §3 |

### C. Nouveautés de la consolidation

| # | Modification | Sections |
|---|---|---|
| 16 | Nouvelle entité **`CheckoutSession`** (rattachement webhook ↔ bail, base de la réconciliation) ; une seule session ouverte par bail | SFD-04, STD §3 |
| 17 | Nouvelle entité **`PaymentAllocation`** : un paiement peut solder plusieurs mois ; la **quittance est émise par allocation** | SFD-04, STD §3 |
| 18 | Nouvelle entité **`TransferVerification`** (suivi de la Voie B, retries bornés) | SFD-04, STD §3 |
| 19 | **Surplus** de paiement (Voie B) converti en crédit appliqué automatiquement aux échéances suivantes | SFD-04 |
| 20 | **Première échéance** générée dès la création du bail ; cron de génération idempotent et rattrapant | SFD-03, SFD-04 |
| 21 | Numérotation séquentielle des quittances par compteur transactionnel | STD §3 |
| 22 | Unicité `WaveEvent` sur `(transaction_id, event_type)` | STD §3 |
| 23 | Jour limite borné entre 4 et 28 (le rappel J-3 reste dans le mois de l'échéance) | SFD-03 |
| 24 | File de jobs **pg-boss** (PostgreSQL) à la place de BullMQ + Redis ; sauvegardes avec restauration à un instant donné (PITR) | STD §1, §6 |
| 25 | Conformité : loi n° 2013-450 / ARTCI (remplace la référence « RGPD ») ; conservation à trancher | STD §7 |
| 26 | Maquette du tableau de bord intégrée au SFD-05 (KPI, barre segmentée, liste filtrable, actions rapides, illustration du report) | SFD-05 |

### D. Révision v1.2 (crédit locataire, fin de bail, espace locataire)

| # | Modification | Sections |
|---|---|---|
| 27 | **Quittance d'avance** émise immédiatement à la création d'un crédit (nouveau type `AVANCE`) | SFD-04 §4.5, §4.11, STD §3 |
| 28 | **Application du crédit** modélisée comme une allocation (`source = CREDIT`) : une quittance par allocation et **ligne explicite** « loyer, crédit appliqué, reste à payer » sur l'écran locataire et la quittance | SFD-04 §4.1, §4.5, §4.11, SFD-06 |
| 29 | **Historique du crédit** visible du locataire et du bailleur (créations, applications, remboursements, solde) ; ajout de `Payment.excédent_initial` | SFD-04 §4.5, SFD-06, STD §3, §5 |
| 30 | **Fin de bail avec crédit restant : le bailleur le rembourse** ; mention « À rembourser » ; déclaration du remboursement ; nouvelle entité `CreditRefund` | SFD-03, SFD-04 §4.5, STD §3, §5, §6 |
| 31 | **Espace locataire** détaillé (écran d'accueil, statuts affichés, Voie A, Voie B, états hors connexion / introuvable, quittances) | SFD-06 |
| 32 |  Décisions **D11 à D15** ajoutées ; prérequis P2 étendu (expiration de session côté Wave) ; critères d'acceptation 18 à 26 | Décisions, Prérequis, STD §8 |
| 33 | **Reprise d'un locataire existant** : créance antérieure (échéance de type REPRISE, **date limite fixée par le bailleur**, réglée en premier) ; distinction début du contrat / début de la gestion | SFD-03, SFD-04 §4.2, SFD-05, SFD-06, STD §3 |
| 34 | **Avance sur loyers** saisie par le bailleur = crédit d'ouverture (`Payment.voie = OUVERTURE`) avec quittance d'avance | SFD-03, SFD-04 §4.1, §4.5, STD §3 |
| 35 | **Caution** (dépôt de garantie) : saisie déclarative, reçu de caution, restitution en fin de bail avec retenues motivées ; entité `SecurityDeposit` | SFD-03, SFD-06, STD §3 |
| 36 | **SMS d'avoir** à la création du crédit et à son application, avec équivalent en nombre de loyers | SFD-04 §4.10 |
| 37 | D11 **validée** (montant libre en Voie A, minimum 5 000 FCFA) ; D7 **confirmée** (10 ans) ; P1 et P2 : recherches en cours ; P3 reporté | Décisions, Prérequis, SFD-04, SFD-06 |
| 38 | **Voie C (espèces)** pour les loyers : enregistrement par le bailleur, avertissement en cas de dépassement de la dette (surplus en avoir après confirmation), quittance « Espèces (Déclaré par le bailleur) » | SFD-04 §4.4 bis, STD §3, §5 |
| 39 | **Abonnement du bailleur** : essai de 90 jours limité à 3 baux actifs, grille tarifaire par palier de baux actifs, formule Starter gratuite (1 bail) | SFD-07 §7.1 à §7.3, STD §3 |
| 40 | **Mode dégradé** : l'encaissement des loyers n'est jamais bloqué ; à l'expiration (après 10 jours de grâce et 2 SMS), verrouillage des quittances PDF (bailleur et locataire) et des statistiques avancées, bandeau d'alerte | SFD-07 §7.4, SFD-05, SFD-06, STD §4 |
| 41 | **Encaissement des abonnements** par IziLoyer (Voie A Checkout, Voie B virement vérifié, Voie C back-office administrateur) ; rôle ADMIN ; compte Wave de la plateforme | SFD-07 §7.5, STD §3, §5, §6 |
| 42 | **P4 tranché (D23)** : chaque bailleur connecte **son propre compte Wave Business** ; les fonds vont directement du locataire au bailleur ; connexion et validation du compte Wave à l'inscription du bailleur | SFD-01, SFD-03, STD §3, §4, §5, §6 |

---

# PARTIE 1 : CAHIER DES CHARGES FONCTIONNEL (CdCF)

## 1. Objectif de la V1

Développer un MVP léger et performant qui automatise le cycle de collecte des loyers mensuels entre bailleurs et locataires particuliers en Côte d'Ivoire, à travers l'API Wave Business, avec une fiabilité garantie sur le traitement des paiements.

## 2. Périmètre fonctionnel exclusif (V1)

- **Gestion du patrimoine** : création des sites (immeubles) et des locaux (appartements/studios).
- **Gestion des baux particuliers** : association d'un locataire à un local, loyer mensuel et date limite fixés au niveau du bail, fin de bail incluse.
- **Recouvrement automatisé** : génération des échéances, report de dette, rappel SMS, paiement par Wave (Voie A : Checkout ; Voie B : virement direct vérifié), validation par webhook sécurisé, idempotence stricte et reprise sur incident.
- **Comptabilité & documents** : tableau de bord des encaissements en temps réel et génération automatique des quittances de loyer PDF.
- **Abonnement des bailleurs** : essai gratuit de 90 jours (3 baux actifs maximum), puis abonnement mensuel selon le nombre de baux actifs ; mode dégradé en cas d'expiration, sans jamais bloquer l'encaissement des loyers (SFD-07).
- **Paiement en espèces (Voie C)** : enregistrement par le bailleur d'un règlement remis de la main à la main (SFD-04 §4.4 bis).

**Note de cadrage (V2)** : sont formellement exclus de la V1 et reportés en V2 : les baux institutionnels / maisons baillées (Trésor Public, ministères, entreprises), le profil « Gestionnaire », la gestion de plusieurs propriétaires pour un même bien, la gestion des litiges, le prorata temporis.

**Choix V1 (D23)** : chaque bailleur connecte **son propre compte Wave Business** (un seul compte/numéro de réception par bailleur). IziLoyer ne détient jamais les loyers : ils vont directement du Wave du locataire à celui du bailleur.

**Hypothèse V1 bis** : IziLoyer dispose d'un compte Wave Business de plateforme pour encaisser les abonnements des bailleurs (cf. P5).

## 3. Exigences non-fonctionnelles

- **Sécurité** : HTTPS/TLS obligatoire, vérification de signature sur chaque webhook Wave, idempotence garantie au niveau base de données, verrouillage après tentatives OTP échouées répétées.
- **Fiabilité** : aucune perte d'événement de paiement (réconciliation automatique) ; jobs asynchrones persistés (survivent à un redémarrage).
- **Performances** : API < 500 ms, traitement webhook < 2 s.
- **Contexte géographique** : fuseau de référence **Africa/Abidjan** (UTC+0, sans heure d'été) pour tous les calculs de dates, échéances, crons et horodatages ; horodatages techniques stockés en UTC. Montants en **FCFA, entiers** (pas de décimales).
- **Conformité** : données personnelles conformes à la loi ivoirienne (cf. STD §7).
- **Reprise après sinistre** : sauvegardes automatiques avec restauration à un instant donné (PITR) ; RTO ≤ 4 h.

---

# PARTIE 2 : DOSSIER DE SPÉCIFICATIONS FONCTIONNELLES (SFD)

## SFD-01 — Authentification & profils

- **Connexion OTP SMS** : numéro de téléphone → code à **6 chiffres**, valable 5 minutes → session JWT (access + refresh).
  - Le code est stocké **hashé**, à **usage unique** ; toute validation consomme le code, même en cas d'échec.
  - **Anti-brute-force** : blocage après **3 tentatives** échouées ; délai progressif avant nouveau code (60 s → 2 min → 5 min).
  - **Anti-flooding** : maximum 3 demandes de code par téléphone et par heure.
- **Profil utilisateur** : Nom, Prénoms, Email, rôle principal (Propriétaire / Locataire). Un rôle interne **Administrateur** (back-office IziLoyer) existe pour enregistrer les abonnements réglés hors ligne (SFD-07 §7.5). Le rôle Gestionnaire est hors périmètre V1.
- **Compte Wave du bailleur (D23)** : lors de son inscription, le bailleur connecte son **compte Wave Business** (numéro Wave, clé API, secret de signature des webhooks, saisis dans un formulaire sécurisé). IziLoyer **teste la connexion** avant de l'activer et affiche l'état du compte (Actif, À reconnecter, Invalide). **Aucun bail ne peut être créé tant que le compte Wave du bailleur n'est pas actif.** Le bailleur peut changer de compte ou renouveler ses clés (jamais pendant une session de checkout ouverte ni une vérification Voie B en cours) ; toute modification est tracée et chiffrée, et les clés ne sont jamais réaffichées.
- **Compte Wave inactif** : si Wave rejette les clés d'un bailleur (état « À reconnecter »), les nouvelles sessions de checkout sont refusées avec un message au locataire (« paiement par Wave momentanément indisponible, contactez votre bailleur »), le bailleur est alerté par SMS et par bandeau, et les Voies B et C restent possibles. Aucune donnée de paiement n'est perdue.

## SFD-02 — Structuration du parc immobilier

```
[Propriétaire] ──1:N──> [Site / Immeuble] ──1:N──> [Local / Lot] ──1:N──> [Bail]
                                              (un seul bail ACTIF à la fois par local)
```

- **Site** : nom du bâtiment, commune, ville.
- **Local** : numéro/nom du lot, type (Studio, 2 pièces…), **loyer mensuel (valeur par défaut)**.
- **Statut du local (Libre / Loué)** : **dérivé** de l'existence d'un bail actif, non saisi manuellement.
- Un local ayant eu plusieurs baux successifs conserve l'historique complet de ses baux.

## SFD-03 — Gestion du Bail Direct Wave

**Création du bail :**

- Numéro de téléphone Wave du locataire.
- Date de prise d'effet : au plus tôt le **1er jour du mois en cours** (pas de bail rétroactif au-delà).
- **Loyer mensuel du bail** : pré-rempli avec le loyer du local, modifiable à la création (l'historique des loyers est ainsi préservé d'un locataire à l'autre).
- **Date limite de paiement** : jour du mois, **configurable par contrat, défaut : le 5**, borné entre le **4 et le 28**.
- **Date de fin** : optionnelle. Si absente → reconduction tacite mensuelle.
- SMS d'invitation automatique au locataire.
- **Première échéance générée immédiatement** à la création du bail (voir SFD-04).

**Reprise d'un locataire existant et soldes d'ouverture** (le bailleur adopte l'application avec des locataires déjà en place, ou accueille un nouveau locataire) :

- Le bailleur renseigne, **à la création du bail**, jusqu'à trois soldes d'ouverture. Ils sont **saisis par le bailleur seul** ; le locataire les consulte en lecture seule, avec leur date de saisie.
- **Créance antérieure (arriérés)** : une ou plusieurs lignes (montant, libellé, **date limite fixée par le bailleur**). Chaque ligne devient une échéance de type REPRISE, exigible à sa date limite, en retard si celle-ci est dépassée, réglée **en premier** (FIFO, SFD-04 §4.2). Aucun prorata, intérêt ni pénalité en V1. Le locataire la voit dans son espace sous « Arriérés avant IziLoyer ». Le bailleur peut ajouter ou modifier une créance après la création du bail ; le locataire reçoit alors un SMS d'information ; toute création ou modification est tracée (ancien montant, nouveau montant, auteur, date) et le montant dû ne peut pas descendre sous le montant déjà perçu. **(D14)**
- **Avance sur loyers** : montant remis en main propre avant l'entrée dans les lieux. Il est enregistré comme **crédit d'ouverture** (sans transaction Wave), **avant** la génération de la première échéance, de sorte qu'il s'applique à elle dès la création du bail (SFD-04 §4.5). Une quittance d'avance est émise et le SMS d'avoir est envoyé. **(D15)**
- **Caution (dépôt de garantie)** : montant et date de réception, saisis par le bailleur. Elle n'est **pas un loyer** : elle n'entre ni dans la dette, ni dans le FIFO, ni dans le crédit. Un reçu de caution est émis. Le locataire la voit dans son onglet « Mon bail ». **(D15)**
- **Remise physique** : l'avance et la caution sont remises lors de la rencontre physique des deux parties à l'entrée dans les lieux (remise des clés) ; la **déclaration du bailleur fait foi** et IziLoyer n'en est pas dépositaire. Le paiement de l'avance ou de la caution par Wave n'est pas prévu en V1.
- **Début du contrat et début de la gestion** : la `date_début_contrat` est informative et peut être antérieure ; la `date_prise_effet` désigne le premier mois géré dans IziLoyer (borné par D10).

**Décision D1 — Pas de prorata en V1 :** la première échéance est due **en totalité** dès le mois de prise d'effet, même en cours de mois ; de même, si une fin de bail tombe en cours de mois, l'échéance de ce mois reste due en totalité.

**Fin de bail :**

- Clôture à une date donnée (résiliation ou terme) ; le bail passe au statut Résilié/Terminé à cette date et le local repasse **Libre** (statut dérivé).
- Aucune échéance n'est générée après la date de fin ; les échéances passées restent consultables.
- Une **dette résiduelle reste exigible** après la clôture : elle demeure visible dans l'historique et le locataire conserve l'accès à son espace pour la régler.
- **Crédit restant à la clôture** : si le bail porte un crédit non consommé (solde créditeur > 0), **le bailleur le rembourse au locataire**. Le crédit apparaît chez le bailleur et chez le locataire avec la mention **À rembourser** ; le remboursement s'effectue hors IziLoyer, puis le bailleur le **déclare** (date, mode), ce qui solde le crédit (cf. SFD-04 §4.5). Le locataire conserve l'accès à son espace pour consulter ce crédit.
- **Caution à la clôture** : tant que la caution est détenue, elle apparaît chez le bailleur et chez le locataire avec la mention **À restituer**. Le bailleur déclare la restitution (montant restitué, **retenues éventuelles avec motif**, date) ; le locataire voit le détail. Aucune compensation automatique avec une dette résiduelle ; un impayé peut être invoqué comme motif de retenue. La contestation reste hors V1. **(D15)**
- La clôture est **impossible tant qu'un paiement est en cours** (session de checkout ouverte ou vérification de virement en cours) : message d'attente ou de confirmation.

## SFD-04 — Circuit de paiement Wave, dette & quittances

### 4.1 Génération des échéances

- **Cron le 1er de chaque mois à 00:10 (Africa/Abidjan)** : une échéance par bail actif. Unicité par couple (bail, mois) : la génération est **idempotente** et **rattrape** les mois manquants après une éventuelle panne.
- **À la création d'un bail** : l'échéance du mois de prise d'effet est créée immédiatement.
  L'éventuelle **avance d'ouverture** est enregistrée avant cette génération : le crédit s'applique à la première échéance dans la même transaction.
- **Date d'échéance** : jour limite du bail dans le mois ; pour la première échéance, `max(jour limite du mois, date de prise d'effet + 5 jours)`.
- **Crédit éventuel** : si le bail porte un crédit (cf. 4.5), il est appliqué automatiquement à la nouvelle échéance, **FIFO sur les crédits** (le crédit le plus ancien est consommé en premier). Chaque application crée une `PaymentAllocation` de source CREDIT (cf. 4.5) et donne lieu à une quittance (4.11).

### 4.2 Dette cumulée et règle FIFO

- La **dette cumulée** d'un bail = somme des restes dus (`montant_dû − montant_perçu`) de toutes les échéances générées. Un reliquat impayé **se reporte** naturellement dans la dette du mois suivant.
- Tout paiement est affecté aux échéances ouvertes **de la plus ancienne à la plus récente (FIFO)**.
- Les **créances de reprise** (SFD-03) sont réglées **en premier** (date limite croissante), puis les loyers par mois croissant.
- Un paiement qui solde plusieurs mois produit plusieurs allocations (une par échéance touchée).

### 4.3 Voie A — Paiement in-app (Wave Checkout + webhook)

1. Le locataire clique « Payer avec Wave » → `POST /payments/checkout`.
2. **Décision D2 (précisée par D11) — Montant du checkout ≤ dette cumulée** du bail (jamais supérieur), et **≥ 5 000 FCFA** sauf si la dette est inférieure (le montant est alors la dette entière) ; **une seule session de checkout ouverte par bail** à la fois. Une session expirée est remplacée par une nouvelle initiation.
3. Le locataire valide dans l'application Wave (deep link).
4. Wave envoie le webhook ; traitement sécurisé décrit en 4.6.

### 4.4 Voie B — Virement direct vérifié automatiquement

Pour les locataires qui envoient directement un transfert Wave au bailleur, sans passer par le checkout :

1. Le locataire déclare « J'ai payé par virement » dans son espace (montant **indicatif**, et référence de transaction Wave si disponible).
2. Le système crée une **vérification** et interroge l'API Wave pour retrouver la transaction correspondante (expéditeur = numéro Wave du bail, destinataire = compte Wave du bailleur, transaction jamais traitée).
3. **Retries bornés dans le temps** : tentatives espacées (+1, +3, +10, +30 min, puis toutes les heures) pendant **24 h maximum**. Passé ce délai : statut **Rejeté**, SMS invitant à réessayer ou à contacter le bailleur.
4. **Aucune validation manuelle du bailleur.** Il dispose d'un bouton « Actualiser » (Voie B) pour forcer un nouvel essai immédiat.
5. Une fois la transaction retrouvée, le traitement est **identique** à la Voie A (4.6) : le **montant fait foi tel que renvoyé par Wave**, jamais la saisie du locataire.
6. Garde-fous : l'expéditeur doit correspondre au numéro du bail ; une même transaction ne peut être revendiquée qu'une fois (contrainte d'unicité) ; limite de déclarations par bail (5 par heure).

> Dépend du prérequis P1 (recherche de transaction par référence dans l'API Wave).

### 4.4 bis Voie C — Paiement en espèces (main à main)

Pour un locataire qui remet son loyer en espèces au bailleur. **Seul le bailleur** enregistre ce paiement ; sa déclaration fait foi.

1. Depuis son tableau de bord, le bailleur sélectionne le bail et clique sur **« Enregistrer un paiement en espèces »**.
2. Il saisit le **montant** (entier, FCFA) et la **date de remise des fonds** (pas dans le futur, pas antérieure à la prise d'effet du bail), et peut ajouter une note.
3. **Avertissement de dépassement** : si le montant saisi dépasse la dette cumulée, un message affiche le montant saisi, la dette, l'excédent et son équivalent en loyers, et demande une **confirmation explicite**. Sans confirmation, rien n'est enregistré. Si la saisie est confirmée, l'excédent devient un **avoir** (4.5) : quittance d'avance et SMS d'avoir.
4. Le traitement est celui de 4.6, sans événement Wave : création d'un `Payment` de voie C (montant et date déclarés), **allocation FIFO** (créances de reprise d'abord), recalcul des statuts, **quittance par allocation** portant la mention **« Mode de règlement : Espèces (Déclaré par le bailleur) »**.
5. Le locataire reçoit **toujours** un SMS de confirmation (« paiement en espèces de X F enregistré par votre bailleur le JJ/MM ») ; la quittance lui est envoyée par SMS et reste téléchargeable, sous réserve du mode dégradé (SFD-07 §7.4).
6. **Garde-fous** : clé d'idempotence générée par l'écran (une double soumission n'enregistre qu'un paiement) ; alerte de confirmation si un paiement de même montant a déjà été saisi sur le même bail depuis moins de 10 minutes ; saisie tracée (auteur, date) ; le locataire voit ce paiement avec l'origine « Espèces, déclaré par le bailleur ». La contestation d'un paiement déclaré reste hors V1 (litiges). La correction d'une saisie erronée est à préciser (P6).

### 4.5 Surplus

Un virement (Voie B) peut excéder la dette. Le **surplus** est conservé comme **crédit** rattaché au paiement (`excédent_restant`). Le checkout (Voie A) ne peut pas générer de surplus (D2). Le crédit n'est pas une somme détenue par IziLoyer : les fonds vont directement du Wave du locataire au Wave du bailleur ; le crédit est une écriture comptable que le locataire retrouve dans son espace. Il en va de même d'un paiement en espèces (Voie C) dont le dépassement a été confirmé (4.4 bis).

Un crédit peut aussi provenir d'une **avance d'ouverture** saisie par le bailleur (SFD-03) : même mécanique (FIFO sur les crédits, quittance d'avance, historique, remboursement en fin de bail), sans transaction Wave.

**Preuve remise au locataire**

- Une **quittance d'avance** (type `AVANCE`) est **émise immédiatement**, dans la transaction de traitement du paiement (4.6), pour le montant du surplus ; elle porte la référence de transaction Wave. Un **SMS d'avoir** est envoyé (4.10). Pour une avance d'ouverture, la quittance est émise à la saisie et mentionne « remise en main propre, déclarée par le bailleur ».

**Application du crédit**

- À la génération d'une échéance (4.1), le crédit est appliqué automatiquement (FIFO sur les crédits) : création d'une `PaymentAllocation` de `source = CREDIT` rattachée au paiement d'origine, décrément de `excédent_restant`, incrément atomique de `montant_perçu`.
- **Ligne explicite** affichée dans l'espace locataire et sur la quittance de l'échéance : « Loyer du mois X FCFA, crédit appliqué − Y FCFA, reste à payer Z FCFA ». Le montant « crédit appliqué » est la somme des allocations de source CREDIT de l'échéance.
- Si le crédit couvre tout le loyer, l'échéance passe à Payé sans nouveau versement ; la quittance de solde émise porte le mode « Crédit ». **(D13)**
- Le crédit appliqué n'est pas un encaissement : il n'entre pas dans le « total perçu ce mois » du tableau de bord propriétaire (qui compte les versements Wave du mois) et apparaît sur une ligne distincte « réglé par crédit ». **(D13)**

**Historique du crédit** : visible du locataire (onglet Paiements) et du bailleur (fiche du bail) : créations (date, montant, référence Wave), applications (mois, montant), remboursements, solde restant.

**Remboursement en fin de bail** : cf. SFD-03. Le bailleur déclare le remboursement ; le système crée un enregistrement `CreditRefund` par paiement concerné (imputation FIFO) et décrémente `excédent_restant`. Le montant déclaré ne peut pas dépasser le solde créditeur.

### 4.6 Traitement d'un paiement (commun aux deux voies)

Pour tout événement de succès Wave (webhook, réconciliation ou vérification Voie B), dans **une seule transaction SQL** :

1. Vérification de la **signature** (webhook) → rejet et journalisation de toute requête invalide.
2. Vérification de l'**unicité** de l'événement (contrainte BDD) : un événement rejoué n'a aucun effet.
3. Création du **Payment** (montant Wave).
4. **Verrouillage du bail**, puis **allocation FIFO** sur les échéances ouvertes : création des `PaymentAllocation` et **incrément atomique** de `montant_perçu`. Le reste éventuel devient un crédit.
5. Recalcul du `statut_paiement` de chaque échéance touchée.
6. Création des **quittances** (une par allocation) avec leur numéro séquentiel, puis mise en file des jobs PDF et SMS (clé d'idempotence = identifiant d'allocation / de paiement).

### 4.7 Statuts

| Dimension | Valeurs | Déterminée par |
|---|---|---|
| `statut_paiement` | **En attente / Partiel / Payé** | Montant perçu vs montant dû |
| `est_en_retard` | vrai / faux | Date d'échéance dépassée **ET** statut ≠ Payé (recalculé chaque jour à 00:05) |

### 4.8 Échec de transaction (événement, pas un statut)

Un refus, une annulation ou une expiration Wave est journalisé comme **événement d'échec** ; la session passe à Échouée/Expirée ; l'échéance **reste en l'état** ; un SMS informe le locataire et l'invite à réessayer (nouvelle initiation possible immédiatement).

### 4.9 Reprise sur incident

- **Réconciliation toutes les 15 minutes** : sessions de checkout ouvertes **sans webhook** depuis plus de 15 minutes et moins de 24 h → interrogation de l'API Wave, rattrapage du statut réel, traitement de l'éventuel succès manqué (4.6), clôture des sessions expirées.
- Bouton manuel **« Vérifier le statut du paiement »** (bailleur et locataire) : resynchronisation immédiate.

### 4.10 Rappels SMS

- **Rappel unique à J-3** avant la date limite de chaque contrat (un SMS par contrat, **montant cumulé dû** affiché), envoyé chaque jour à 08:00 aux baux concernés ayant une dette > 0.
- SMS transactionnels : invitation au bail, confirmation de paiement (locataire et bailleur), échec de paiement, rejet d'une vérification Voie B.
- **SMS d'avoir** : envoyé (1) à la **création d'un crédit** (surplus Voie B ou avance d'ouverture), fusionné avec le SMS de confirmation de paiement lorsqu'il y en a un ; (2) à la **génération d'une échéance** à laquelle un crédit est appliqué (en totalité ou en partie), avec l'avoir restant. Il indique le montant de l'avoir et **son équivalent en loyers : N loyer(s) entier(s) + reste en FCFA** (N = partie entière de l'avoir divisé par le loyer mensuel du bail ; « moins d'un loyer » si N = 0). Textes **sans accents** pour tenir en un seul SMS (160 caractères, jeu GSM-7 ; à confirmer avec le fournisseur, P3). Exemples : « IziLoyer: paiement de 120 000 F recu. Votre avoir: 60 000 F, soit 1 loyer. Deduit de l'echeance de novembre. » ; « IziLoyer: loyer de novembre regle par votre avoir. Avoir restant: 0 F. » ; « IziLoyer: avoir de 40 000 F applique au loyer de novembre. Reste a payer: 20 000 F. ». Clé d'idempotence : identifiant du paiement ou de l'échéance.
- **Relance manuelle** depuis le tableau de bord (limitée à 1 par bail et par 24 h).
- **SMS aux bailleurs (abonnement)** : rappels d'échéance et confirmation de réabonnement (SFD-07 §7.6). **SMS de confirmation de paiement au locataire** : envoyé pour toute voie (A, B, C), y compris lorsque le bailleur est en mode dégradé.

### 4.11 Quittances

- PDF horodaté, **une quittance par allocation** (un mois = une quittance), numérotation séquentielle **par bail**.
- Type **ACOMPTE** si l'échéance reste partielle après l'allocation, **SOLDE** si elle est soldée.
- Téléchargeable par le bailleur et le locataire ; **sous réserve du mode dégradé** (SFD-07 §7.4) : si l'abonnement du bailleur a expiré, les quittances sont créées mais leur PDF n'est ni généré, ni téléchargeable, ni envoyé par SMS tant que le bailleur ne s'est pas réabonné, puis elles sont produites automatiquement, avec leur numéro et leur date d'origine ; chaque quittance est liée à une allocation unique (idempotence de la génération).
- **Quittance d'avance** (type AVANCE) : émise à la création d'un crédit (4.5), liée au paiement d'origine (une seule par paiement), même numérotation séquentielle que les autres quittances. Elle atteste le montant reçu en surplus et ne solde aucune échéance.

## SFD-05 — Tableau de bord propriétaire

- **Cartes KPI** : total perçu ce mois (FCFA) ; **total restant à recouvrir** (dette cumulée, reports compris) ; nombre de logements en retard. Le « total perçu » compte les versements Wave du mois ; le crédit appliqué à une échéance apparaît à part (« réglé par crédit »).
- **Barre segmentée** répartissant les logements par statut.
- **Liste des échéances filtrable** (site, statut, mois) avec, pour chaque ligne : badge de statut, reste dû, mention **« dont report des mois précédents »**, et **actions rapides** : relancer (SMS manuel), actualiser la vérification Voie B, télécharger la quittance.
- **Badge couleur — règle de priorité** :
  1. 🔴 **Rouge** si `est_en_retard` (le retard prime sur tout autre affichage) ;
  2. 🟢 **Vert** si Payé (quittance téléchargeable) ;
  3. 🔵 **Bleu** si Partiel (solde restant affiché) ;
  4. 🟡 **Orange** si En attente.
- **Rubrique « Créances et soldes d'ouverture »** (bailleur uniquement) : par bail, saisie et suivi des créances antérieures (montant, libellé, date limite, reste dû), de l'avance d'ouverture et de la caution (montant, date, statut Détenue / À restituer / Restituée). Seul le bailleur écrit dans cette rubrique ; le locataire en consulte le résultat dans son espace (SFD-06).
- **Action rapide « Enregistrer un paiement en espèces »** (Voie C, SFD-04 §4.4 bis) sur chaque bail. Le « total perçu » inclut les espèces avec une ligne « dont espèces » (D22).
- **Abonnement** : un bandeau d'état de l'abonnement (essai, actif, délai de grâce, expiré) s'affiche en tête du tableau de bord. En mode dégradé, le bandeau indique « Votre abonnement a expiré. Réabonnez-vous pour télécharger vos quittances. » et les statistiques avancées sont verrouillées (SFD-07 §7.4).

## SFD-06 — Espace locataire (PWA)

### 6.1 Écran d'accueil

Blocs, du plus important au plus détaillé :

1. **Total à régler** (dette cumulée, reports compris), avec la mention « dont X FCFA de report » et, en cas de retard, la date de début du retard ; sinon la date limite et le nombre de jours restants. État « à jour » : prochaine échéance, date limite, crédit déduit s'il y en a.
2. **Actions** : « Payer avec Wave » (Voie A, montant du total à régler) et « J'ai déjà payé directement sur Wave » (Voie B). Libellés indicatifs, sans jargon interne (« Voie A/B », « FIFO »).
3. **Session de paiement** (Voie A) ou **vérification de paiement** (Voie B) en cours, le cas échéant.
4. **Détail mois par mois** : statut, barre de progression, montant payé sur montant dû, reste, date limite ; total à régler en pied. Mention : « un paiement sert d'abord à régler le mois le plus ancien ».
5. **Crédit disponible**, le cas échéant, précisant qu'il est déduit automatiquement de la prochaine échéance, avec la ligne explicite « loyer, crédit appliqué, reste à payer » à l'échéance concernée.

### 6.2 Statuts affichés au locataire

Un mois partiellement payé **et** en retard affiche les **deux** badges (Partiel et En retard). La règle de priorité du rouge (SFD-05) s'applique au tableau de bord propriétaire, pas à l'espace locataire. **(D12)**

### 6.3 Voie A — session de paiement

- Montant **libre**, compris entre **5 000 FCFA** (ou la dette entière si elle est inférieure) et la dette cumulée (D2, D11) ; le montant proposé par défaut est la dette cumulée ; minuteur de la session ; actions « Ouvrir Wave » (deep link) et « Annuler la session ».
- Si une vérification Voie B est en cours, la fenêtre de paiement avertit qu'un surplus éventuel sera mis en crédit.
- **Montant libre (D11, validé)** : le locataire peut payer moins que la dette, avec un minimum de 5 000 FCFA. Le paiement partiel est réparti en FIFO ; le reste demeure dû.
- Échec de la session (refus, solde insuffisant, annulation, expiration) : message d'échec, dette inchangée, possibilité de réessayer ; SMS envoyé (4.8).

### 6.4 Voie B — déclaration et vérification

- Saisie du montant (indicatif) et de la référence Wave (**recommandée mais facultative**). Une référence déjà enregistrée sur un autre paiement est refusée. L'écran rappelle que **le montant retenu est celui confirmé par Wave**.
- Suivi en trois étapes (déclaration reçue, recherche chez Wave, paiement confirmé) avec rappel de l'échéancier de retries (4.4).
- Bouton **« Actualiser maintenant »** pour le locataire, avec **délai minimal de 20 secondes** entre deux actualisations (protection du quota d'appels à l'API Wave) ; il ne consomme pas l'échéancier automatique.
- Au statut **REJETE** (24 h écoulées) : message « introuvable », invitation à vérifier la référence et à déclarer à nouveau, coordonnées du bailleur affichées.

### 6.5 États particuliers

- **Hors connexion** : consultation de la dernière situation connue ; paiement et déclaration désactivés ; bandeau explicite.
- **Dette nulle** : les actions de paiement sont masquées.

### 6.6 Paiements, quittances, crédit et bail

- Historique des paiements **regroupé par paiement** (date, montant, voie, référence Wave) ; les quittances d'un paiement réparti sur plusieurs mois sont listées sous ce paiement.
- Aperçu et téléchargement de chaque quittance ; le « reste dû » imprimé est celui de **l'émission**.
- **Historique du crédit** (4.5) et, après la clôture du bail, mention **À rembourser** tant que le crédit n'est pas soldé.
- Onglet « Mon bail » : logement, bailleur et téléphone, loyer, date limite, début du contrat, début de la gestion dans IziLoyer, **caution versée (et sa restitution)**, numéro Wave **payeur** (masqué) et compte Wave **bénéficiaire** du bailleur (masqué), rappel du principe du SMS unique à J-3.
- **Arriérés avant IziLoyer** : les créances de reprise saisies par le bailleur apparaissent en tête du détail mois par mois, avec libellé, date de saisie et date limite, en lecture seule.
- **Avoir** : le crédit s'affiche avec son équivalent en loyers (« soit N loyer(s) + reste »), cohérent avec le SMS d'avoir.
- **Paiement en espèces** : il apparaît dans l'historique avec l'origine « Espèces, déclaré par le bailleur ». Si le bailleur est en mode dégradé, la quittance affiche « Quittance en cours de préparation » ; le paiement, son montant et son effet sur la dette restent visibles et le locataire peut **toujours payer** (SFD-07 §7.4).

## SFD-07 — Abonnement du bailleur et mode dégradé

### 7.1 Période d'essai

- **Durée : 3 mois (90 jours)** à compter de la création du compte bailleur (calendrier Africa/Abidjan).
- **Plafond : 3 baux actifs au maximum** pendant l'essai (de quoi tester trois échéances mensuelles consécutives). La création d'un 4e bail actif est refusée avec un message explicite ; les baux terminés ne comptent pas.
- Pendant l'essai : toutes les fonctionnalités, aucun paiement d'abonnement.

### 7.2 Grille tarifaire (après l'essai)

| Baux actifs | Tarif d'abonnement mensuel |
|---|---|
| 1 bail | **Gratuit** (formule Starter) |
| 2 à 9 baux | 3 000 FCFA / mois |
| 10 à 19 baux | 5 000 FCFA / mois |
| 20 à 50 baux | 10 000 FCFA / mois |
| Plus de 50 baux | 25 000 FCFA / mois |

- Le palier est déterminé par le **nombre de baux actifs** du bailleur. Règles de calcul proposées (D22) : palier fixé à chaque renouvellement d'après le nombre de baux actifs ce jour-là ; la création d'un bail qui dépasse la capacité du palier en cours exige le règlement du complément (différence entre les deux tarifs, sans prorata, période inchangée).
- Formule **Starter** : un seul bail actif, sans abonnement ni échéance ; elle n'entre jamais en mode dégradé.

### 7.3 États de l'abonnement

| État | Condition | Effet |
|---|---|---|
| ESSAI | Moins de 90 jours depuis la création du compte | Plafond de 3 baux actifs |
| STARTER | Essai terminé et un seul bail actif | Aucune échéance, aucun blocage |
| ACTIF | Période d'abonnement payée en cours | Fonctionnalités complètes |
| GRACE | Échéance dépassée (ou essai terminé avec plus d'un bail actif) sans paiement, depuis moins de **10 jours** | Fonctionnalités complètes, rappels SMS |
| DEGRADE | Délai de grâce de **10 jours** écoulé sans paiement | Mode dégradé (7.4) |

- Un paiement d'abonnement en GRACE ou DEGRADE ramène l'état à ACTIF ; la nouvelle période démarre à la date du paiement (pas de rattrapage rétroactif). Un paiement avant l'échéance prolonge la période en cours.
- Un cron quotidien (00:20 Africa/Abidjan) fait évoluer les états ; il est idempotent.

### 7.4 Mode dégradé

**Principe : le locataire peut toujours payer son loyer. L'encaissement n'est jamais bloqué.**

- **Rien ne change pour l'argent** : Voie A (checkout), Voie B (vérification), webhooks et réconciliation, Voie C (espèces), allocation FIFO, avoirs, génération des échéances, rappels J-3 et SMS de confirmation de paiement au locataire continuent normalement.
- **Quittances PDF verrouillées pour tous (D18)** : tant que le bailleur est en mode dégradé, aucune quittance PDF n'est générée, téléchargeable ou envoyée, ni pour le bailleur, ni pour le locataire. Les quittances sont néanmoins **créées en base** (numéro, montant, date d'origine) à l'état « en attente d'abonnement », puis **produites automatiquement, une seule fois chacune**, dès que le bailleur se réabonne.
- **Statistiques avancées verrouillées** : taux de recouvrement, répartition graphique par statut, simulateur de report et exports. La liste des échéances, les statuts, les indicateurs de base (total perçu, reste à recouvrir), les relances, la Voie C et les déclarations restent accessibles (liste précisée à la conception du tableau de bord, D22).
- **Bandeau d'alerte** sur le tableau de bord du bailleur : « Votre abonnement a expiré. Réabonnez-vous pour télécharger vos quittances. », avec accès direct au paiement de l'abonnement.
- **Côté locataire** : le paiement reste possible et visible ; la quittance indique « Quittance en cours de préparation ». Le SMS de confirmation (montant, date, référence) est envoyé comme d'habitude.

### 7.5 Encaissement des abonnements (flux IziLoyer)

Les abonnements sont encaissés **par IziLoyer** sur son compte Wave de plateforme (distinct du compte Wave de chaque bailleur, P5), selon trois voies :

- **Voie A — In-app (Wave Checkout)** : le bailleur règle son abonnement depuis son espace ; le montant est le tarif de son palier pour un mois ; la confirmation arrive par webhook signé, avec la même sécurité et la même idempotence que les loyers (SFD-04 §4.6).
- **Voie B — Virement Wave externe** : le bailleur saisit la référence du virement envoyé au compte d'IziLoyer ; vérification automatique par l'API Wave, avec les mêmes retries bornés (24 h) ; le montant retenu est celui renvoyé par Wave.
- **Voie C — Règlement manuel / espèces (back-office)** : un **administrateur** IziLoyer enregistre la réception d'un paiement physique (bailleur, montant, date de réception, mode, nombre de mois, note). L'action prolonge ou débloque le compte du bailleur ; elle est réservée au rôle ADMIN, tracée (auteur, date) et protégée contre la double soumission.
- Règles communes (D22) : abonnement **mensuel** ; chaque tranche complète du tarif prolonge d'un mois, le reliquat éventuel est conservé dans un solde d'abonnement ; une période d'abonnement ne peut être créditée qu'une fois (contrainte d'unicité).
- Le reçu ou la facture d'abonnement délivré au bailleur est à définir avec la fiscalité (P5).

### 7.6 SMS aux bailleurs

- **Rappel 1** : le jour de l'échéance de l'abonnement (début du délai de grâce).
- **Rappel 2** : 7 jours après l'échéance (3 jours avant le verrouillage).
- **Confirmation** de réabonnement avec la nouvelle date d'échéance.
- Textes sans accents (un seul SMS) : « IziLoyer: votre abonnement a expire. Reabonnez-vous avant le JJ/MM pour continuer a telecharger vos quittances. Vos encaissements continuent. » ; « IziLoyer: sans reabonnement avant le JJ/MM, les quittances de vos locataires seront suspendues. Vos encaissements continuent. ». Clé d'idempotence : identifiant d'abonnement + type de rappel + période.


## Annexe 1 — Statuts et événements

**Statut de paiement d'une échéance :**

| `statut_paiement` | Déclencheur | Action système |
|---|---|---|
| En attente | Échéance générée, aucun paiement | Incluse dans le rappel J-3 |
| Partiel | `0 < perçu < dû` | Quittance d'acompte ; reste dû reporté dans la dette cumulée |
| Payé | `perçu ≥ dû` | Quittance de solde |

**Indicateur de retard :** `est_en_retard` = date d'échéance dépassée ET statut ≠ Payé ; recalculé par cron quotidien ; badge rouge prioritaire.

**Événements de transaction (journalisés, sans créer de statut d'échéance) :**

| Événement | Effet |
|---|---|
| Paiement accepté | Payment + allocations FIFO + quittances |
| Surplus constaté | Crédit + quittance d'avance + mention dans le SMS de confirmation |
| Application d'un crédit | Allocation de source CREDIT + quittance + ligne explicite |
| Remboursement de crédit déclaré | `CreditRefund` + solde du crédit mis à jour |
| Créance antérieure saisie ou modifiée | Échéance REPRISE créée ou modifiée (audit) ; SMS au locataire en cas d'ajout après la création du bail |
| Avance d'ouverture déclarée | Crédit d'ouverture + quittance d'avance + SMS d'avoir |
| Caution déclarée / restituée | `SecurityDeposit` + reçu de caution à la déclaration |
| Paiement en espèces déclaré (Voie C) | Payment (voie C) + allocations FIFO + quittances (mention « Espèces ») + SMS de confirmation ; avoir si dépassement confirmé |
| Abonnement payé (Voie A, B ou C) | Période prolongée ; retour à l'état ACTIF ; quittances en attente produites ; SMS de confirmation |
| Abonnement expiré (fin du délai de grâce) | Mode dégradé : quittances PDF et statistiques avancées verrouillées ; bandeau d'alerte ; encaissement inchangé |
| Échec (refusé / annulé / expiré) | SMS d'échec, réessai possible |
| Vérification Voie B rejetée | SMS au locataire, nouvelle déclaration possible |

## Annexe 2 — Glossaire FR/EN (référence implémentation)

| Français | Entité technique |
|---|---|
| Bailleur / Propriétaire | Landlord / Owner |
| Locataire | Tenant |
| Local / Lot | Unit |
| Bail | Lease |
| Échéance | Installment |
| Session de paiement Wave | CheckoutSession |
| Vérification de virement (Voie B) | TransferVerification |
| Événement Wave | WaveEvent |
| Paiement (versement accepté) | Payment |
| Affectation d'un paiement à une échéance | PaymentAllocation |
| Quittance | Receipt |
| Crédit (solde créditeur) | Credit (somme des `excédent_restant`) |
| Quittance d'avance | Receipt (type AVANCE) |
| Remboursement de crédit | CreditRefund |
| Créance antérieure (reprise) | Installment (type REPRISE) |
| Avance d'ouverture | Payment (voie OUVERTURE) |
| Caution (dépôt de garantie) | SecurityDeposit |
| Paiement en espèces (Voie C) | Payment (voie C) |
| Abonnement du bailleur | OwnerSubscription |
| Palier tarifaire | SubscriptionTier |
| Paiement d'abonnement | SubscriptionPayment |
| Compte Wave de la plateforme | PlatformWaveAccount |
| Administrateur (back-office) | User (rôle ADMIN) |

---

# PARTIE 3 : SPÉCIFICATIONS TECHNIQUES (STD)

## 1. Stack technique

| Couche | Choix | Justification / notes |
|---|---|---|
| Back-end | **Node.js + NestJS** | Modules imposés, asynchrone, webhooks temps réel |
| Base de données | **PostgreSQL** | ACID, contraintes fortes (données financières) ; PITR requis |
| Queue & jobs | **pg-boss** (sur PostgreSQL) | Jobs PDF/SMS/réconciliation persistés, retries, délais ; pas de service supplémentaire ; création du job dans la **même transaction** que le paiement (alternative : BullMQ + Redis, cf. D8) |
| Authentification | **JWT** (access 15 min + refresh 30 j, rotation et révocation par `jti`) + **API SMS** (OTP, rappels) | Fournisseur SMS à trancher (couverture CI, coût/SMS, API OTP, conformité) |
| Front locataire | **React/Next.js en PWA** | Mobile-first, deep link natif vers Wave |
| Front propriétaire | **React + Tailwind CSS** | Dashboard, badges de statut |
| Génération PDF | **Puppeteer** en worker isolé (repli : `pdf-lib` si contrainte mémoire PaaS) | Rendu HTML/CSS fidèle |
| Paiement | **API Wave Business** (Checkout + Webhooks + recherche de transactions) | Cf. prérequis P1, P2 |
| Hébergement | **PaaS (Render/Railway)** back + BDD ; **Vercel/Netlify** front | Migration VPS possible |

## 2. Architecture applicative (modules NestJS)

```
src/
├── auth/           → OTP (hash, anti-flood), JWT, refresh, révocation
├── users/          → Propriétaires, Locataires
├── properties/     → Sites, Locaux
├── leases/         → Baux, échéances, dette cumulée, fin de bail
├── payments/       → Wave Checkout, Webhooks (signature), Voie B, WaveEvent,
│                     Payment, allocation FIFO, mapping des statuts Wave, réconciliation
├── receipts/       → PDF (worker Puppeteer), numérotation, archivage
├── notifications/  → SMS (invitations, rappels J-3, confirmations, échecs)
├── subscriptions/  → Essai, paliers, états, mode dégradé, paiements d'abonnement (Voies A, B, C)
└── admin/          → Back-office (rôle ADMIN) : enregistrement d'un abonnement réglé hors ligne
```

## 3. Modèle de données

Tous les montants sont des **entiers FCFA** ; toutes les dates techniques sont en UTC.

- **User** : id, nom, prénoms, téléphone (unique, E.164 `+225…`), email, rôle (PROPRIETAIRE / LOCATAIRE / **ADMIN**, ce dernier étant interne à IziLoyer), created_at (point de départ de l'essai pour un bailleur).
- **OwnerWaveAccount** : id, owner_id (**unique** : un seul compte Wave par bailleur en V1), numéro_wave, identifiants API et secret webhook **chiffrés**, statut. **Décision D23** : chaque bailleur a son propre compte. Champs ajoutés : `statut` (ACTIF / A_RECONNECTER / INVALIDE), `derniere_verification_at`, `webhook_token` (identifiant d'acheminement non secret, unique). Les identifiants sont chiffrés au repos ; les clés ne sont jamais renvoyées par l'API.
- **Site** : id, propriétaire_id, nom, commune, ville.
- **Local** : id, site_id, désignation, type, loyer_mensuel (valeur par défaut). *(Statut Libre/Loué dérivé du bail actif.)*
- **Lease** : id, local_id, locataire_id, numéro_wave, loyer_mensuel, **jour_limite** (défaut 5, `CHECK BETWEEN 4 AND 28`), **date_début_contrat** (nullable, informative, antérieure ou égale à la prise d'effet), date_prise_effet (premier mois géré), date_fin (nullable), statut (ACTIF / RESILIE / TERMINE), receipt_seq (compteur, défaut 0).
  - ⚠️ **Index unique partiel** : `UNIQUE(local_id) WHERE statut = 'ACTIF'`.
- **Installment** : id, lease_id, **type** (LOYER / REPRISE), mois (1er du mois ; **NULL pour REPRISE**), **libellé** (obligatoire pour REPRISE), montant_dû, montant_perçu (défaut 0), statut_paiement (EN_ATTENTE / PARTIEL / PAYE), est_en_retard (dénormalisé, recalculé), date_échéance (pour REPRISE : date limite fixée par le bailleur), saisi_par (nullable, renseigné pour REPRISE), created_at.
  - `UNIQUE(lease_id, mois) WHERE type = 'LOYER'` ; `CHECK ((type = 'LOYER') = (mois IS NOT NULL))` ; `CHECK (montant_perçu >= 0 AND montant_perçu <= montant_dû)`.
- **CheckoutSession** : id, **objet** (LOYER / ABONNEMENT), lease_id (nullable pour ABONNEMENT), **owner_id** (renseigné pour ABONNEMENT), wave_session_id (unique), client_reference (unique), montant, statut (OUVERTE / PAYEE / ECHOUEE / EXPIREE), expires_at, created_at.
  - ⚠️ **Index unique partiel** : `UNIQUE(lease_id) WHERE statut = 'OUVERTE'` (une seule session ouverte par bail).
  - ⚠️ **Index unique partiel (abonnements)** : `UNIQUE(owner_id) WHERE objet = 'ABONNEMENT' AND statut = 'OUVERTE'`.
- **TransferVerification** (Voie B) : id, **objet** (LOYER / ABONNEMENT), lease_id (nullable pour ABONNEMENT), **owner_id** (renseigné pour ABONNEMENT), montant_déclaré (indicatif), référence_déclarée (nullable), wave_transaction_id (nullable, unique une fois renseigné), statut (EN_VERIFICATION / VERIFIE / REJETE), tentatives, prochaine_tentative_at, expire_at.
- **WaveEvent** : id, transaction_id, event_type, source (WEBHOOK / RECONCILIATION / VERIF_VOIE_B), statut_brut_wave, montant_brut, date_réception, traité (booléen), payload brut (audit). Champ ajouté : `compte` (OWNER / PLATFORM) distingue les événements des comptes Wave des bailleurs de ceux du compte de la plateforme (abonnements).
  - ⚠️ **`UNIQUE(transaction_id, event_type)`**.
- **Payment** : id, lease_id, wave_event_id (**unique**, nullable), voie (A / B / **C** / **OUVERTURE**), montant (montant Wave ; pour OUVERTURE, avance déclarée ; pour C, montant déclaré par le bailleur), **excédent_initial** (surplus créé ou avance, immuable, défaut 0), excédent_restant (crédit non encore consommé, défaut 0), date_paiement, **date_remise** (voie C, date de remise des fonds), **saisi_par** (voie C et OUVERTURE), **idempotency_key** (voie C) ; `CHECK (excédent_restant >= 0 AND excédent_restant <= excédent_initial)` ; `CHECK ((voie IN ('OUVERTURE','C')) = (wave_event_id IS NULL))` ; `CHECK ((voie = 'C') = (date_remise IS NOT NULL))` ; `UNIQUE(lease_id) WHERE voie = 'OUVERTURE'` (une avance d'ouverture par bail) ; `UNIQUE(lease_id, idempotency_key) WHERE voie = 'C'`.
- **PaymentAllocation** : id, payment_id, installment_id, montant, **source** (PAIEMENT / CREDIT), created_at ; `UNIQUE(payment_id, installment_id)`. Une allocation de source CREDIT impute le crédit d'un paiement antérieur à une nouvelle échéance.
- **Receipt** : id, allocation_id (nullable, **unique**), payment_id (nullable), **deposit_id** (nullable), lease_id, installment_id (nullable), numéro_séquence, type (ACOMPTE / SOLDE / **AVANCE** / **CAUTION**), statut_génération (EN_ATTENTE / **EN_ATTENTE_ABONNEMENT** / GENEREE / ECHEC), url_pdf, date_génération ; `UNIQUE(lease_id, numéro_séquence)`.
  - `CHECK` : ACOMPTE ou SOLDE ⇒ seul `allocation_id` est renseigné ; AVANCE ⇒ seul `payment_id` ; CAUTION ⇒ seul `deposit_id`. **Index uniques partiels** : `UNIQUE(payment_id) WHERE type = 'AVANCE'` et `UNIQUE(deposit_id) WHERE type = 'CAUTION'`.
- **CreditRefund** : id, lease_id, payment_id, refund_ref (regroupe les lignes d'une même déclaration), montant, date_remboursement, mode (texte libre), déclaré_par, created_at. Une déclaration de remboursement crée une ligne par paiement imputé (FIFO) et décrémente `Payment.excédent_restant` dans la même transaction.
- **SecurityDeposit** (caution) : id, lease_id (**unique**), montant, date_réception, mode (texte libre : espèces, Wave…), saisi_par, statut (DETENUE / RESTITUEE), montant_restitué, montant_retenu, motif_retenue, date_restitution (nullable) ; `CHECK (statut = 'DETENUE' OR montant_restitué + montant_retenu = montant)`. La caution n'entre ni dans la dette cumulée, ni dans l'allocation FIFO, ni dans le solde créditeur.
- **PlatformWaveAccount** : id, numéro_wave, identifiants API et secret webhook **chiffrés**, statut (une seule ligne active). Compte de la plateforme pour les abonnements (P5).
- **SubscriptionTier** : code, baux_min, baux_max (nullable pour « plus de 50 »), tarif_mensuel (entier FCFA). Table de configuration de la grille (SFD-07 §7.2).
- **OwnerSubscription** : id, owner_id (**unique**), statut (ESSAI / STARTER / ACTIF / GRACE / DEGRADE), essai_fin, tier_code, période_début, période_fin, grace_fin, solde_abonnement (entier ≥ 0, défaut 0).
- **SubscriptionPayment** : id, owner_id, voie (A / B / C), wave_event_id (**unique**, nullable), montant, mois_couverts, période_début, période_fin, date_réception, saisi_par (administrateur, pour la voie C), note, idempotency_key, created_at ; `CHECK ((voie = 'C') = (wave_event_id IS NULL))` ; `CHECK ((voie = 'C') = (saisi_par IS NOT NULL))` ; `UNIQUE(owner_id, période_début)` ; `UNIQUE(owner_id, idempotency_key)`.
  - **Garde-fou de capacité** : la création d'un bail s'exécute dans une transaction qui verrouille la ligne `OwnerSubscription` (`SELECT … FOR UPDATE`) et compare le nombre de baux actifs au plafond de l'essai ou à la capacité du palier ; deux créations concurrentes ne peuvent pas dépasser la limite.
- **OtpCode** : téléphone, code hashé, expires_at, tentatives, consommé.
- **RefreshToken** : jti (unique), user_id, expires_at, révoqué.
- **SmsLog** : id, destinataire, type, clé_idempotence (unique), statut, date_envoi.
- **AuditLog** : événements sensibles (webhooks rejetés, clôtures de bail, relances manuelles).

> **Intégrité** : l'idempotence est garantie à quatre niveaux : événement (`WaveEvent`), versement (`Payment.wave_event_id`), affectation (`PaymentAllocation`) et quittance (`Receipt.allocation_id`), tous par contraintes d'unicité en base, indépendamment de la logique applicative. Le montant perçu n'est jamais affecté, toujours incrémenté atomiquement. La quittance d'avance est unique par paiement (index partiel).
> **Solde créditeur** d'un bail = somme des `excédent_restant` de ses paiements ; consommé FIFO à chaque nouvelle échéance (allocations de source CREDIT) et par les remboursements déclarés. Invariant, pour chaque paiement : `excédent_initial = excédent_restant + Σ allocations CREDIT + Σ remboursements`. L'avance d'ouverture alimente le solde créditeur au même titre qu'un surplus (`Payment.voie = OUVERTURE`).
> **Numéro de quittance** : attribué dans la transaction d'allocation par `UPDATE lease SET receipt_seq = receipt_seq + 1 … RETURNING receipt_seq` (aucun doublon en concurrence).

## 4. Flux techniques

### 4.1 Voie A

1. `POST /payments/checkout` → calcul de la dette cumulée → création de la `CheckoutSession` (l'index partiel refuse une seconde session ouverte) → appel à l'API Wave Checkout avec `client_reference` → retour de l'URL / deep link.
2. Le locataire valide dans l'application Wave.
3. `POST /webhooks/wave` (URL propre à chaque bailleur : `/webhooks/wave/:webhook_token` ; signature vérifiée avec le **secret du bailleur** concerné) → rattachement par `client_reference` → traitement commun (SFD-04 §4.6).

### 4.2 Voie B

1. `POST /payments/transfers` → création de la `TransferVerification` → job pg-boss différé.
2. Le job interroge l'API Wave (recherche de la transaction correspondante), selon l'échéancier de retries ; si trouvée → création du `WaveEvent` (source `VERIF_VOIE_B`) → traitement commun ; sinon replanification jusqu'à `expire_at`, puis REJETE.

### 4.3 Traitement commun (transaction SQL unique)

Vérification d'unicité du `WaveEvent` → insert `Payment` → `SELECT … FOR UPDATE` sur le bail et ses échéances ouvertes (créances de reprise d'abord par date limite croissante, puis loyers par `mois` croissant) → allocations FIFO + incréments atomiques → recalcul des statuts → insert `Receipt` par allocation (numéro séquentiel) → **en cas de surplus : `excédent_initial = excédent_restant = surplus` et insert d'une `Receipt` de type AVANCE** → jobs PDF et SMS en file (clé = allocation_id / payment_id) → commit. **Mode dégradé (SFD-07)** : si l'abonnement du bailleur est en état DEGRADE, les `Receipt` sont créés avec `statut_génération = EN_ATTENTE_ABONNEMENT` et aucun job PDF ni SMS de quittance n'est mis en file ; le SMS de confirmation de paiement est, lui, toujours mis en file. À la réactivation de l'abonnement, un job produit les quittances en attente (clé d'idempotence : `receipt_id`).

### 4.4 Crons (fuseau Africa/Abidjan)

| Cron | Fréquence | Action |
|---|---|---|
| Génération des échéances | 1er du mois, 00:10 | Baux actifs, idempotent, rattrape les mois manquants, applique les crédits |
| Passage en retard / clôtures de bail | Quotidien, 00:05 | Recalcul `est_en_retard` ; bascule des baux arrivés à `date_fin` |
| Rappel J-3 | Quotidien, 08:00 | Un SMS par bail concerné avec dette > 0 (cumul affiché) |
| Réconciliation Voie A | Toutes les 15 min | Sessions ouvertes sans webhook depuis > 15 min et < 24 h → API Wave |
| Vérifications Voie B | Jobs différés | Retries bornés (24 h max) |
| Abonnements | Quotidien, 00:20 | Transitions ESSAI → STARTER / GRACE → DEGRADE, rappels SMS (échéance, échéance + 7 j), idempotent |
| Rattrapage des quittances | Événementiel (réactivation) | Génère les quittances `EN_ATTENTE_ABONNEMENT` d'un bailleur réabonné |

### 4.5 Mapping des statuts Wave

Table de mapping **centralisée** dans `payments/` (libellés exacts à confirmer avec la documentation Wave Business — prérequis P2) : événement de succès → paiement accepté ; refus / annulation / expiration → événement d'échec.

## 5. Interfaces principales (indicatif)

| Endpoint | Rôle |
|---|---|
| `POST /auth/otp/request`, `POST /auth/otp/verify`, `POST /auth/refresh` | Authentification |
| `POST /leases`, `POST /leases/:id/terminate` | Création et clôture de bail |
| `GET /leases/:id/debt` | Dette cumulée détaillée par mois |
| `POST /payments/checkout` | Voie A |
| `POST /payments/transfers`, `POST /payments/transfers/:id/refresh` | Voie B |
| `POST /payments/sync` | « Vérifier le statut du paiement » |
| `POST /webhooks/wave` | Webhook Wave d'un bailleur (URL par `webhook_token`, signature avec le secret du bailleur) |
| `GET /receipts/:id/pdf` | Téléchargement d'une quittance |
| `GET /leases/:id/credit` | Solde créditeur et historique du crédit (locataire et bailleur) |
| `POST /leases/:id/credit-refunds` | Déclaration d'un remboursement de crédit (bailleur) |
| `POST /leases/:id/opening-balances` | Soldes d'ouverture à la création du bail : créances antérieures, avance (bailleur) |
| `POST /leases/:id/arrears`, `PATCH /arrears/:id` | Ajout ou modification d'une créance antérieure (bailleur) |
| `POST /leases/:id/security-deposit`, `POST /leases/:id/security-deposit/refund` | Déclaration de la caution et de sa restitution (bailleur) |
| `POST /leases/:id/reminders` | Relance manuelle (1 par 24 h) |
| `POST /leases/:id/cash-payments` | Voie C : paiement en espèces déclaré par le bailleur (confirmation explicite si dépassement, clé d'idempotence) |
| `GET /subscription` | État de l'abonnement, palier, échéance (bailleur) |
| `POST /subscription/checkout` | Abonnement, Voie A (Checkout Wave) |
| `POST /subscription/transfers` | Abonnement, Voie B (référence du virement) |
| `POST /admin/subscriptions/:ownerId/payments` | Abonnement, Voie C : enregistrement par un administrateur |
| `POST /webhooks/wave/platform` | Webhook Wave du compte de la plateforme (signature) |
| `POST /owner/wave-account`, `GET /owner/wave-account`, `POST /owner/wave-account/test` | Connexion, état et test du compte Wave du bailleur (clés jamais renvoyées) |

## 6. Sécurité — points non négociables

- Signature Wave vérifiée sur chaque webhook ; rejet journalisé (`AuditLog`).
- Unicité BDD sur `WaveEvent(transaction_id, event_type)`, `Payment.wave_event_id`, `PaymentAllocation`, `Receipt.allocation_id`.
- **Le montant retenu est toujours celui renvoyé par Wave**, jamais celui saisi par le client.
- Incrément atomique du montant perçu et verrouillage du bail pendant l'allocation (pas de lost update entre webhooks parallèles).
- Une seule session de checkout ouverte par bail (index unique partiel).
- Voie B : expéditeur contrôlé, transaction non réutilisable, limitation du nombre de déclarations.
- Remboursement de crédit : déclarable par le bailleur uniquement, montant ≤ solde créditeur, journalisé (`AuditLog`) ; contrainte `excédent_restant >= 0` en base.
- Soldes d'ouverture, créances et caution : écriture réservée au bailleur du bail concerné ; création et modification tracées (`AuditLog`) ; accès en lecture seule pour le locataire.
- **Mode dégradé** : l'état d'abonnement ne conditionne **jamais** la création de `Payment`, d'allocations ou de `Receipt` ; il ne conditionne que la génération et la livraison des PDF et l'accès aux statistiques avancées. Un test automatisé vérifie qu'un paiement de loyer aboutit pour un bailleur en état DEGRADE.
- **Comptes Wave des bailleurs** : un webhook n'est traité que s'il est signé avec le secret du bailleur désigné par son `webhook_token` ; un événement dont le compte destinataire ne correspond pas au compte du bail est rejeté et journalisé ; toutes les requêtes API Wave d'un bailleur utilisent exclusivement ses propres clés.
- **Voie C (loyers)** : écriture réservée au bailleur du bail concerné ; montant entier > 0 ; date de remise ni future ni antérieure à la prise d'effet ; clé d'idempotence ; tracée (`AuditLog`).
- **Back-office** : rôle ADMIN, OTP à chaque session, journalisation complète (`AuditLog`) de chaque enregistrement d'abonnement ; aucun accès aux données de baux au-delà du besoin (à préciser).
- **Abonnements** : webhooks du compte de la plateforme vérifiés par une signature distincte ; mêmes contraintes d'unicité que pour les loyers.
- HTTPS/TLS de bout en bout ; chiffrement au repos ; secrets en variables d'environnement ; identifiants Wave des bailleurs chiffrés.
- JWT : access 15 min, refresh 30 j avec rotation et révocation serveur par `jti`.
- OTP hashé, usage unique, 5 min, 3 tentatives, cooldown progressif, anti-flooding.
- Sauvegardes automatiques **avec PITR**, rétention 30 jours, RTO ≤ 4 h, restauration testée.

## 7. Conformité — Côte d'Ivoire

- **Loi n° 2013-450 du 19 juin 2013** relative à la protection des données à caractère personnel (autorité : **ARTCI**) : formalités préalables de déclaration du traitement avant mise en production ; consentement, minimisation, droits d'accès / rectification / opposition. Vérifier l'état du droit à la date de déploiement.
- **Conservation des quittances et pièces justificatives** : **10 ans** proposés par prudence (référence aux obligations comptables OHADA, dont l'applicabilité à un bailleur particulier est à vérifier) — cf. D7. Données personnelles supprimées ou anonymisées après extinction de la relation et du délai légal.
- **SMS** : identification de l'expéditeur, finalité transactionnelle, opt-out documenté.
- **Litiges** : hors périmètre V1.

## 8. Tests, CI/CD, critères d'acceptation

**Critères d'acceptation clés (testables) :**

1. Double livraison d'un webhook (même `transaction_id`) → 1 seul Payment, aucune quittance en double.
2. Signature invalide → rejet journalisé, zéro effet métier.
3. Paiement partiel puis solde → PARTIEL puis PAYE ; quittances ACOMPTE puis SOLDE ; montant perçu exact.
4. Paiement couvrant deux mois en retard → allocation FIFO (mois le plus ancien soldé d'abord), une quittance par mois.
5. Virement (Voie B) supérieur à la dette → surplus conservé en crédit, **une seule quittance d'avance émise** (même en cas de rejeu), puis crédit appliqué à l'échéance suivante.
6. Même transaction revendiquée deux fois en Voie B → refusée.
7. Vérification Voie B sans transaction retrouvée → REJETE après 24 h, SMS envoyé.
8. Deux demandes de checkout simultanées sur un même bail → une seule session ouverte.
9. Échec Wave → échéance inchangée, SMS d'échec, réessai possible.
10. Webhook jamais reçu → la réconciliation rattrape le statut en moins de 24 h.
11. Webhooks concurrents sur un même bail → montant perçu correct, aucun doublon de numéro de quittance.
12. Bail créé en cours de mois → première échéance immédiate ; cron du 1er rejoué → aucun doublon.
13. Fin de bail → local Libre, aucune échéance future, dette résiduelle visible, historique intact.
14. Deux baux actifs sur un même local → impossible (contrainte BDD).
15. 3 OTP erronés → blocage + cooldown progressif.
16. Échéance partielle en retard → badge 🔴 (priorité retard).
17. Rappel J-3 → un seul SMS par contrat, montant cumulé correct.
18. Application d'un crédit à une échéance → allocation de source CREDIT, `excédent_restant` décrémenté sans jamais devenir négatif, ligne « crédit appliqué » affichée, quittance émise.
19. Crédit couvrant tout un loyer → échéance Payé sans nouveau versement ; ce montant n'entre pas dans le « total perçu ».
20. Fin de bail avec crédit restant → mention « À rembourser » ; la déclaration du remboursement ramène le solde à 0 ; un montant supérieur au solde est refusé.
21. Déclaration Voie B avec une référence déjà enregistrée → refusée ; actualisation manuelle répétée dans les 20 secondes → refusée.
22. Bail créé avec une créance antérieure → échéance REPRISE créée avec la date limite fixée par le bailleur ; un paiement règle d'abord cette créance (FIFO) ; elle passe en retard si sa date limite est dépassée.
23. Modification d'une créance de reprise → refusée sous le montant déjà perçu, tracée dans `AuditLog` ; ajout après la création du bail → SMS d'information au locataire.
24. Avance d'ouverture à la création du bail → crédit créé avant la première échéance et appliqué à celle-ci dans la même transaction ; une seule quittance d'avance ; une seconde avance d'ouverture sur le même bail est refusée.
25. Caution saisie → un seul reçu de caution ; absente de la dette et du solde créditeur ; restitution déclarée avec retenues → montant restitué + montant retenu = montant de la caution.
26. SMS d'avoir : à la création d'un crédit, un seul SMS (fusionné avec la confirmation) ; à l'application d'un crédit, un SMS le jour de la génération de l'échéance ; équivalent en loyers exact (partie entière + reste) ; aucun doublon en cas de rejeu.
27. Essai : création d'un 4e bail actif → refusée ; deux créations concurrentes du 3e bail → une seule aboutit.
28. Fin de l'essai (90 jours) avec au moins 2 baux actifs et sans paiement → GRACE, puis DEGRADE après 10 jours ; avec un seul bail actif → STARTER, aucun blocage.
29. Palier tarifaire correct aux bornes (1, 2, 9, 10, 19, 20, 50, 51 baux actifs).
30. Mode dégradé : un paiement de loyer (Voie A, B ou C) est accepté, alloué FIFO, les quittances sont créées « en attente d'abonnement », aucun PDF n'est généré, le SMS de confirmation est envoyé.
31. Mode dégradé : ni le bailleur ni le locataire ne peuvent télécharger de quittance PDF ; les statistiques avancées sont verrouillées ; le bandeau affiche le texte exact prévu.
32. Réabonnement (Voie A, B ou C) → ACTIF ; les quittances en attente sont produites une seule fois chacune, avec leur numéro et leur date d'origine.
33. Webhook d'abonnement rejoué → un seul `SubscriptionPayment`, une seule prolongation.
34. Voie C abonnement : réservée au rôle ADMIN, tracée ; double soumission avec la même clé → une seule prolongation.
35. Voie C loyers, montant ≤ dette → allocations FIFO, quittance portant « Mode de règlement : Espèces (Déclaré par le bailleur) », SMS au locataire.
36. Voie C loyers, montant > dette → avertissement ; sans confirmation, aucun enregistrement ; avec confirmation, l'excédent devient un avoir avec quittance d'avance et SMS d'avoir.
37. Voie C loyers : date de remise future ou antérieure à la prise d'effet → refusée ; double soumission avec la même clé → un seul paiement.
38. Rappels d'abonnement : exactement deux SMS (échéance et échéance + 7 jours), aucun doublon en cas de rejeu du cron.
39. Inscription d'un bailleur : connexion Wave testée avant activation ; création d'un bail refusée tant que le compte Wave n'est pas ACTIF.
40. Webhook signé avec le secret d'un autre bailleur (ou acheminé vers le mauvais `webhook_token`) → rejeté, journalisé, aucun effet métier.
41. Compte Wave en état À RECONNECTER → checkout refusé avec message au locataire, bailleur alerté, Voies B et C toujours opérationnelles ; clés jamais présentes dans les réponses de l'API ni dans les journaux.

**Stratégie de tests :** unitaires (machine à états, calcul du retard, allocation FIFO, crédit), intégration (signature HMAC, livraison double et parallèle simulée, Wave simulé pour Voie B), E2E (parcours locataire complet, Voie A et Voie B).

**CI/CD :** GitHub Actions, migrations versionnées (TypeORM ou Prisma), environnements dev / staging / prod, Sentry + health checks, alerte sur taux d'échec de réconciliation et de vérifications Voie B.

---

# PRÉREQUIS TECHNIQUES OUVERTS

| # | Prérequis | Impact |
|---|---|---|
| P1 *(recherches en cours)* | Confirmer que l'API Wave Business permet la **recherche ciblée d'une transaction par référence** (et non un simple listing complet) | Fiabilité de la Voie B ; repli possible : filtrage du listing par numéro expéditeur, montant et fenêtre de temps |
| P2 *(recherches en cours)* | Confirmer le mécanisme exact de **signature des webhooks**, la durée de validité des sessions de checkout (et la possibilité de les expirer côté serveur) et les libellés de statuts | Sécurité, réconciliation, table de mapping |
| P3 *(reporté à plus tard)* | Choisir le **fournisseur SMS** (couverture CI, coût/SMS, OTP, conformité) | Coût et fiabilité des notifications |
| P4 *(tranché : D23)* | ~~Modèle de compte Wave des bailleurs~~ : **chaque bailleur connecte son propre compte Wave Business** (clés API chiffrées). Reste à confirmer avec Wave que l'accès API Wave Business est ouvert à des bailleurs particuliers (conditions d'ouverture, frais, quotas) ; avec le cadre juridique et fiscal | Modèle de données (`OwnerWaveAccount`), cadre juridique et fiscal |
| P5 | Ouvrir et confirmer le **compte Wave Business de la plateforme IziLoyer** (Checkout, webhooks, recherche de transactions) pour les abonnements ; définir le **reçu ou la facture d'abonnement** et la fiscalité applicable (immatriculation, TVA) | Encaissement des abonnements (SFD-07), cadre fiscal |
| P6 | Décider comment **corriger ou annuler une saisie en espèces erronée** (Voie C) : écriture d'annulation tracée, délai, effet sur les quittances | Intégrité de la dette et des quittances |

# DÉCISIONS PRODUIT À VALIDER

| # | Décision retenue | Alternative |
|---|---|---|
| D1 | Pas de prorata en V1 (échéance pleine) | Prorata dès la V1 |
| D2 | Checkout borné à la **dette cumulée**, une seule session ouverte par bail | Montant libre |
| D3 | **Voie B conservée** ; surplus converti en crédit appliqué automatiquement | Remboursement du surplus / refus des virements hors checkout |
| D4 | Date de fin de bail optionnelle (reconduction tacite) | Date de fin obligatoire |
| D5 | Profil Gestionnaire en V2 | Gestionnaire simple en V1 |
| D6 | Rappel automatique unique à J-3 + relance manuelle ; **aucune relance automatique de retard** en V1 | Ajouter des relances de retard (ex. J+3, J+7) |
| D7 | Conservation des quittances **10 ans** — **confirmé** | 3 ans (décision antérieure) |
| D8 | File de jobs **pg-boss** (PostgreSQL) | BullMQ + Redis |
| D9 | Sauvegardes avec **PITR** | Sauvegarde quotidienne seule (RPO 24 h) |
| D10 | Jour limite borné 4–28 ; bail rétroactif limité au mois en cours ; première échéance : `max(jour limite, prise d'effet + 5 jours)` | Bornes différentes / bail rétroactif libre |
| D11 | **Montant libre en Voie A** : le locataire peut payer moins que la dette dans l'app (montant libre borné par un minimum de **5 000 FCFA**) — **validé** | D2 strict (montant = dette cumulée) |
| D12 | Espace locataire : un mois partiel **et** en retard affiche **deux badges** ; la priorité du rouge est réservée au tableau de bord propriétaire | Priorité du retard aussi côté locataire |
| D13 | Application d'un crédit : **quittance émise** (mode « Crédit ») et crédit appliqué **hors « total perçu »** du tableau de bord propriétaire | Pas de quittance à l'application ; crédit compté comme encaissement |
| D14 | Créance antérieure : ajout ou modification **après** la création du bail autorisés (traçabilité, SMS d'information au locataire, montant dû ≥ montant perçu) | Saisie uniquement à la création du bail |
| D15 | **Avance et caution déclaratives** (remises en main propre, la déclaration du bailleur fait foi) ; quittance d'avance et reçu de caution émis par IziLoyer sur cette base ; restitution de la caution déclarée par le bailleur avec retenues motivées | Paiement de l'avance ou de la caution par Wave Checkout ; aucun reçu pour les remises hors Wave |
| D16 | **Essai** de 3 mois (90 jours), limité à **3 baux actifs** | Essai plus long ou sans plafond |
| D17 | **Grille d'abonnement** : 1 bail gratuit (Starter) ; 2 à 9 : 3 000 FCFA ; 10 à 19 : 5 000 FCFA ; 20 à 50 : 10 000 FCFA ; plus de 50 : 25 000 FCFA, par mois | Autre grille ou tarif unique |
| D18 | **Mode dégradé** : l'encaissement des loyers n'est jamais bloqué ; les quittances PDF (bailleur **et** locataire) et les statistiques avancées sont verrouillées jusqu'au réabonnement ; bandeau d'alerte | Quittances toujours disponibles pour le locataire |
| D19 | **Délai de grâce de 10 jours** après l'échéance, avec **2 rappels SMS** (échéance, échéance + 7 jours) | Aucun délai ; 15 jours |
| D20 | **Voie C loyers** : paiement en espèces saisi par le bailleur ; avertissement en cas de dépassement de la dette, surplus en **avoir** après confirmation | Refus de tout dépassement |
| D21 | **Abonnements encaissés par IziLoyer** en trois voies : A (Checkout), B (virement vérifié), C (administrateur, back-office) | Voie A seule |
| D22 | **Hypothèses de conception à valider** : (a) palier fixé au renouvellement, création d'un bail au-delà du palier soumise au règlement du complément ; (b) abonnement mensuel avec solde d'abonnement ; (c) espèces comptées dans le « total perçu » (ligne « dont espèces ») ; (d) liste des « statistiques avancées » ; (e) SMS de confirmation de paiement toujours envoyé, y compris en mode dégradé ; (f) rappels à J0 et J+7 | À trancher avec le porteur du projet |
| D23 | **Compte Wave propre à chaque bailleur** (P4 tranché) : connexion et test à l'inscription, aucun bail sans compte Wave actif, webhook et secret propres à chaque bailleur ; IziLoyer ne détient jamais les loyers | Compte marchand unique de la plateforme |

> **Décisions arrêtées lors de la révision v1.2** (hors tableau) : quittance d'avance émise immédiatement ; ligne explicite du crédit appliqué à l'échéance suivante ; historique du crédit visible du locataire et du bailleur ; en fin de bail, le bailleur rembourse le crédit restant. Le bailleur fixe la date limite d'une créance antérieure ; l'avance sur loyers et la caution sont saisies par le bailleur (remises physiques à l'entrée dans les lieux) ; un SMS d'avoir est envoyé à la création du crédit et à son application, avec l'équivalent en nombre de loyers. Règles d'abonnement : essai de 90 jours limité à 3 baux actifs, grille par palier, mode dégradé qui ne bloque jamais l'encaissement mais verrouille les quittances PDF de tous et les statistiques avancées après 10 jours de grâce et 2 SMS ; Voie C (espèces) pour les loyers, avec avertissement de dépassement et surplus en avoir après confirmation ; abonnements encaissés par IziLoyer (Voies A, B et C administrateur). Ces règles figurent dans la v1.2 et non dans une v1.3.
