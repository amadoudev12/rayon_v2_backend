-- Historique des paiements des ventes (gestion des créances), devis, et montant
-- payé des achats. Migration sans perte : les données existantes sont reprises.

-- AlterTable
-- Les achats existants ont été réglés à la réception (aucun suivi jusqu'ici) :
-- montant payé = total. La valeur par défaut ne sert qu'au remplissage.
ALTER TABLE "Achat" ADD COLUMN     "montantPaye" DECIMAL(12,2) NOT NULL DEFAULT 0;
UPDATE "Achat" SET "montantPaye" = "total";
ALTER TABLE "Achat" ALTER COLUMN "montantPaye" DROP DEFAULT;

-- CreateTable
CREATE TABLE "PaiementVente" (
    "id" SERIAL NOT NULL,
    "montant" DECIMAL(12,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "venteId" INTEGER NOT NULL,
    "utilisateurId" INTEGER,

    CONSTRAINT "PaiementVente_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Devis" (
    "id" SERIAL NOT NULL,
    "sousTotal" DECIMAL(12,2) NOT NULL,
    "remise" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "nomClient" TEXT,
    "valableJusquAu" TIMESTAMP(3),
    "note" TEXT,
    "organisationId" INTEGER NOT NULL,
    "boutiqueId" INTEGER NOT NULL,
    "clientId" INTEGER,
    "creeParId" INTEGER NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Devis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LigneDevis" (
    "id" SERIAL NOT NULL,
    "designation" TEXT NOT NULL,
    "quantite" INTEGER NOT NULL,
    "prixUnitaire" DECIMAL(12,2) NOT NULL,
    "sousTotal" DECIMAL(12,2) NOT NULL,
    "devisId" INTEGER NOT NULL,
    "produitId" INTEGER,

    CONSTRAINT "LigneDevis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaiementVente_venteId_idx" ON "PaiementVente"("venteId");

-- CreateIndex
CREATE INDEX "PaiementVente_date_idx" ON "PaiementVente"("date");

-- CreateIndex
CREATE INDEX "Devis_organisationId_boutiqueId_creeLe_idx" ON "Devis"("organisationId", "boutiqueId", "creeLe");

-- CreateIndex
CREATE INDEX "LigneDevis_devisId_idx" ON "LigneDevis"("devisId");

-- AddForeignKey
ALTER TABLE "PaiementVente" ADD CONSTRAINT "PaiementVente_venteId_fkey" FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaiementVente" ADD CONSTRAINT "PaiementVente_utilisateurId_fkey" FOREIGN KEY ("utilisateurId") REFERENCES "Utilisateur"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_boutiqueId_fkey" FOREIGN KEY ("boutiqueId") REFERENCES "Boutique"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_creeParId_fkey" FOREIGN KEY ("creeParId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneDevis" ADD CONSTRAINT "LigneDevis_devisId_fkey" FOREIGN KEY ("devisId") REFERENCES "Devis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LigneDevis" ADD CONSTRAINT "LigneDevis_produitId_fkey" FOREIGN KEY ("produitId") REFERENCES "Produit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Reprise des ventes existantes : leur montant payé devient le paiement
-- initial, daté de la vente et attribué au vendeur. Le montant payé ne peut
-- plus dépasser le total (la monnaie rendue n'est pas un encaissement).
UPDATE "Vente" SET "montantPaye" = LEAST("montantPaye", "total");
INSERT INTO "PaiementVente" ("montant", "date", "venteId", "utilisateurId")
SELECT "montantPaye", "creeLe", "id", "vendeurId" FROM "Vente" WHERE "montantPaye" > 0;
