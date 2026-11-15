-- Audit d'intégrité (LECTURE SEULE). Il utilise les colonnes des migrations
-- 20261115120000 et 20261116120000 : à exécuter APRÈS leur application (sur
-- une copie de la production pour préparer le déploiement, ou après coup) :
--   psql "$DATABASE_URL" -f scripts/audit-integrity.sql
-- Chaque ligne indique une règle et le nombre de lignes qui la violent, avec
-- jusqu'à 20 identifiants. Aucune donnée n'est modifiée.

SELECT 'Stock négatif' AS regle, COUNT(*) AS lignes, (ARRAY_AGG("id" ORDER BY "id"))[1:20] AS exemples
FROM "Stock" WHERE "quantite" < 0
UNION ALL
SELECT 'Produit : prix ou seuil négatif', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "Produit" WHERE "prixAchat" < 0 OR "prixVente" < 0 OR "seuilAlerte" < 0
UNION ALL
SELECT 'Vente : montants incohérents', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "Vente"
WHERE "sousTotal" < 0 OR "remise" < 0 OR "remise" > "sousTotal" OR "total" < 0 OR "montantPaye" < 0
   OR "montantRetourne" < 0 OR "montantRetourne" > "total" OR "montantARembourser" < 0
   OR "montantARembourser" > "montantPaye" OR "resteAPayer" < 0
UNION ALL
SELECT 'Vente : payé différent de la somme des paiements actifs', COUNT(*), (ARRAY_AGG(v."id" ORDER BY v."id"))[1:20]
FROM "Vente" v
WHERE v."montantPaye" <> COALESCE((SELECT SUM(p."montant") FROM "PaiementVente" p WHERE p."venteId" = v."id" AND p."annuleLe" IS NULL), 0)
UNION ALL
SELECT 'Ligne de vente : quantités incohérentes', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "LigneVente" WHERE "quantite" <= 0 OR "quantiteRetournee" < 0 OR "quantiteRetournee" > "quantite" OR "prixUnitaire" < 0 OR "coutUnitaire" < 0
UNION ALL
SELECT 'Paiement de vente nul ou négatif', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "PaiementVente" WHERE "montant" <= 0
UNION ALL
SELECT 'Remboursement nul ou négatif', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "RemboursementVente" WHERE "montant" <= 0
UNION ALL
SELECT 'Versement de remboursement nul ou négatif', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "VersementRemboursement" WHERE "montant" <= 0
UNION ALL
SELECT 'Achat : montants incohérents', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "Achat" WHERE "total" < 0 OR "montantPaye" < 0 OR "montantPaye" > "total" OR "resteAPayer" < 0
UNION ALL
SELECT 'Ligne d''achat : quantité ou coût invalide', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "LigneAchat" WHERE "quantite" <= 0 OR "coutUnitaire" < 0
UNION ALL
SELECT 'Perte : quantité ou coût invalide', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "PerteStock" WHERE "quantite" <= 0 OR "coutUnitaire" < 0
UNION ALL
SELECT 'Dépense nulle ou négative', COUNT(*), (ARRAY_AGG("id" ORDER BY "id"))[1:20]
FROM "Depense" WHERE "montant" <= 0
UNION ALL
SELECT 'Stock différent de la somme des mouvements (lignes ayant un historique complet)', COUNT(*), (ARRAY_AGG(s."id" ORDER BY s."id"))[1:20]
FROM "Stock" s
WHERE EXISTS (SELECT 1 FROM "MouvementStock" m WHERE m."boutiqueId" = s."boutiqueId" AND m."produitId" = s."produitId")
  AND s."quantite" <> (SELECT SUM(m."variationQuantite") FROM "MouvementStock" m WHERE m."boutiqueId" = s."boutiqueId" AND m."produitId" = s."produitId");
