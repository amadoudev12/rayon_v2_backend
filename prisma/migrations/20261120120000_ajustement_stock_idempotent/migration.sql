-- Ajustement manuel de stock idempotent (double clic, nouvel essai après une
-- coupure réseau : un seul mouvement est enregistré).
--
-- Migration ADDITIVE : une colonne facultative et un index. Aucune ligne
-- existante n'est modifiée ; les mouvements historiques gardent une clé NULL
-- (PostgreSQL autorise plusieurs NULL dans un index unique).
--
-- Risque : la création de l'index lit toute la table "MouvementStock" et
-- bloque les écritures de stock pendant ce temps (quelques secondes au plus
-- pour quelques centaines de milliers de mouvements). À appliquer hors des
-- heures d'ouverture.
--
-- Retour arrière :
--   DROP INDEX "MouvementStock_boutiqueId_cleIdempotence_key";
--   ALTER TABLE "MouvementStock" DROP COLUMN "cleIdempotence";

ALTER TABLE "MouvementStock" ADD COLUMN "cleIdempotence" TEXT;

CREATE UNIQUE INDEX "MouvementStock_boutiqueId_cleIdempotence_key"
  ON "MouvementStock"("boutiqueId", "cleIdempotence");
