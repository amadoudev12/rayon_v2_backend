-- Resynchronisation des soldes dénormalisés (idempotente, sans suppression).
--
-- À n'utiliser qu'après un RETOUR ARRIÈRE vers l'ancienne version du code,
-- au moment de revenir à la version actuelle : l'ancien code ne tient pas à
-- jour `montantARembourser`, `resteAPayer` ni l'historique des paiements
-- fournisseur. Exécuter dans une transaction, après sauvegarde :
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -1 -f scripts/resync-balances.sql

-- Ventes : remboursements dus, payé (paiements actifs) et solde client.
UPDATE "Vente" v
SET "montantARembourser" = COALESCE((SELECT SUM(r."montant") FROM "RemboursementVente" r WHERE r."venteId" = v."id"), 0),
    "montantPaye" = COALESCE((SELECT SUM(p."montant") FROM "PaiementVente" p WHERE p."venteId" = v."id" AND p."annuleLe" IS NULL), 0);

UPDATE "Vente"
SET "resteAPayer" = CASE
  WHEN "statut" = 'COMPLETED' THEN GREATEST(0, "total" - "montantRetourne" - "montantPaye" + "montantARembourser")
  ELSE 0
END;

-- Annulations faites par l'ancien code : typées comme remboursements.
UPDATE "Vente" SET "typeAnnulation" = 'REFUND' WHERE "statut" = 'CANCELLED' AND "typeAnnulation" IS NULL;

-- Achats : paiements versés par l'ancien code sans ligne d'historique.
INSERT INTO "PaiementFournisseur" ("montant", "modePaiement", "date", "achatId", "utilisateurId")
SELECT a."montantPaye" - COALESCE(SUM(pf."montant"), 0), NULL, a."creeLe", a."id", a."creeParId"
FROM "Achat" a LEFT JOIN "PaiementFournisseur" pf ON pf."achatId" = a."id"
GROUP BY a."id"
HAVING a."montantPaye" - COALESCE(SUM(pf."montant"), 0) > 0;

UPDATE "Achat"
SET "resteAPayer" = CASE WHEN "statut" = 'RECEIVED' THEN GREATEST(0, "total" - "montantPaye") ELSE 0 END;
