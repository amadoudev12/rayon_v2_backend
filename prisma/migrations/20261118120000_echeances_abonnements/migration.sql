-- Phase 5 (préparation commerciale) : échéances des ventes à crédit et
-- fondations des abonnements SaaS. Migration ADDITIVE : aucune donnée
-- existante n'est modifiée ; aucune organisation n'est soumise aux
-- abonnements tant qu'aucune ligne Abonnement n'est créée.

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubscriptionPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REFUNDED');

-- AlterTable
ALTER TABLE "Vente" ADD COLUMN     "dateEcheance" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Abonnement" (
    "id" SERIAL NOT NULL,
    "plan" TEXT NOT NULL,
    "statut" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "essaiFinLe" TIMESTAMP(3),
    "periodeDebut" TIMESTAMP(3) NOT NULL,
    "periodeFin" TIMESTAMP(3) NOT NULL,
    "annuleLe" TIMESTAMP(3),
    "fournisseur" TEXT,
    "referenceExterne" TEXT,
    "organisationId" INTEGER NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifieLe" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Abonnement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaiementAbonnement" (
    "id" SERIAL NOT NULL,
    "montant" DECIMAL(12,2) NOT NULL,
    "devise" TEXT NOT NULL,
    "statut" "SubscriptionPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "fournisseur" TEXT NOT NULL,
    "referenceExterne" TEXT NOT NULL,
    "periodeDebut" TIMESTAMP(3) NOT NULL,
    "periodeFin" TIMESTAMP(3) NOT NULL,
    "payeLe" TIMESTAMP(3),
    "metadonnees" JSONB,
    "abonnementId" INTEGER NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaiementAbonnement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Abonnement_organisationId_key" ON "Abonnement"("organisationId");

-- CreateIndex
CREATE INDEX "PaiementAbonnement_abonnementId_creeLe_idx" ON "PaiementAbonnement"("abonnementId", "creeLe");

-- CreateIndex
CREATE UNIQUE INDEX "PaiementAbonnement_fournisseur_referenceExterne_key" ON "PaiementAbonnement"("fournisseur", "referenceExterne");

-- CreateIndex
CREATE INDEX "Vente_organisationId_boutiqueId_dateEcheance_idx" ON "Vente"("organisationId", "boutiqueId", "dateEcheance");

-- AddForeignKey
ALTER TABLE "Abonnement" ADD CONSTRAINT "Abonnement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaiementAbonnement" ADD CONSTRAINT "PaiementAbonnement_abonnementId_fkey" FOREIGN KEY ("abonnementId") REFERENCES "Abonnement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "PaiementAbonnement" ADD CONSTRAINT "PaiementAbonnement_montant_positif" CHECK ("montant" >= 0);
ALTER TABLE "Abonnement" ADD CONSTRAINT "Abonnement_periode_coherente" CHECK ("periodeFin" > "periodeDebut");
