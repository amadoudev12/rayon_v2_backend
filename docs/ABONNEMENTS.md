# Abonnements Rayon — règles, calculs et exploitation

Référence métier : *Cahier des charges fonctionnel et technique — système
d'abonnement* (v1.0). Ce document décrit ce qui est **implémenté** : phase 2
(fondations) et phase 3 (paiements, reçus, notifications). Le compte SasPay
n'étant pas encore approuvé, les paiements passent pour l'instant par
**Mobile Money hors ligne confirmé par l'administration** ; SasPay s'ajoutera
comme adaptateur (§11), sans changer le reste.

## 1. Décisions métier (validées le 2026-11-21)

| Sujet | Décision |
|---|---|
| Organisations existantes sans abonnement | Restent **non soumises** (aucune limite) jusqu'à une attribution manuelle par l'administration. Aucun essai ni forfait attribué automatiquement. |
| Fonctions BUSINESS pour un client STARTER | **Bloquées** (écritures ; voir §5). |
| Prorata d'une mise à niveau | `⌈ (prix mensuel cible − prix mensuel actuel) × jours restants ÷ 30 ⌉`, prix du **catalogue**. |
| Paiement pendant l'essai | Effet **immédiat** : la période payée commence à la confirmation, l'essai prend fin. |
| Qui gère l'abonnement | Le **propriétaire** uniquement (`subscription:manage`). Tous les membres consultent. |
| Éligibilité à l'essai | Toute nouvelle organisation, quel que soit son pays. |

## 2. Catalogue (`src/services/billing/plans.ts`)

Seule source des prix, quotas et fonctionnalités. Devise : XOF. Durées : 1, 3,
6, 12 mois. Prix = prix mensuel × mois, **sans remise**.

| Forfait | Mensuel | 3 mois | 6 mois | 12 mois | Boutiques | Utilisateurs (propriétaire inclus) |
|---|---|---|---|---|---|---|
| STARTER | 7 500 | 22 500 | 45 000 | 90 000 | 1 | 2 |
| BUSINESS | 10 000 | 30 000 | 60 000 | 120 000 | 2 | 5 |
| PREMIUM | 15 000 | 45 000 | 90 000 | 180 000 | 10 | 10 |

Le catalogue est en code (et non en table) : il est relu à chaque requête sans
accès à la base, versionné et testé ; le montant facturé est figé sur chaque
paiement, donc changer un prix ne réécrit jamais l'historique.

Un code de forfait inconnu (abonnement saisi avant le catalogue, ex :
« essentiel ») est traité comme **PREMIUM** : aucun client existant ne perd de
droits.

Les fonctionnalités PREMIUM **non développées** (transferts de stock,
permissions avancées, rapports avancés, suivi détaillé des activités, analyse
globale des performances, tableau de bord consolidé) sont marquées
`available: false` dans le catalogue : elles s'affichent « à venir », jamais
comme un avantage disponible.

## 3. États d'un abonnement (`src/services/billing/rules.ts`)

Toutes les dates sont en UTC ; les droits sont **calculés à chaque requête**
à partir des dates (aucune tâche planifiée n'est nécessaire pour qu'une
expiration prenne effet).

| Phase | Condition | Accès |
|---|---|---|
| Non soumise | aucune ligne `Abonnement` | complet, sans limite |
| Essai | `statut = TRIAL` et `essaiFinLe > maintenant` | complet, droits PREMIUM |
| Essai terminé | `statut = TRIAL` et `essaiFinLe ≤ maintenant` | **lecture seule immédiate** (pas de grâce) |
| Active | `periodeFin > maintenant` | complet, droits du forfait |
| Grâce | `periodeFin ≤ maintenant < periodeFin + 7 j` | complet (jours 1 à 7) |
| Expirée | `maintenant ≥ periodeFin + 7 j` | **lecture seule** à partir du 8e jour |
| Suspendue | `statut = SUSPENDED` (administration) | lecture seule, motif distinct |

