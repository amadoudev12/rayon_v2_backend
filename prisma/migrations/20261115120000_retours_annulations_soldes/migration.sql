-- Phase 1 (préparation commerciale) : retours produits, annulations
-- typées, paiements annulés pour erreur de saisie et solde client tenu sur
-- la vente. Migration ADDITIVE : aucune ligne n'est supprimée.

-- CreateEnum
CREATE TYPE "CancellationKind" AS ENUM ('REFUND', 'ENTRY_ERROR', 'LEGACY');

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'SALE_RETURN';

-- AlterTable
ALTER TABLE "LigneVente" ADD COLUMN     "quantiteRetournee" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "MouvementStock" ADD COLUMN     "retourVenteId" INTEGER;

-- AlterTable
ALTER TABLE "PaiementVente" ADD COLUMN     "annuleLe" TIMESTAMP(3),
ADD COLUMN     "annuleParId" INTEGER,
ADD COLUMN     "motifAnnulation" TEXT;

-- AlterTable
ALTER TABLE "RemboursementVente" ADD COLUMN     "retourVenteId" INTEGER;

-- AlterTable
ALTER TABLE "Vente" ADD COLUMN     "cleAnnulation" TEXT,
ADD COLUMN     "montantARembourser" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "montantRetourne" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "resteAPayer" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "typeAnnulation" "CancellationKind";

-- CreateTable
CREATE TABLE "RetourVente" (
    "id" SERIAL NOT NULL,
    "montant" DECIMAL(12,2) NOT NULL,
    "coutTotal" DECIMAL(12,2) NOT NULL,
    "motif" TEXT NOT NULL,
    "cleIdempotence" TEXT NOT NULL,
    "empreinteIdempotence" TEXT NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "boutiqueId" INTEGER NOT NULL,
    "venteId" INTEGER NOT NULL,
    "creeParId" INTEGER NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetourVente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LigneRetourVente" (
    "id" SERIAL NOT NULL,
    "quantite" INTEGER NOT NULL,
    "montant" DECIMAL(12,2) NOT NULL,
    "coutUnitaire" DECIMAL(12,2) NOT NULL,
    "remiseEnStock" BOOLEAN NOT NULL,
    "retourVenteId" INTEGER NOT NULL,
    "ligneVenteId" INTEGER NOT NULL,
    "produitId" INTEGER NOT NULL,

    CONSTRAINT "LigneRetourVente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RetourVente_organisationId_boutiqueId_creeLe_idx" ON "RetourVente"("organisationId", "boutiqueId", "creeLe");

-- CreateIndex
CREATE UNIQUE INDEX "RetourVente_venteId_cleIdempotence_key" ON "RetourVente"("venteId", "cleIdempotence");

-- CreateIndex
CREATE INDEX "LigneRetourVente_retourVenteId_idx" ON "LigneRetourVente"("retourVenteId");

-- CreateIndex
CREATE INDEX "LigneRetourVente_ligneVenteId_idx" ON "LigneRetourVente"("ligneVenteId");

-- CreateIndex
CREATE INDEX "MouvementStock_retourVenteId_idx" ON "MouvementStock"("retourVenteId");

-- CreateIndex
CREATE INDEX "RemboursementVente_retourVenteId_idx" ON "RemboursementVente"("retourVenteId");

-- CreateIndex
CREATE INDEX "Vente_organisationId_boutiqueId_resteAPayer_idx" ON "Vente"("organisationId", "boutiqueId", "resteAPayer");

-- AddForeignKey
ALTER TABLE "MouvementStock" ADD CONSTRAINT "MouvementStock_retourVenteId_fkey" FOREIGN KEY ("retourVenteId") REFERENCES "RetourVente"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaiementVente" ADD CONSTRAINT "PaiementVente_annuleParId_fkey" FOREIGN KEY ("annuleParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemboursementVente" ADD CONSTRAINT "RemboursementVente_retourVenteId_fkey" FOREIGN KEY ("retourVenteId") REFERENCES "RetourVente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetourVente" ADD CONSTRAINT "RetourVente_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetourVente" ADD CONSTRAINT "RetourVente_boutiqueId_fkey" FOREIGN KEY ("boutiqueId") REFERENCES "Boutique"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetourVente" ADD CONSTRAINT "RetourVente_venteId_fkey" FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetourVente" ADD CONSTRAINT "RetourVente_creeParId_fkey" FOREIGN KEY ("creeParId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneRetourVente" ADD CONSTRAINT "LigneRetourVente_retourVenteId_fkey" FOREIGN KEY ("retourVenteId") REFERENCES "RetourVente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneRetourVente" ADD CONSTRAINT "LigneRetourVente_ligneVenteId_fkey" FOREIGN KEY ("ligneVenteId") REFERENCES "LigneVente"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneRetourVente" ADD CONSTRAINT "LigneRetourVente_produitId_fkey" FOREIGN KEY ("produitId") REFERENCES "Produit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Reprise des données existantes (aucune suppression)
-- ---------------------------------------------------------------------------

-- 1. Remboursements partiels enregistrés sur des ventes NON annulées avec
--    l'ancienne fonction (sans retour d'articles) : économiquement, c'est une
--    réduction de prix. On crée un avoir sans ligne d'article du même montant,
--    rattaché aux demandes existantes, pour que le CA et le solde soient justes.
INSERT INTO "RetourVente" ("montant", "coutTotal", "motif", "cleIdempotence", "empreinteIdempotence",
  "organisationId", "boutiqueId", "venteId", "creeParId", "creeLe")
