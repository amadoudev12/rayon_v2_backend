#!/usr/bin/env bash
# Vérifie les migrations d'abonnement (20261121120000_abonnements_fondations
# puis 20261122120000_paiements_recus_notifications) sur une base
# JETABLE du conteneur de test (rayon-test-db) : applique les migrations
# précédentes, insère des organisations historiques (sans abonnement, avec un
# abonnement saisi avant le catalogue et un paiement), applique la migration,
# puis contrôle que rien n'a été modifié ni supprimé. N'accède à aucune autre base.
#
#   bash scripts/verify-migration-subscriptions.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB=rayon_subscription_migration_test
TARGET=20261121120000_abonnements_fondations
PSQL=(docker exec -i rayon-test-db psql -v ON_ERROR_STOP=1 -q -U rayon_test)

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"

for dir in prisma/migrations/*/; do
  name=$(basename "$dir")
  [[ "$name" == "$TARGET" ]] && break
  "${PSQL[@]}" -d "$DB" < "$dir/migration.sql"
done

"${PSQL[@]}" -d "$DB" <<'SQL'
INSERT INTO "Organisation" (id, nom, slug, "modifieLe") VALUES
  (1, 'Sans abonnement', 'sans-abonnement', now()),
  (2, 'Abonnement historique', 'abonnement-historique', now());
INSERT INTO "Abonnement" (id, plan, statut, "essaiFinLe", "periodeDebut", "periodeFin", "organisationId", "modifieLe") VALUES
  (1, 'essentiel', 'ACTIVE', NULL, '2026-10-01', '2026-12-01', 2, now());
INSERT INTO "PaiementAbonnement" (id, montant, devise, statut, fournisseur, "referenceExterne", "periodeDebut", "periodeFin", "payeLe", "abonnementId") VALUES
  (1, 15000, 'XOF', 'SUCCEEDED', 'manuel', 'OM-001', '2026-10-01', '2026-12-01', '2026-10-01', 1);
SQL

"${PSQL[@]}" -d "$DB" < "prisma/migrations/$TARGET/migration.sql"
"${PSQL[@]}" -d "$DB" < "prisma/migrations/20261122120000_paiements_recus_notifications/migration.sql"
"${PSQL[@]}" -d "$DB" < "prisma/migrations/20261123120000_administration_abonnements/migration.sql"

FAILED=0
check() {
  local label=$1 query=$2 expected=$3 actual
  actual=$("${PSQL[@]}" -d "$DB" -At -c "$query")
  if [[ "$actual" == "$expected" ]]; then echo "OK   $label"; else echo "FAIL $label : attendu [$expected], obtenu [$actual]"; FAILED=1; fi
}

check "aucune ligne supprimée"                 'SELECT (SELECT COUNT(*) FROM "Organisation"), (SELECT COUNT(*) FROM "Abonnement"), (SELECT COUNT(*) FROM "PaiementAbonnement")' "2|1|1"
check "organisation existante : non soumise"   'SELECT COUNT(*) FROM "Abonnement" WHERE "organisationId" = 1' "0"
check "abonnement historique inchangé"         $'SELECT plan, statut, "periodeFin"::date FROM "Abonnement" WHERE id = 1' "essentiel|ACTIVE|2026-12-01"
check "nouvelles colonnes vides"               'SELECT COUNT(*) FROM "Abonnement" WHERE "essaiDebutLe" IS NULL AND "forfaitProgramme" IS NULL AND "forfaitProgrammeLe" IS NULL AND "suspenduLe" IS NULL AND "motifSuspension" IS NULL' "1"
check "pays inconnu pour l'existant"           'SELECT COUNT(*) FROM "Organisation" WHERE pays IS NULL' "2"
check "paiement historique intact"             'SELECT montant::int, statut, "referenceExterne" FROM "PaiementAbonnement" WHERE id = 1' "15000|SUCCEEDED|OM-001"
check "historique vide (aucune écriture)"      'SELECT COUNT(*) FROM "HistoriqueAbonnement"' "0"
check "paiement rattaché à son organisation" 'SELECT "organisationId", "abonnementId", "fournisseur" FROM "PaiementAbonnement" WHERE id = 1' "2|1|manuel"
check "nouveaux champs de paiement vides"    'SELECT COUNT(*) FROM "PaiementAbonnement" WHERE "referenceInterne" IS NULL AND "montantRecu" IS NULL AND "paiementRecuLe" IS NULL' "1"
check "aucun reçu ni notification créés"     'SELECT (SELECT COUNT(*) FROM "RecuAbonnement"), (SELECT COUNT(*) FROM "Notification"), (SELECT COUNT(*) FROM "EvenementPaiement")' "0|0|0"
check "nouveaux statuts de paiement"         $'SELECT COUNT(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = \'SubscriptionPaymentStatus\' AND e.enumlabel IN (\'CANCELLED\', \'UNDER_REVIEW\')' "2"
check "journal d'administration vide"         'SELECT COUNT(*) FROM "JournalAdministration"' "0"
check "aucun statut de suspension mémorisé"   'SELECT COUNT(*) FROM "Abonnement" WHERE "statutAvantSuspension" IS NULL' "1"
check "contrainte rétrogradation cohérente"    $'SELECT COUNT(*) FROM pg_constraint WHERE conname = \'Abonnement_retrogradation_coherente\'' "1"

"${PSQL[@]}" -d postgres -c "DROP DATABASE $DB"
exit $FAILED