En lecture seule, l'API renvoie **402** `SUBSCRIPTION_INACTIVE` avec
`errors.reason` (`TRIAL_ENDED`, `EXPIRED`, `SUSPENDED`, `CANCELLED`) sur toute
écriture. Restent ouverts : toutes les lectures et exports autorisés par le
forfait, la page et les actions d'abonnement (`/api/subscription/**`), le
choix de la boutique affichée et la déconnexion des autres appareils. Aucune
donnée n'est jamais supprimée.

Essai : 14 jours calendaires (`now + 14 × 24 h`), créé dans la transaction de
création de l'organisation (inscription ou administration). Un seul essai par
organisation : `essaiDebutLe` renseigné = essai consommé ; l'administration ne
peut pas le relancer.

## 4. Renouvellement, souscription, changements de forfait

Le montant et la période sont **toujours calculés par le serveur**, une
première fois pour le devis (`POST /api/subscription/quote`), puis de nouveau
**à la confirmation du paiement** sur la ligne verrouillée
(`applyConfirmedPurchase`) : l'état a pu changer entre-temps.

Les mois sont calendaires ; un jour inexistant est ramené au dernier jour du
mois : 30 novembre + 3 mois = 28 février (29 les années bissextiles).

| Situation au moment de la confirmation | Début de la nouvelle période |
|---|---|
| Avant l'échéance | ancienne échéance (jours payés conservés) |
| Pendant les 7 jours de grâce | ancienne échéance (jours de grâce non offerts) |
| Après la grâce, essai en cours ou terminé, aucun abonnement | date de confirmation |

**Avant l'échéance**, un renouvellement :

- du même forfait : prolonge ;
- d'un forfait **inférieur** : prolonge et programme la rétrogradation à
  l'échéance actuelle ;
- d'un forfait **supérieur** : refusé (`UPGRADE_REQUIRED`) — faire d'abord la
  mise à niveau au prorata, puis renouveler.

Pendant la grâce ou après, le forfait choisi s'applique directement.

### Mise à niveau (forfait supérieur, période payée en cours)

Immédiate après paiement ; l'échéance ne change pas.

```
jours restants = ⌈ (periodeFin − maintenant) / 24 h ⌉      (jour entamé compté)
montant        = ⌈ (prix mensuel cible − prix mensuel actuel) × jours restants ÷ 30 ⌉
```

