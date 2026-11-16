-- Ventes en attente (paniers mis de côté au comptoir). Migration ADDITIVE :
-- nouvelle table uniquement, aucune donnée existante modifiée.

-- CreateTable
CREATE TABLE "VenteEnAttente" (
    "id" SERIAL NOT NULL,
    "libelle" TEXT NOT NULL,
    "panier" JSONB NOT NULL,
    "nombreArticles" INTEGER NOT NULL,
    "totalEstime" DECIMAL(12,2) NOT NULL,
    "expireLe" TIMESTAMP(3) NOT NULL,
    "organisationId" INTEGER NOT NULL,
    "boutiqueId" INTEGER NOT NULL,
    "clientId" INTEGER,
    "creeParId" INTEGER NOT NULL,
    "creeLe" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modifieLe" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VenteEnAttente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VenteEnAttente_organisationId_boutiqueId_expireLe_idx" ON "VenteEnAttente"("organisationId", "boutiqueId", "expireLe");

-- AddForeignKey
ALTER TABLE "VenteEnAttente" ADD CONSTRAINT "VenteEnAttente_organisationId_fkey" FOREIGN KEY ("organisationId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenteEnAttente" ADD CONSTRAINT "VenteEnAttente_boutiqueId_fkey" FOREIGN KEY ("boutiqueId") REFERENCES "Boutique"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenteEnAttente" ADD CONSTRAINT "VenteEnAttente_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VenteEnAttente" ADD CONSTRAINT "VenteEnAttente_creeParId_fkey" FOREIGN KEY ("creeParId") REFERENCES "Utilisateur"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "VenteEnAttente" ADD CONSTRAINT "VenteEnAttente_valeurs_positives" CHECK ("nombreArticles" > 0 AND "totalEstime" >= 0);
