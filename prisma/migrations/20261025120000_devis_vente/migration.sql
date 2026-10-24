-- Transformation d'un devis en vente : lien facultatif du devis vers la vente
-- créée. Aucune donnée existante n'est modifiée.

-- AlterTable
ALTER TABLE "Devis" ADD COLUMN     "venteId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Devis_venteId_key" ON "Devis"("venteId");

-- AddForeignKey
ALTER TABLE "Devis" ADD CONSTRAINT "Devis_venteId_fkey" FOREIGN KEY ("venteId") REFERENCES "Vente"("id") ON DELETE SET NULL ON UPDATE CASCADE;
