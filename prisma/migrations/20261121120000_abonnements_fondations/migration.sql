-- Phase 2 du système d'abonnement : fondations (essai, échéances,
-- changements de forfait, historique, pays de l'organisation).
--
-- Migration ADDITIVE ET NON DESTRUCTIVE :
-- - uniquement des colonnes NULLABLES et une nouvelle table ;
-- - aucune ligne existante n'est modifiée ni supprimée ;
-- - les organisations sans abonnement restent NON SOUMISES (décision métier
--   du 2026-11-21 : aucun forfait ni essai attribué automatiquement aux
--   organisations existantes ; attribution manuelle par l'administration) ;
-- - les abonnements existants gardent leur code de forfait (un code inconnu
--   du catalogue est traité comme PREMIUM par l'application).

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN "pays" TEXT;

-- AlterTable
ALTER TABLE "Abonnement" ADD COLUMN "essaiDebutLe" TIMESTAMP(3),
ADD COLUMN "forfaitProgramme" TEXT,
ADD COLUMN "forfaitProgrammeLe" TIMESTAMP(3),
ADD COLUMN "motifSuspension" TEXT,
ADD COLUMN "suspenduLe" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "HistoriqueAbonnement" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "ancienForfait" TEXT,
    "nouveauForfait" TEXT,
    "ancienStatut" "SubscriptionStatus",
    "nouveauStatut" "SubscriptionStatus",
    "anciennePeriodeFin" TIMESTAMP(3),
    "nouvellePeriodeFin" TIMESTAMP(3),
    "motif" TEXT,
    "metadonnees" JSONB,
    "abonnementId" INTEGER NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "effectueParId" INTEGER,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoriqueAbonnement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HistoriqueAbonnement_abonnementId_creeLe_idx" ON "HistoriqueAbonnement"("abonnementId", "creeLe");

-- CreateIndex
CREATE INDEX "HistoriqueAbonnement_organisationId_creeLe_idx" ON "HistoriqueAbonnement"("organisationId", "creeLe");

-- AddForeignKey
ALTER TABLE "HistoriqueAbonnement" ADD CONSTRAINT "HistoriqueAbonnement_abonnementId_fkey" FOREIGN KEY ("abonnementId") REFERENCES "Abonnement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoriqueAbonnement" ADD CONSTRAINT "HistoriqueAbonnement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoriqueAbonnement" ADD CONSTRAINT "HistoriqueAbonnement_effectueParId_fkey" FOREIGN KEY ("effectueParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Cohérence : une rétrogradation programmée a toujours une date d'effet.
ALTER TABLE "Abonnement" ADD CONSTRAINT "Abonnement_retrogradation_coherente"
  CHECK (("forfaitProgramme" IS NULL) = ("forfaitProgrammeLe" IS NULL));
