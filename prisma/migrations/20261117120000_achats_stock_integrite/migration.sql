-- Phase 3 (préparation commerciale) : paiements fournisseurs, annulation
-- d'achat, idempotence des achats, historique des mouvements protégé et
-- contraintes d'intégrité. Migration ADDITIVE : aucune ligne supprimée.
-- Le seul DROP porte sur la clé étrangère produit des mouvements de stock,
-- recréée aussitôt en RESTRICT (l'historique ne part plus avec un produit).

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'PURCHASE_CANCELLATION';

-- DropForeignKey
ALTER TABLE "MouvementStock" DROP CONSTRAINT "MouvementStock_produitId_fkey";

-- AlterTable
ALTER TABLE "Achat" ADD COLUMN     "annuleLe" TIMESTAMP(3),
ADD COLUMN     "annuleParId" INTEGER,
ADD COLUMN     "cleAnnulation" TEXT,
ADD COLUMN     "cleIdempotence" TEXT,
ADD COLUMN     "empreinteIdempotence" TEXT,
ADD COLUMN     "motifAnnulation" TEXT,
ADD COLUMN     "resteAPayer" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PaiementFournisseur" (
    "id" SERIAL NOT NULL,
    "montant" DECIMAL(12,2) NOT NULL,
    "modePaiement" "PaymentMethod",
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleIdempotence" TEXT,
    "achatId" INTEGER NOT NULL,
    "utilisateurId" INTEGER,

    CONSTRAINT "PaiementFournisseur_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaiementFournisseur_date_idx" ON "PaiementFournisseur"("date");

-- CreateIndex
CREATE UNIQUE INDEX "PaiementFournisseur_achatId_cleIdempotence_key" ON "PaiementFournisseur"("achatId", "cleIdempotence");

-- CreateIndex
CREATE INDEX "Achat_organisationId_boutiqueId_resteAPayer_idx" ON "Achat"("organisationId", "boutiqueId", "resteAPayer");

-- CreateIndex
CREATE UNIQUE INDEX "Achat_organisationId_cleIdempotence_key" ON "Achat"("organisationId", "cleIdempotence");

-- AddForeignKey
ALTER TABLE "MouvementStock" ADD CONSTRAINT "MouvementStock_produitId_fkey" FOREIGN KEY ("produitId") REFERENCES "Produit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achat" ADD CONSTRAINT "Achat_annuleParId_fkey" FOREIGN KEY ("annuleParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaiementFournisseur" ADD CONSTRAINT "PaiementFournisseur_achatId_fkey" FOREIGN KEY ("achatId") REFERENCES "Achat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaiementFournisseur" ADD CONSTRAINT "PaiementFournisseur_utilisateurId_fkey" FOREIGN KEY ("utilisateurId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reprise : solde fournisseur et historique des paiements existants
-- ---------------------------------------------------------------------------
UPDATE "Achat"
SET "resteAPayer" = CASE WHEN "statut" = 'RECEIVED' THEN GREATEST(0, "total" - "montantPaye") ELSE 0 END;

-- Le montant déjà versé devient le paiement initial (mode inconnu : NULL).
INSERT INTO "PaiementFournisseur" ("montant", "modePaiement", "date", "achatId", "utilisateurId")
SELECT a."montantPaye", NULL, a."creeLe", a."id", a."creeParId"
FROM "Achat" a
WHERE a."montantPaye" > 0;

-- ---------------------------------------------------------------------------
-- Contraintes d'intégrité
--
-- Chaque contrainte est créée NOT VALID : elle s'applique immédiatement à
-- toute nouvelle écriture. Elle est ensuite validée sur les lignes existantes ;
-- si une ligne ancienne la viole, la migration NE MODIFIE RIEN et n'échoue
-- pas : un avertissement est émis et la contrainte reste active pour l'avenir.
-- Le script scripts/audit-integrity.sql liste les lignes concernées.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  rule RECORD;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('Stock', 'Stock_quantite_positive', '"quantite" >= 0'),
    ('Produit', 'Produit_prix_positifs', '"prixAchat" >= 0 AND "prixVente" >= 0 AND "seuilAlerte" >= 0'),
    ('Organisation', 'Organisation_plafonds_remise', '"remiseMaxVendeurPct" BETWEEN 0 AND 100 AND "remiseMaxGerantPct" BETWEEN 0 AND 100'),
    ('Vente', 'Vente_montants_coherents', '"sousTotal" >= 0 AND "remise" >= 0 AND "remise" <= "sousTotal" AND "total" >= 0 AND "montantPaye" >= 0 AND "montantRetourne" >= 0 AND "montantRetourne" <= "total" AND "montantARembourser" >= 0 AND "montantARembourser" <= "montantPaye" AND "resteAPayer" >= 0'),
    ('LigneVente', 'LigneVente_quantites_coherentes', '"quantite" > 0 AND "quantiteRetournee" >= 0 AND "quantiteRetournee" <= "quantite" AND "prixUnitaire" >= 0 AND "coutUnitaire" >= 0'),
    ('PaiementVente', 'PaiementVente_montant_positif', '"montant" > 0'),
    ('RemboursementVente', 'RemboursementVente_montant_positif', '"montant" > 0'),
    ('VersementRemboursement', 'VersementRemboursement_montant_positif', '"montant" > 0'),
    ('RetourVente', 'RetourVente_montant_positif', '"montant" >= 0 AND "coutTotal" >= 0'),
    ('LigneRetourVente', 'LigneRetourVente_quantite_positive', '"quantite" > 0 AND "montant" >= 0'),
    ('Achat', 'Achat_montants_coherents', '"total" >= 0 AND "montantPaye" >= 0 AND "montantPaye" <= "total" AND "resteAPayer" >= 0'),
    ('LigneAchat', 'LigneAchat_quantite_positive', '"quantite" > 0 AND "coutUnitaire" >= 0'),
    ('PaiementFournisseur', 'PaiementFournisseur_montant_positif', '"montant" > 0'),
    ('PerteStock', 'PerteStock_quantite_positive', '"quantite" > 0 AND "coutUnitaire" >= 0'),
    ('Depense', 'Depense_montant_positif', '"montant" > 0')
  ) AS t(table_name, constraint_name, expression)
  LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s) NOT VALID', rule.table_name, rule.constraint_name, rule.expression);
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', rule.table_name, rule.constraint_name);
    EXCEPTION WHEN check_violation THEN
      RAISE WARNING 'Contrainte % : des lignes existantes la violent ; elle reste active pour les nouvelles écritures. Voir scripts/audit-integrity.sql.', rule.constraint_name;
    END;
  END LOOP;
END $$;
