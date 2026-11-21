-- Phase 3 du système d'abonnement : transactions de paiement, reçus,
-- journal des événements de paiement, notifications intégrées.
--
-- Migration ADDITIVE ET NON DESTRUCTIVE :
-- - nouvelles valeurs d'énumération, colonnes nullables, nouvelles tables ;
-- - deux contraintes NOT NULL sont RELÂCHÉES (referenceExterne, abonnementId)
--   pour créer la transaction avant d'obtenir la référence du prestataire,
--   y compris pour une organisation qui n'a pas encore d'abonnement ;
-- - seule écriture sur l'existant : la nouvelle colonne organisationId des
--   paiements déjà enregistrés est renseignée depuis leur abonnement ;
--   aucune valeur existante n'est modifiée ni supprimée.
-- PostgreSQL 12 ou plus requis (plusieurs ADD VALUE dans une migration).

-- AlterEnum


ALTER TYPE "SubscriptionPaymentStatus" ADD VALUE 'CANCELLED';
ALTER TYPE "SubscriptionPaymentStatus" ADD VALUE 'UNDER_REVIEW';

-- AlterTable
ALTER TABLE "PaiementAbonnement" ADD COLUMN     "creeParId" INTEGER,
ADD COLUMN     "dureeMois" INTEGER,
ADD COLUMN     "forfait" TEXT,
ADD COLUMN     "modifieLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "montantRecu" DECIMAL(12,2),
ADD COLUMN     "motif" TEXT,
ADD COLUMN     "moyenPaiement" TEXT,
ADD COLUMN     "organisationId" INTEGER,
ADD COLUMN     "paiementRecuLe" TIMESTAMP(3),
ADD COLUMN     "referenceInterne" TEXT,
ADD COLUMN     "typeAchat" TEXT,
ALTER COLUMN "referenceExterne" DROP NOT NULL,
ALTER COLUMN "abonnementId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "RecuAbonnement" (
    "id" SERIAL NOT NULL,
    "numero" TEXT NOT NULL,
    "nomOrganisation" TEXT NOT NULL,
    "forfait" TEXT NOT NULL,
    "typeAchat" TEXT NOT NULL,
    "dureeMois" INTEGER,
    "montant" DECIMAL(12,2) NOT NULL,
    "devise" TEXT NOT NULL,
    "moyenPaiement" TEXT,
    "referenceTransaction" TEXT NOT NULL,
    "referenceExterne" TEXT,
    "confirmeLe" TIMESTAMP(3) NOT NULL,
    "periodeDebut" TIMESTAMP(3) NOT NULL,
    "periodeFin" TIMESTAMP(3) NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "paiementId" INTEGER NOT NULL,
    "emisLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecuAbonnement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EvenementPaiement" (
    "id" SERIAL NOT NULL,
    "fournisseur" TEXT NOT NULL,
    "identifiantEvenement" TEXT,
    "type" TEXT NOT NULL,
    "statutTraitement" TEXT NOT NULL,
    "donnees" JSONB,
    "erreur" TEXT,
    "paiementId" INTEGER,
    "effectueParId" INTEGER,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvenementPaiement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "titre" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "lien" TEXT,
    "cle" TEXT NOT NULL,
    "luLe" TIMESTAMP(3),
    "organisationId" INTEGER NOT NULL,
    "utilisateurId" INTEGER NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecuAbonnement_numero_key" ON "RecuAbonnement"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "RecuAbonnement_paiementId_key" ON "RecuAbonnement"("paiementId");

-- CreateIndex
CREATE INDEX "RecuAbonnement_organisationId_emisLe_idx" ON "RecuAbonnement"("organisationId", "emisLe");

-- CreateIndex
CREATE INDEX "EvenementPaiement_paiementId_creeLe_idx" ON "EvenementPaiement"("paiementId", "creeLe");

-- CreateIndex
CREATE INDEX "EvenementPaiement_creeLe_idx" ON "EvenementPaiement"("creeLe");

-- CreateIndex
CREATE UNIQUE INDEX "EvenementPaiement_fournisseur_identifiantEvenement_key" ON "EvenementPaiement"("fournisseur", "identifiantEvenement");

-- CreateIndex
CREATE INDEX "Notification_utilisateurId_luLe_creeLe_idx" ON "Notification"("utilisateurId", "luLe", "creeLe");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_organisationId_cle_key" ON "Notification"("organisationId", "cle");

-- CreateIndex
CREATE UNIQUE INDEX "PaiementAbonnement_referenceInterne_key" ON "PaiementAbonnement"("referenceInterne");

-- CreateIndex
CREATE INDEX "PaiementAbonnement_organisationId_creeLe_idx" ON "PaiementAbonnement"("organisationId", "creeLe");

-- CreateIndex
CREATE INDEX "PaiementAbonnement_statut_creeLe_idx" ON "PaiementAbonnement"("statut", "creeLe");

-- AddForeignKey
ALTER TABLE "PaiementAbonnement" ADD CONSTRAINT "PaiementAbonnement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaiementAbonnement" ADD CONSTRAINT "PaiementAbonnement_creeParId_fkey" FOREIGN KEY ("creeParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecuAbonnement" ADD CONSTRAINT "RecuAbonnement_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecuAbonnement" ADD CONSTRAINT "RecuAbonnement_paiementId_fkey" FOREIGN KEY ("paiementId") REFERENCES "PaiementAbonnement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvenementPaiement" ADD CONSTRAINT "EvenementPaiement_paiementId_fkey" FOREIGN KEY ("paiementId") REFERENCES "PaiementAbonnement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EvenementPaiement" ADD CONSTRAINT "EvenementPaiement_effectueParId_fkey" FOREIGN KEY ("effectueParId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_utilisateurId_fkey" FOREIGN KEY ("utilisateurId") REFERENCES "Utilisateur"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Reprise : rattache les paiements existants à leur organisation.
UPDATE "PaiementAbonnement" p
SET "organisationId" = a."organisationId"
FROM "Abonnement" a
WHERE a."id" = p."abonnementId" AND p."organisationId" IS NULL;

-- Montants jamais négatifs.
ALTER TABLE "PaiementAbonnement" ADD CONSTRAINT "PaiementAbonnement_montant_recu_positif" CHECK ("montantRecu" IS NULL OR "montantRecu" >= 0);
ALTER TABLE "RecuAbonnement" ADD CONSTRAINT "RecuAbonnement_montant_positif" CHECK ("montant" >= 0);
