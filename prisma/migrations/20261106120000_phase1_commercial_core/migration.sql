-- Phase 1: financial traceability, organization timezone and idempotent operations.
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PARTIALLY_REFUNDED', 'COMPLETED');
CREATE TYPE "ExpenseStatus" AS ENUM ('ACTIVE', 'CANCELLED');

ALTER TABLE "Organisation"
  ADD COLUMN "fuseauHoraire" TEXT NOT NULL DEFAULT 'Africa/Dakar';

ALTER TABLE "Vente"
  ADD COLUMN "motifAnnulation" TEXT,
  ADD COLUMN "annuleParId" INTEGER,
  ADD COLUMN "cleIdempotence" TEXT,
  ADD COLUMN "empreinteIdempotence" TEXT;

ALTER TABLE "Vente"
  ADD CONSTRAINT "Vente_annuleParId_fkey"
  FOREIGN KEY ("annuleParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Vente_organisationId_cleIdempotence_key"
  ON "Vente"("organisationId", "cleIdempotence");

ALTER TABLE "PaiementVente"
  ADD COLUMN "modePaiement" "PaymentMethod",
  ADD COLUMN "cleIdempotence" TEXT;

-- Only non-credit sales have a determinable tender method. Credit deposits and
-- installments remain NULL because their historical method was not captured.
UPDATE "PaiementVente" AS p
SET "modePaiement" = v."modePaiement"
FROM "Vente" AS v
WHERE p."venteId" = v."id" AND v."modePaiement" <> 'CREDIT';

CREATE UNIQUE INDEX "PaiementVente_venteId_cleIdempotence_key"
  ON "PaiementVente"("venteId", "cleIdempotence");

CREATE TABLE "RemboursementVente" (
  "id" SERIAL NOT NULL,
  "montant" DECIMAL(12,2) NOT NULL,
  "statut" "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "motif" TEXT NOT NULL,
  "cleIdempotence" TEXT NOT NULL,
  "venteId" INTEGER NOT NULL,
  "demandeParId" INTEGER NOT NULL,
  "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "modifieLe" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RemboursementVente_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RemboursementVente_venteId_fkey"
    FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "RemboursementVente_demandeParId_fkey"
    FOREIGN KEY ("demandeParId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RemboursementVente_venteId_cleIdempotence_key"
  ON "RemboursementVente"("venteId", "cleIdempotence");
CREATE INDEX "RemboursementVente_venteId_statut_idx"
  ON "RemboursementVente"("venteId", "statut");

CREATE TABLE "VersementRemboursement" (
  "id" SERIAL NOT NULL,
  "montant" DECIMAL(12,2) NOT NULL,
  "modePaiement" "PaymentMethod" NOT NULL,
  "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cleIdempotence" TEXT NOT NULL,
  "remboursementVenteId" INTEGER NOT NULL,
  "utilisateurId" INTEGER NOT NULL,
  CONSTRAINT "VersementRemboursement_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VersementRemboursement_remboursementVenteId_fkey"
    FOREIGN KEY ("remboursementVenteId") REFERENCES "RemboursementVente"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "VersementRemboursement_utilisateurId_fkey"
    FOREIGN KEY ("utilisateurId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VersementRemboursement_remboursementVenteId_cleIdempotence_key"
  ON "VersementRemboursement"("remboursementVenteId", "cleIdempotence");
CREATE INDEX "VersementRemboursement_date_idx" ON "VersementRemboursement"("date");

ALTER TABLE "Depense"
  ADD COLUMN "statut" "ExpenseStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "annuleLe" TIMESTAMP(3),
  ADD COLUMN "annuleParId" INTEGER,
  ADD COLUMN "motifAnnulation" TEXT;

ALTER TABLE "Depense"
  ADD CONSTRAINT "Depense_annuleParId_fkey"
  FOREIGN KEY ("annuleParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;
