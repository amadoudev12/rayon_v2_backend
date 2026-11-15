# Rayon — test de charge (15/11/2026)

Reproductible : `LOAD_DATABASE_URL=postgresql://…/rayon_load_test npx tsx scripts/load/run.ts`
(base jetable `*_test` uniquement ; options `LOAD_STAGES`, `LOAD_SECONDS`,
`LOAD_INSTANCES`, `LOAD_SKIP_SEED`, `DATABASE_POOL_MAX`).

## Conditions

- Données : 50 organisations, 100 boutiques, 50 000 produits, 100 000 lignes
  de stock, 200 000 ventes sur 90 jours (400 000 lignes, 200 000 paiements).
- Mélange : tableau de bord 20 %, liste des ventes 15 %, statistiques du mois
  15 %, recherche de produits 15 %, stock bas 10 %, **création de vente 25 %**.
- Utilisateurs virtuels **sans temps de réflexion** : chacun enchaîne les
  requêtes sans pause. Un utilisateur virtuel représente donc bien plus qu'un
  commerçant réel.
- Machine de développement Windows (8 cœurs logiques), une instance de l'API
  (Node, `NODE_ENV=production`), PostgreSQL 17 dans Docker Desktop. **Ce n'est
  pas l'infrastructure cible** : les chiffres absolus sont indicatifs.

## Résultats (une instance, pool de 10 connexions)

| Utilisateurs simultanés | Débit | p50 | p95 | p99 | Erreurs |
| --- | --- | --- | --- | --- | --- |
| 10 | 94 req/s | 82 ms | 192 ms | 255 ms | 409 « stock insuffisant » attendus |
| 50 | 96 req/s | 489 ms | 858 ms | 908 ms | idem + 429 attendus |
| 100 | 93 req/s | 999 ms | 1 760 ms | 1 981 ms | idem |

Détail à 10 utilisateurs : création de vente p95 233 ms, tableau de bord p95
132 ms, liste des ventes p95 107 ms, statistiques p95 118 ms.

- Aucune erreur serveur (5xx), aucune incohérence : les 409 viennent des
  articles volontairement en stock faible, les 429 de la limite de 60 ventes
  par minute et par vendeur (comportement voulu).
- Pool de 30 connexions au lieu de 10 : aucun gain. PostgreSQL n'est pas le
  goulot (≈ 11 % de processeur, 15 000 requêtes SQL triviales/s possibles,
  0,3 ms par aller-retour).
- **Goulot mesuré : le processeur de l'instance Node** (94 % d'un cœur à
  saturation). Le débit plafonne vers 95 req/s et la latence croît ensuite
  avec la file d'attente.
- Essai à 2 et 4 instances sur la même machine : non concluant (≈ 110 req/s,
  mesures de processeur incohérentes sous Windows). **La montée en charge
  horizontale reste à mesurer sur l'infrastructure cible.**

## Ce que cela signifie

Hypothèse prudente : un commerçant actif génère une requête toutes les 10 s
en moyenne (ventes, consultations). Pour garder p95 < 300 ms, on vise environ
50 % de la capacité mesurée, soit ~45 req/s par instance, donc **≈ 400 à 450
commerçants simultanément actifs par instance**. Avec 10 à 20 % des comptes
actifs en même temps :

| Comptes | Simultanément actifs | Estimation |
| --- | --- | --- |
| 100 | 10–20 | 1 instance, large marge |
| 500 | 50–100 | 1 instance |
| 1 000 | 100–200 | 1 instance ; 2 recommandées pour la disponibilité |
| 5 000 | 500–1 000 | 3 à 4 instances (à valider), base dimensionnée en conséquence |

Ces chiffres sont des extrapolations à partir d'une mesure sur une machine
de développement : ils doivent être confirmés par ce même script sur le
serveur de production (ou une préproduction identique) avant de vendre au-delà
de quelques centaines de comptes.

## Pistes si la charge l'exige

1. Plusieurs instances derrière un répartiteur (l'application est sans état :
   sessions, limitation de débit et idempotence sont en base).
2. Réduire le coût par requête : une seule lecture combinée compte + session
   (aujourd'hui deux), cache court (quelques secondes) du tableau de bord par
   boutique.
3. Ajuster `DATABASE_POOL_MAX` au nombre d'instances et à la limite de
   connexions de PostgreSQL ou du pooler.