SELECT SUM(r."montant"), 0, 'Reprise : remboursement partiel antérieur sans retour d''article',
  'reprise-remboursements', 'reprise', v."organisationId", v."boutiqueId", v."id",
  (ARRAY_AGG(r."demandeParId" ORDER BY r."creeLe"))[1], MIN(r."creeLe")
FROM "Vente" v
JOIN "RemboursementVente" r ON r."venteId" = v."id"
WHERE v."statut" = 'COMPLETED'
GROUP BY v."id", v."organisationId", v."boutiqueId";

UPDATE "RemboursementVente" r
SET "retourVenteId" = rv."id"
FROM "RetourVente" rv
WHERE rv."venteId" = r."venteId" AND rv."cleIdempotence" = 'reprise-remboursements';

UPDATE "Vente" v
SET "montantRetourne" = rv."montant"
FROM "RetourVente" rv
WHERE rv."venteId" = v."id" AND rv."cleIdempotence" = 'reprise-remboursements';

-- 2. Annulations antérieures à la traçabilité des remboursements : vente
--    annulée, paiements reçus, aucune demande de remboursement. Ce qu'il est
--    advenu de l'argent n'est pas connu : les paiements restent dans
--    l'historique mais sont marqués annulés, ce qui reproduit exactement les
--    chiffres affichés jusqu'ici (ces paiements n'étaient pas comptés).
UPDATE "Vente" v
SET "typeAnnulation" = 'LEGACY'
WHERE v."statut" = 'CANCELLED'
  AND NOT EXISTS (SELECT 1 FROM "RemboursementVente" r WHERE r."venteId" = v."id");

UPDATE "PaiementVente" p
SET "annuleLe" = COALESCE(v."annuleLe", CURRENT_TIMESTAMP),
    "motifAnnulation" = 'Reprise : vente annulée avant le suivi des remboursements'
FROM "Vente" v
WHERE p."venteId" = v."id" AND v."typeAnnulation" = 'LEGACY' AND p."annuleLe" IS NULL;

UPDATE "Vente" SET "montantPaye" = 0 WHERE "typeAnnulation" = 'LEGACY';

-- 3. Annulations déjà accompagnées d'une demande de remboursement.
UPDATE "Vente" SET "typeAnnulation" = 'REFUND'
WHERE "statut" = 'CANCELLED' AND "typeAnnulation" IS NULL;

-- 4. Remboursements dus et solde du client.
UPDATE "Vente" v
SET "montantARembourser" = COALESCE(
  (SELECT SUM(r."montant") FROM "RemboursementVente" r WHERE r."venteId" = v."id"), 0);

UPDATE "Vente"
SET "resteAPayer" = CASE
  WHEN "statut" = 'COMPLETED'
    THEN GREATEST(0, "total" - "montantRetourne" - "montantPaye" + "montantARembourser")
  ELSE 0
END;
