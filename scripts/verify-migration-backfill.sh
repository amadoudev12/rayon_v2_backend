#!/usr/bin/env bash
# Vérifie la reprise de données de la migration 20261115120000 sur une base
# JETABLE du conteneur de test (rayon-test-db) : applique les migrations
# précédentes, insère les cas historiques possibles, applique la nouvelle
# migration, puis contrôle chaque résultat. N'accède à aucune autre base.
#
#   bash scripts/verify-migration-backfill.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB=rayon_backfill_test
TARGET=20261115120000_retours_annulations_soldes
PSQL=(docker exec -i rayon-test-db psql -v ON_ERROR_STOP=1 -q -U rayon_test)

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"

for dir in prisma/migrations/*/; do
  name=$(basename "$dir")
  [[ "$name" == "$TARGET" ]] && break
  "${PSQL[@]}" -d "$DB" < "$dir/migration.sql"
done

"${PSQL[@]}" -d "$DB" < scripts/fixtures/backfill-legacy-data.sql
"${PSQL[@]}" -d "$DB" < "prisma/migrations/$TARGET/migration.sql"

FAILED=0
check() {
  local label=$1 query=$2 expected=$3 actual
  actual=$("${PSQL[@]}" -d "$DB" -At -c "$query")
  if [[ "$actual" == "$expected" ]]; then echo "OK   $label"; else echo "FAIL $label : attendu [$expected], obtenu [$actual]"; FAILED=1; fi
}

check "A comptant soldée"                 'SELECT "resteAPayer"::int, "montantRetourne"::int FROM "Vente" WHERE id = 1' "0|0"
check "B crédit : 3 000 dus"              'SELECT "resteAPayer"::int FROM "Vente" WHERE id = 2' "3000"
check "C annulation LEGACY, payé 0"       'SELECT "typeAnnulation", "montantPaye"::int, "resteAPayer"::int FROM "Vente" WHERE id = 3' "LEGACY|0|0"
check "C paiement conservé, marqué annulé" 'SELECT COUNT(*), COUNT("annuleLe") FROM "PaiementVente" WHERE "venteId" = 3' "1|1"
check "D annulation REFUND, 1 000 dus"    'SELECT "typeAnnulation", "montantARembourser"::int, "montantPaye"::int FROM "Vente" WHERE id = 4' "REFUND|1000|1000"
check "D paiement toujours valide"        'SELECT COUNT("annuleLe") FROM "PaiementVente" WHERE "venteId" = 4' "0"
check "E avoir de reprise de 700"         'SELECT "montantRetourne"::int, "montantARembourser"::int, "resteAPayer"::int FROM "Vente" WHERE id = 5' "700|700|0"
check "E demande rattachée à l'avoir"     'SELECT COUNT(*) FROM "RemboursementVente" r JOIN "RetourVente" rv ON rv.id = r."retourVenteId" WHERE r."venteId" = 5' "1"
check "aucune ligne supprimée"            'SELECT (SELECT COUNT(*) FROM "Vente"), (SELECT COUNT(*) FROM "PaiementVente"), (SELECT COUNT(*) FROM "RemboursementVente")' "5|5|2"

"${PSQL[@]}" -d postgres -c "DROP DATABASE $DB"
exit $FAILED
