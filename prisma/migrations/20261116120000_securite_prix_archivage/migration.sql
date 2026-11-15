-- Phase 2 (préparation commerciale) : politique de prix, archivage des
-- clients et fournisseurs, sessions révocables, journal de sécurité et
-- limitation de débit partagée. Migration ADDITIVE : aucune ligne supprimée.
-- Les seuls DROP portent sur 2 contraintes de clé étrangère (recréées juste
-- après en RESTRICT : un client ou fournisseur ayant un historique ne peut plus
-- être supprimé) et sur 2 index remplacés par des index composites.

-- DropForeignKey
ALTER TABLE "Achat" DROP CONSTRAINT "Achat_fournisseurId_fkey";

-- DropForeignKey
ALTER TABLE "Vente" DROP CONSTRAINT "Vente_clientId_fkey";

-- DropIndex
DROP INDEX "Client_organisationId_idx";

-- DropIndex
DROP INDEX "Fournisseur_organisationId_idx";

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "archive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "archiveLe" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Fournisseur" ADD COLUMN     "archive" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "archiveLe" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organisation" ADD COLUMN     "remiseMaxGerantPct" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "remiseMaxVendeurPct" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "Utilisateur" ADD COLUMN     "doitChangerMotDePasse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "motDePasseModifieLe" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SessionUtilisateur" (
    "id" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expireLe" TIMESTAMP(3) NOT NULL,
    "revoqueLe" TIMESTAMP(3),
    "motifRevocation" TEXT,
    "derniereUtilisation" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adresseIp" TEXT,
    "agentUtilisateur" TEXT,
    "utilisateurId" INTEGER NOT NULL,

    CONSTRAINT "SessionUtilisateur_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalSecurite" (
    "id" SERIAL NOT NULL,
    "evenement" TEXT NOT NULL,
    "identifiant" TEXT,
    "adresseIp" TEXT,
    "metadonnees" JSONB,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "utilisateurId" INTEGER,

    CONSTRAINT "JournalSecurite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompteurLimite" (
    "cle" TEXT NOT NULL,
    "compteur" INTEGER NOT NULL,
    "fenetreDebut" TIMESTAMP(3) NOT NULL,
    "bloqueJusqua" TIMESTAMP(3),
    "rejets" INTEGER NOT NULL DEFAULT 0,
    "modifieLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompteurLimite_pkey" PRIMARY KEY ("cle")
);

-- CreateIndex
CREATE INDEX "SessionUtilisateur_utilisateurId_revoqueLe_idx" ON "SessionUtilisateur"("utilisateurId", "revoqueLe");

-- CreateIndex
CREATE INDEX "JournalSecurite_utilisateurId_creeLe_idx" ON "JournalSecurite"("utilisateurId", "creeLe");

-- CreateIndex
CREATE INDEX "JournalSecurite_evenement_creeLe_idx" ON "JournalSecurite"("evenement", "creeLe");

-- CreateIndex
CREATE INDEX "CompteurLimite_modifieLe_idx" ON "CompteurLimite"("modifieLe");

-- CreateIndex
CREATE INDEX "Client_organisationId_archive_idx" ON "Client"("organisationId", "archive");

-- CreateIndex
CREATE INDEX "Fournisseur_organisationId_archive_idx" ON "Fournisseur"("organisationId", "archive");

-- AddForeignKey
ALTER TABLE "Vente" ADD CONSTRAINT "Vente_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achat" ADD CONSTRAINT "Achat_fournisseurId_fkey" FOREIGN KEY ("fournisseurId") REFERENCES "Fournisseur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionUtilisateur" ADD CONSTRAINT "SessionUtilisateur_utilisateurId_fkey" FOREIGN KEY ("utilisateurId") REFERENCES "Utilisateur"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalSecurite" ADD CONSTRAINT "JournalSecurite_utilisateurId_fkey" FOREIGN KEY ("utilisateurId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

