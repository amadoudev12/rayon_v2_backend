ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'INVENTORY_ADJUSTMENT';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'LOSS';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'LOSS_CANCELLATION';

CREATE TYPE "InventoryStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'VALIDATED', 'CANCELLED');
CREATE TYPE "InventorySelectionType" AS ENUM ('ALL', 'CATEGORY', 'MANUAL');
CREATE TYPE "LossStatus" AS ENUM ('ACTIVE', 'CANCELLED');

CREATE TABLE "Inventaire" (
  "id" SERIAL NOT NULL,
  "reference" TEXT NOT NULL,
  "libelle" TEXT NOT NULL,
  "statut" "InventoryStatus" NOT NULL DEFAULT 'IN_PROGRESS',
  "selectionType" "InventorySelectionType" NOT NULL,
  "categorieId" INTEGER,
  "produitIds" INTEGER[] NOT NULL,
  "demarreLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valideLe" TIMESTAMP(3),
  "annuleLe" TIMESTAMP(3),
  "motifAnnulation" TEXT,
  "organisationId" INTEGER NOT NULL,
  "boutiqueId" INTEGER NOT NULL,
  "creeParId" INTEGER NOT NULL,
  "valideParId" INTEGER,
  "annuleParId" INTEGER,
  "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "modifieLe" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Inventaire_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Inventaire_reference_key" ON "Inventaire"("reference");
CREATE INDEX "Inventaire_organisationId_boutiqueId_creeLe_idx" ON "Inventaire"("organisationId", "boutiqueId", "creeLe");
CREATE INDEX "Inventaire_organisationId_statut_idx" ON "Inventaire"("organisationId", "statut");
ALTER TABLE "Inventaire" ADD CONSTRAINT "Inventaire_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Inventaire" ADD CONSTRAINT "Inventaire_boutiqueId_fkey" FOREIGN KEY ("boutiqueId") REFERENCES "Boutique"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Inventaire" ADD CONSTRAINT "Inventaire_categorieId_fkey" FOREIGN KEY ("categorieId") REFERENCES "Categorie"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Inventaire" ADD CONSTRAINT "Inventaire_creeParId_fkey" FOREIGN KEY ("creeParId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Inventaire" ADD CONSTRAINT "Inventaire_valideParId_fkey" FOREIGN KEY ("valideParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Inventaire" ADD CONSTRAINT "Inventaire_annuleParId_fkey" FOREIGN KEY ("annuleParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LigneInventaire" (
  "id" SERIAL NOT NULL,
  "produitNom" TEXT NOT NULL,
  "produitReference" TEXT,
  "categorieNom" TEXT,
  "quantiteTheorique" INTEGER NOT NULL,
  "quantiteComptee" INTEGER,
  "coutUnitaire" DECIMAL(12,2) NOT NULL,
  "compteLe" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "inventaireId" INTEGER NOT NULL,
  "produitId" INTEGER NOT NULL,
  "compteParId" INTEGER,
  CONSTRAINT "LigneInventaire_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LigneInventaire_inventaireId_produitId_key" ON "LigneInventaire"("inventaireId", "produitId");
ALTER TABLE "LigneInventaire" ADD CONSTRAINT "LigneInventaire_inventaireId_fkey" FOREIGN KEY ("inventaireId") REFERENCES "Inventaire"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LigneInventaire" ADD CONSTRAINT "LigneInventaire_produitId_fkey" FOREIGN KEY ("produitId") REFERENCES "Produit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LigneInventaire" ADD CONSTRAINT "LigneInventaire_compteParId_fkey" FOREIGN KEY ("compteParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "PerteStock" (
  "id" SERIAL NOT NULL,
  "reference" TEXT NOT NULL,
  "quantite" INTEGER NOT NULL,
  "motif" TEXT NOT NULL,
  "description" TEXT,
  "coutUnitaire" DECIMAL(12,2) NOT NULL,
  "statut" "LossStatus" NOT NULL DEFAULT 'ACTIVE',
  "cleIdempotence" TEXT NOT NULL,
  "empreinteIdempotence" TEXT NOT NULL,
  "annuleLe" TIMESTAMP(3),
  "motifAnnulation" TEXT,
  "organisationId" INTEGER NOT NULL,
  "boutiqueId" INTEGER NOT NULL,
  "produitId" INTEGER NOT NULL,
  "declareParId" INTEGER NOT NULL,
  "annuleParId" INTEGER,
  "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PerteStock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PerteStock_reference_key" ON "PerteStock"("reference");
CREATE UNIQUE INDEX "PerteStock_organisationId_cleIdempotence_key" ON "PerteStock"("organisationId", "cleIdempotence");
CREATE INDEX "PerteStock_organisationId_boutiqueId_creeLe_idx" ON "PerteStock"("organisationId", "boutiqueId", "creeLe");
CREATE INDEX "PerteStock_produitId_statut_creeLe_idx" ON "PerteStock"("produitId", "statut", "creeLe");
ALTER TABLE "PerteStock" ADD CONSTRAINT "PerteStock_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PerteStock" ADD CONSTRAINT "PerteStock_boutiqueId_fkey" FOREIGN KEY ("boutiqueId") REFERENCES "Boutique"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PerteStock" ADD CONSTRAINT "PerteStock_produitId_fkey" FOREIGN KEY ("produitId") REFERENCES "Produit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PerteStock" ADD CONSTRAINT "PerteStock_declareParId_fkey" FOREIGN KEY ("declareParId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PerteStock" ADD CONSTRAINT "PerteStock_annuleParId_fkey" FOREIGN KEY ("annuleParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SeuilStockBoutique" (
  "id" SERIAL NOT NULL,
  "seuilAlerte" INTEGER NOT NULL,
  "organisationId" INTEGER NOT NULL,
  "boutiqueId" INTEGER NOT NULL,
  "produitId" INTEGER NOT NULL,
  "modifieLe" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SeuilStockBoutique_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SeuilStockBoutique_boutiqueId_produitId_key" ON "SeuilStockBoutique"("boutiqueId", "produitId");
CREATE INDEX "SeuilStockBoutique_produitId_idx" ON "SeuilStockBoutique"("produitId");
ALTER TABLE "SeuilStockBoutique" ADD CONSTRAINT "SeuilStockBoutique_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeuilStockBoutique" ADD CONSTRAINT "SeuilStockBoutique_boutiqueId_fkey" FOREIGN KEY ("boutiqueId") REFERENCES "Boutique"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SeuilStockBoutique" ADD CONSTRAINT "SeuilStockBoutique_produitId_fkey" FOREIGN KEY ("produitId") REFERENCES "Produit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MouvementStock" ADD COLUMN "quantiteAvant" INTEGER;
ALTER TABLE "MouvementStock" ADD COLUMN "quantiteApres" INTEGER;
ALTER TABLE "MouvementStock" ADD COLUMN "coutUnitaire" DECIMAL(12,2);
ALTER TABLE "MouvementStock" ADD COLUMN "sourceReference" TEXT;
ALTER TABLE "MouvementStock" ADD COLUMN "ligneInventaireId" INTEGER;
ALTER TABLE "MouvementStock" ADD COLUMN "perteStockId" INTEGER;
CREATE INDEX "MouvementStock_perteStockId_idx" ON "MouvementStock"("perteStockId");
CREATE INDEX "MouvementStock_ligneInventaireId_idx" ON "MouvementStock"("ligneInventaireId");
ALTER TABLE "MouvementStock" ADD CONSTRAINT "MouvementStock_ligneInventaireId_fkey" FOREIGN KEY ("ligneInventaireId") REFERENCES "LigneInventaire"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "MouvementStock" ADD CONSTRAINT "MouvementStock_perteStockId_fkey" FOREIGN KEY ("perteStockId") REFERENCES "PerteStock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
