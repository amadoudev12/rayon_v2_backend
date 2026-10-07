-- Connexion par email OU par numéro de téléphone. Migration sans perte : les
-- comptes existants gardent leur email et n'ont simplement pas de téléphone.

-- AlterTable
ALTER TABLE "Utilisateur" ADD COLUMN     "telephone" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Utilisateur_telephone_key" ON "Utilisateur"("telephone");

-- Un compte doit toujours garder au moins un identifiant de connexion.
-- (Contrainte non exprimable dans le schéma Prisma, ajoutée à la main.)
ALTER TABLE "Utilisateur" ADD CONSTRAINT "Utilisateur_identifiant_check" CHECK ("email" IS NOT NULL OR "telephone" IS NOT NULL);
