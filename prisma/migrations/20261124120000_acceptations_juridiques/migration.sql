-- Historique des acceptations des CGU et de la Politique de confidentialité.
--
-- Migration ADDITIVE ET NON DESTRUCTIVE : un type, une table, un trigger sur
-- cette table. Aucune ligne existante n'est lue ni modifiée, et aucune
-- acceptation n'est créée : celle des comptes existants sera demandée.
--
-- Retour arrière : redéployer le code précédent suffit (il ignore la table).
-- Ne pas supprimer la table : elle contient des preuves.

-- N'attend pas indéfiniment un verrou sur "Utilisateur" (clé étrangère) :
-- mieux vaut échouer sans effet que bloquer les connexions.
SET LOCAL lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "LegalAcceptanceSource" AS ENUM ('REGISTRATION', 'WEB', 'MOBILE');

-- CreateTable
CREATE TABLE "AcceptationJuridique" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "termsVersion" TEXT NOT NULL,
    "privacyVersion" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" "LegalAcceptanceSource" NOT NULL,

    CONSTRAINT "AcceptationJuridique_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AcceptationJuridique_userId_termsVersion_privacyVersion_key" ON "AcceptationJuridique"("userId", "termsVersion", "privacyVersion");

-- AddForeignKey
ALTER TABLE "AcceptationJuridique" ADD CONSTRAINT "AcceptationJuridique_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Utilisateur"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Ajout seul : une preuve ne se modifie pas et ne s'efface pas.
CREATE FUNCTION "refuser_modification_acceptation_juridique"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'AcceptationJuridique est en ajout seul (% refusé)', TG_OP;
END;
$$;

CREATE TRIGGER "AcceptationJuridique_ajout_seul"
BEFORE UPDATE OR DELETE ON "AcceptationJuridique"
FOR EACH ROW EXECUTE FUNCTION "refuser_modification_acceptation_juridique"();

-- Table de preuves : accessible au seul serveur (propriétaire de la table).
-- Les rôles d'API propres à Supabase n'existent pas sur un PostgreSQL ordinaire.
ALTER TABLE "AcceptationJuridique" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION "refuser_modification_acceptation_juridique"() FROM PUBLIC;

DO $$
DECLARE
  role_name text;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE "AcceptationJuridique" FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON SEQUENCE "AcceptationJuridique_id_seq" FROM %I', role_name);
    EXECUTE format('REVOKE ALL ON FUNCTION "refuser_modification_acceptation_juridique"() FROM %I', role_name);
  END LOOP;
END $$;
