-- Espace Super Administrateur : rôle global, désactivation des comptes,
-- suspension des organisations. Migration purement additive (aucune donnée
-- existante n'est modifiée ni supprimée).

-- AlterTable
ALTER TABLE "Utilisateur" ADD COLUMN     "actif" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "derniereActiviteLe" TIMESTAMP(3),
ADD COLUMN     "superAdmin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "actif" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Vente_creeLe_idx" ON "Vente"("creeLe");

-- CreateIndex
CREATE INDEX "JournalAudit_creeLe_idx" ON "JournalAudit"("creeLe");