Arrondi au franc supérieur (le XOF n'a pas de centimes), prix du catalogue.

| Exemple | Calcul | Montant |
|---|---|---|
| BUSINESS → PREMIUM, 45 j | 5 000 × 45 ÷ 30 | 7 500 |
| STARTER → BUSINESS, 10 j | 2 500 × 10 ÷ 30 = 833,33 | 834 |
| STARTER → PREMIUM, 1 j | 7 500 × 1 ÷ 30 | 250 |

Refusée pendant l'essai (souscrire directement), pendant la grâce ou après
(renouveler avec le forfait voulu), vers un forfait égal ou inférieur, ou si
une rétrogradation est programmée (l'annuler d'abord).

### Rétrogradation (forfait inférieur)

Programmée à l'échéance (`forfaitProgramme`, `forfaitProgrammeLe`), annulable
jusque-là, sans remboursement. Elle s'applique aux droits **dès l'échéance**
(calcul à la requête) ; la tâche de maintenance l'inscrit ensuite en base et
dans l'historique (`PLAN_CHANGED`), une seule fois.

Au-delà des nouveaux quotas, rien n'est supprimé : les boutiques et
utilisateurs existants restent ; seules les **nouvelles** créations sont
bloquées, et `GET /api/subscription` signale `usage.*.overLimit`.

## 5. Fonctionnalités et quotas (`src/services/billing/entitlements.ts`)

Contrôles centralisés, appliqués côté serveur à chaque requête : une requête
HTTP directe est refusée comme l'interface. Ils ne s'appliquent que si
`SUBSCRIPTIONS_ENFORCED=true` et à une organisation soumise.

Règle : les **écritures** d'une fonctionnalité exigent le forfait ; les données
déjà enregistrées restent consultables. Les fonctionnalités qui sont des
lectures (exports, analyses) exigent le forfait.

| Clé | Forfait | Routes contrôlées |
|---|---|---|
| `purchases` | BUSINESS | `POST /api/purchases`, `/:id/payments`, `/:id/cancel` |
| `suppliers` | BUSINESS | `POST/PUT/DELETE /api/suppliers`, `/:id/restore` |
| `advanced_stock` | BUSINESS | écritures `/api/inventories/**`, `PUT /api/stock/threshold`, `GET /api/stock/valuation`, page `/stock/rapports` |
| `losses` | BUSINESS | `POST /api/losses`, `/:id/cancel` |
| `quotes` | BUSINESS | `POST`, `DELETE /api/quotes` |
| `csv_export` | BUSINESS | `GET /api/exports/**` |
| `advanced_discounts` | BUSINESS | `PUT /api/organization` lorsqu'un plafond de remise change |
| `margin_analysis` + `net_profit` | BUSINESS | coûts, marges et bénéfices masqués (tableau de bord, ventes, statistiques, créances, export) |

Refus : **403** `PLAN_FEATURE_REQUIRED`, `errors: { feature, requiredPlan }`.

Quotas : boutiques (`POST /api/stores`) et utilisateurs, propriétaire inclus
(`POST /api/members`). Vérifiés dans la transaction de création, organisation
**verrouillée** (`SELECT … FOR UPDATE`) : des requêtes simultanées ne peuvent
pas dépasser la limite. Refus : **403** `PLAN_QUOTA_REACHED`,
`errors: { quota, limit, used, plan }`.

## 6. API client (`/api/subscription`)

| Route | Accès | Rôle |
|---|---|---|
| `GET /` | tous les membres, même en lecture seule | état, abonnement, utilisation des quotas, catalogue, `canManage` |
| `GET /history` | propriétaire | historique des changements |
| `POST /quote` `{ type: "PERIOD", plan, months }` ou `{ type: "UPGRADE", plan }` | propriétaire | devis serveur (tout montant envoyé par le client est ignoré) |
| `POST /scheduled-change` `{ plan }` | propriétaire | programme une rétrogradation |
| `DELETE /scheduled-change` | propriétaire | l'annule |

## 7. Données (migrations `20261121120000_abonnements_fondations` et `20261122120000_paiements_recus_notifications`)

Additive et non destructive (colonnes nullables, une table) ; vérifiée par
`scripts/verify-migration-subscriptions.sh` sur données historiques.

- `Organisation.pays` (ISO alpha-2, facultatif ; déduit de l'indicatif du
  téléphone à l'inscription s'il n'est pas saisi).
- `Abonnement` : `essaiDebutLe`, `forfaitProgramme`, `forfaitProgrammeLe`,
  `suspenduLe`, `motifSuspension` ; contrainte de cohérence de la
  rétrogradation programmée.
- `HistoriqueAbonnement` (ajout seul) : action, ancien et nouveau forfait,
  statut, échéance, motif, auteur, métadonnées.
- `PaiementAbonnement` complété : référence interne, achat (type, forfait,
  durée), montant reçu, moyen, date de confirmation, motif, organisation ;
  `referenceExterne` et `abonnementId` deviennent facultatifs ; statuts
  `CANCELLED` et `UNDER_REVIEW`. Reprise : `organisationId` des paiements
  existants renseigné depuis leur abonnement (seule écriture sur l'existant).
- `RecuAbonnement`, `EvenementPaiement`, `Notification`.

Après déploiement sur Supabase : relancer `scripts/supabase-audit.sql` puis,
si nécessaire, `scripts/supabase-hardening.sql` pour les nouvelles tables.
PostgreSQL 12 ou plus (deux valeurs d'énumération ajoutées dans une migration).

## 8. Tâche planifiée (`src/jobs/subscription-jobs.ts`)

Lancée par le serveur (toutes les 60 minutes par défaut), en trois étapes
indépendantes : rétrogradations échues, rapprochement des paiements, rappels
d'échéance. Idempotente et sûre avec plusieurs instances. Les droits n'en
dépendent pas.

## 9. Paiements (`src/services/billing/payments.ts`)

### Parcours

1. Le propriétaire choisit forfait et durée : `POST /api/subscription/payments`
   `{ type, plan, months }`. Le **serveur** calcule le montant (tout montant
   envoyé par le client est ignoré) et crée une transaction `PENDING` avec une
   **référence interne unique** (`RAY-XXXXXXXXXX`).
2. Paiement hors ligne : le client reçoit les instructions
   (`SUBSCRIPTION_MANUAL_PAYMENT_INSTRUCTIONS`, montant, référence).
   Prestataire en ligne : il reçoit l'URL de paiement.
3. **Confirmation** de l'argent reçu : par l'administration
   (`POST /api/admin/subscription-payments/:id/confirm` : montant reçu, moyen,
   référence de l'opération, date de réception) ou par le prestataire
   (webhook dont la signature est vérifiée, puis statut réel relu).
4. **Activation**, dans une seule transaction de base : achat recalculé à la
   date de confirmation, abonnement activé ou prolongé, **reçu** émis,
   historique, propriétaire **notifié**.

Un retour du navigateur n'est jamais une preuve de paiement : seule l'étape 3
modifie l'abonnement.

### Statuts d'une transaction

| Statut | Sens | Effet sur l'abonnement |
|---|---|---|
| `PENDING` | créée, non payée (ou reçue, en attente d'activation) | aucun |
| `SUCCEEDED` | confirmée et activée, reçu émis | appliqué une fois |
| `FAILED` | échec (prestataire, ou refus de l'administration) | aucun |
| `CANCELLED` | abandonnée par le client, remplacée, ou expirée après 7 jours | aucun |
| `UNDER_REVIEW` | argent reçu mais non applicable : montant ou devise incorrects, abonnement suspendu, mise à niveau devenue impossible, paiement d'une transaction abandonnée | aucun ; traitée par l'administration |

Une seule transaction en attente par organisation : redemander le même achat
renvoie la même transaction ; un autre achat remplace l'ancienne (annulée).
Les transactions ne sont jamais supprimées.

### Idempotence et double traitement

- Ligne de paiement verrouillée (`SELECT … FOR UPDATE`) ; une transaction
  `SUCCEEDED` n'est jamais réactivée (rejeu = `replay: true`, sans effet).
- Un seul reçu par paiement (contrainte d'unicité), une notification par clé.
- Webhook : chaque notification est enregistrée une fois (fournisseur,
  identifiant d'événement) ; un doublon répond `DUPLICATE` sans effet.

### Rapprochement (tâche horaire, ou `POST /api/admin/subscription-payments/reconcile`)

- Paiement **reçu mais non activé** (panne entre confirmation et activation) :
  l'activation est rejouée, une seule fois.
- Transaction en ligne restée en attente (notification manquante) : le statut
  est relu auprès du prestataire.
- Transaction non payée depuis 7 jours : `CANCELLED`.

### Reçus (`RecuAbonnement`)

Numéro unique `REC-AAAA-NNNNNN`, organisation, référence de transaction et
de l'opération, forfait, type d'achat, durée, montant payé, devise, moyen de
paiement, date de confirmation, début et fin de validité. Figés à l'émission,
jamais réécrits. `GET /api/subscription/receipts[/:id]` (propriétaire) ; le
PDF téléchargeable sera produit par l'interface (phase 4).

### Journal des événements (`EvenementPaiement`)

Création, demande au prestataire, notification reçue ou **rejetée**
(signature invalide : rien du corps n'est conservé), argent reçu, activation,
mise en vérification, refus, rapprochement — avec l'auteur.

## 10. Notifications intégrées (`src/services/notifications.ts`)

Destinées au **propriétaire** : titre, message, date, lu ou non lu, lien vers
`/abonnement`. Une clé unique par organisation empêche toute répétition.

| Événement | Quand |
|---|---|
| Rappels J-7, J-3, dernier rappel J-1 | tâche horaire ; seul le palier courant est émis |
| Expiration | jour de l'échéance (ou plus tard pendant la grâce si la tâche l'a manqué) |
| Lecture seule | 8e jour après l'échéance ; fin d'essai |
| Paiement confirmé | à l'activation |
| Changement de forfait | activation d'un nouveau forfait, application d'une rétrogradation |

Les rappels d'échéance ne sont émis que si `SUBSCRIPTIONS_ENFORCED=true`.
API : `GET /api/notifications[?unread=true]`, `POST /api/notifications/:id/read`,
`POST /api/notifications/read-all` (chaque utilisateur ne voit que les siennes).

## 11. Brancher SasPay (dès l'approbation du compte)

Rien n'est supposé : endpoints, paramètres, signature et statuts viendront
**exclusivement** de la documentation officielle.

1. Écrire `src/services/billing/providers/saspay.ts` qui implémente
   `SubscriptionPaymentProvider` (`provider.ts`) : `createCheckout`,
   `verifyNotification` (signature officielle, sinon
   `InvalidNotificationError`), `fetchTransaction` (statut réel).
2. L'enregistrer au démarrage (`registerProvider`) ; identifiants lus dans
   `backend/.env`, jamais journalisés ni renvoyés.
3. URL de notification à déclarer chez SasPay :
   `https://<api>/api/webhooks/payments/saspay`.
4. Tests en Sandbox, puis `SUBSCRIPTION_PAYMENT_PROVIDER=saspay` après
   validation explicite. Le paiement hors ligne reste disponible.

## 12. Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `SUBSCRIPTIONS_ENFORCED` | `false` | Active les blocages (lecture seule, fonctionnalités, quotas) et les rappels d'échéance. Décision commerciale. |
| `SUBSCRIPTION_JOBS_INTERVAL_MINUTES` | `60` | Période de la tâche (maintenance, rapprochement, rappels) ; `0` la désactive. |
| `SUBSCRIPTION_PAYMENT_PROVIDER` | vide | Prestataire en ligne ; vide = paiement hors ligne confirmé par l'administration. |
| `SUBSCRIPTION_MANUAL_PAYMENT_INSTRUCTIONS` | texte générique | Instructions de paiement hors ligne (numéros Mobile Money de Rayon). |

`SUBSCRIPTION_GRACE_DAYS` n'est plus lue : le délai de grâce est une règle
contractuelle fixée à 7 jours dans le catalogue.

## 13. Tests

```
npm run test:db:up                               # base PostgreSQL de test isolée (Docker)
npx vitest run tests/subscription-rules.test.ts  # règles pures
npx vitest run tests/subscription-system.test.ts # intégration HTTP + base
npx vitest run tests/subscription-payments.test.ts # paiements, reçus, webhooks, notifications
npm test                                         # suite complète (non-régression)
npm run db:check                                 # migrations = schema.prisma
bash scripts/verify-migration-subscriptions.sh   # migration sur données historiques
```

## 14. Interfaces client (phase 4)

Aucune règle métier dans les interfaces : prix, devis, droits, quotas et dates
viennent du serveur ; l'interface ne fait que guider (le serveur valide tout).

**Site web** (`frontend/src/app/(app)/abonnement/`, route `/abonnement`,
données `GET /api/pages/abonnement`) :

- forfait actuel, état, échéance, fin de grâce, quotas utilisés, changement
  programmé (annulable), alerte de dépassement ;
- état du paiement en attente : référence à indiquer, montant, instructions,
  actualisation, annulation ;
- forfaits et choix de la durée, comparaison des fonctionnalités (« à venir »
  pour celles non développées) ;
- récapitulatif de commande = devis serveur, puis paiement ;
- historique des paiements, des abonnements, reçus (impression, PDF, partage) ;
- cloche de notifications dans l'en-tête ; bandeau d'état avec lien ;
- barre latérale : rubriques hors forfait signalées par le forfait requis
  (cadenas), toujours consultables ; page hors forfait expliquée
  (`PLAN_FEATURE_REQUIRED`) au lieu d'une erreur.

**Application mobile** (`mobile/src/app/(app)/subscription.tsx`,
`notifications.tsx`) : état et quotas, paiement en attente, forfaits et
durées, devis serveur, paiement, historique des paiements et reçus (PDF sur le
site), notifications ; accès depuis l'onglet Compte et le bandeau de
l'accueil. La rétrogradation se programme sur le site.

Le cadre du site (`/api/pages/shell`) et `GET /api/me` (mobile) renvoient
`entitlements` (forfait, fonctionnalités non incluses) et
`unreadNotifications`.

## 15. Administration centrale (phase 5)

Réservée aux super administrateurs (`/api/admin/**`, `/admin/**`) ; un membre
d'organisation reçoit 403 sur chacune de ces routes (testé).

**Pages** : `/admin/abonnements` (tableau de bord et liste filtrable),
`/admin/paiements` (transactions, incohérences, confirmation), `/admin/journal`
(journal d'audit), et le volet *Abonnement* de `/admin/boutiques/:id`.

**Tableau de bord** (`GET /api/admin/subscriptions/dashboard`) : organisations,
sans abonnement, essais, actifs, délai de grâce, lecture seule (expirés, fins
d'essai, suspendus), abonnements payés par forfait, échéances sous 7 jours,
paiements confirmés / en attente / à vérifier, chiffre d'affaires par mois
(12 mois). Les états sont calculés avec les mêmes règles que les droits.

**Interventions** (motif obligatoire, 5 caractères au moins) :

| Route `POST /api/admin/organizations/:id/subscription/…` | Effet |
|---|---|
| `assign` `{ plan, months?, motif }` | avec durée : période accordée (prolonge la période payée en cours, sinon commence aujourd'hui) ; sans durée : change le forfait d'une période payée en cours |
| `extend` `{ jusquAu, motif }` | prolonge l'échéance (essai ou période payée) ; postérieure à l'actuelle, trois ans au plus |
| `suspend` `{ motif }` | suspension administrative : lecture seule, distincte de l'expiration ; aucun achat possible |
| `reactivate` `{ motif }` | rétablit le statut d'avant la suspension (essai ou période payée) |
| `trial` `{ motif }` | essai gratuit pour une organisation qui n'a jamais eu d'abonnement |

Chaque intervention écrit, dans une seule transaction : la modification,
l'historique de l'abonnement (auteur, motif), le **journal d'audit**
(`JournalAdministration` : administrateur, date, action, ancienne et nouvelle
valeur, motif) et une notification au propriétaire. Les confirmations et
refus de paiement sont aussi journalisés. Paiements et reçus ne sont jamais
modifiés par une intervention ; le journal n'a aucune route de modification.

**Transactions** : `GET /api/admin/subscription-payments` (filtres : statut,
organisation, forfait, période `from`/`to`, recherche sur les références),
détail avec le journal de la transaction et le reçu
(`GET …/subscription-payments/:id`), incohérences
(`GET …/subscription-payments/anomalies` : en vérification, reçu non activé,
confirmé sans reçu, montant reçu inférieur au dû, en attente depuis plus de
48 h, notifications rejetées sur 7 jours), confirmation, refus, rapprochement.
La cloche de l'administration signale les paiements en attente et à vérifier.

Migration `20261123120000_administration_abonnements` : additive (colonne
`Abonnement.statutAvantSuspension`, table `JournalAdministration`).
