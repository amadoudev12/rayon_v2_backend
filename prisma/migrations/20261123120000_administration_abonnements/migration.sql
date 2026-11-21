-- Phase 5 du système d'abonnement : administration centrale.
--
-- Migration ADDITIVE ET NON DESTRUCTIVE : une colonne nullable et une table
-- de journal (ajout seul). Aucune donnée existante n'est lue ni modifiée.

-- AlterTable
ALTER TABLE "Abonnement" ADD COLUMN     "statutAvantSuspension" "SubscriptionStatus";

-- CreateTable
CREATE TABLE "JournalAdministration" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "entite" TEXT NOT NULL,
    "entiteId" INTEGER,
    "ancienneValeur" JSONB,
    "nouvelleValeur" JSONB,
    "motif" TEXT,
    "adminId" INTEGER NOT NULL,
    "organisationId" INTEGER,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalAdministration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JournalAdministration_creeLe_idx" ON "JournalAdministration"("creeLe");

-- CreateIndex
CREATE INDEX "JournalAdministration_organisationId_creeLe_idx" ON "JournalAdministration"("organisationId", "creeLe");

-- CreateIndex
CREATE INDEX "JournalAdministration_adminId_creeLe_idx" ON "JournalAdministration"("adminId", "creeLe");

-- AddForeignKey
ALTER TABLE "JournalAdministration" ADD CONSTRAINT "JournalAdministration_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalAdministration" ADD CONSTRAINT "JournalAdministration_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

