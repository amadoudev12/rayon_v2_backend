#!/usr/bin/env bash
# Répétition des migrations sur une COPIE de données réelles, avant de les
# appliquer à la vraie base (développement ou production).
#
#   bash scripts/verify-migrations-on-dump.sh <sauvegarde.dump>
#
# 1. restaure la sauvegarde (format pg_dump custom) dans une base JETABLE du
#    conteneur de test (rayon-test-db, voir docker-compose.test.yml) ;
# 2. compte les lignes de toutes les tables ;
# 3. applique les migrations en attente (prisma migrate deploy) ;
# 4. vérifie qu'aucune ligne existante n'a disparu et que le schéma obtenu
#    correspond à schema.prisma ;
# 5. supprime la base jetable.
#
# Aucune autre base n'est lue ni modifiée. Nécessite pg_restore (PostgreSQL
# client, ex : PG_BIN="/c/Program Files/PostgreSQL/18/bin") et TEST_DATABASE_URL
# dans .env.test.
set -euo pipefail
cd "$(dirname "$0")/.."

DUMP=${1:?"Usage : bash scripts/verify-migrations-on-dump.sh <sauvegarde.dump>"}
[[ -f "$DUMP" ]] || { echo "Sauvegarde introuvable : $DUMP"; exit 1; }
PG_BIN=${PG_BIN:-}
PG_RESTORE="${PG_BIN:+$PG_BIN/}pg_restore"
DB=rayon_dump_rehearsal_test

# Connexion au serveur de test (identifiants de .env.test, jamais affichés).
eval "$(node -e '
require("dotenv").config({ path: ".env.test", quiet: true });
const u = new URL(process.env.TEST_DATABASE_URL);
const q = (v) => "\x27" + v.replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
console.log(`export PGHOST=${q(u.hostname)} PGPORT=${q(u.port || "5432")} PGUSER=${q(decodeURIComponent(u.username))} PGPASSWORD=${q(decodeURIComponent(u.password))}`);
console.log(`BASE_PATH=${q(u.pathname)}`);
')"
# URL complète gardée en mémoire seulement (jamais affichée).
REHEARSAL_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${DB}"
PSQL=(docker exec -i rayon-test-db psql -v ON_ERROR_STOP=1 -q -U "$PGUSER")

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
cleanup() { "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "› Restauration de la copie…"
"$PG_RESTORE" --no-owner --no-privileges --dbname="$DB" "$DUMP" 2> restore.log || true
# Erreurs tolérées : rôles et extensions propres à l'environnement d'origine.
if grep -E "ERROR|ERREUR" restore.log | grep -vEi "role|rôle|extension|schema \"public\" already exists|schéma « public » existe" >/dev/null; then
  echo "Restauration incomplète (voir restore.log)"; exit 1
fi
rm -f restore.log

count_rows() {
  "${PSQL[@]}" -d "$DB" -At -c "ANALYZE" >/dev/null
  "${PSQL[@]}" -d "$DB" -At -c "SELECT string_agg(t || '=' || c, ',' ORDER BY t) FROM (SELECT table_name AS t, (xpath('/row/c/text()', query_to_xml(format('SELECT COUNT(*) AS c FROM %I', table_name), false, true, '')))[1]::text::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations') x"
}
BEFORE=$(count_rows)
echo "› Migrations en attente :"
# `migrate status` sort en erreur quand des migrations sont en attente : on ne garde que la liste.
PENDING=$(DATABASE_URL="$REHEARSAL_URL" DIRECT_URL="$REHEARSAL_URL" npx prisma migrate status 2>/dev/null | grep -E "^[0-9]{14}_" || true)
if [[ -n "$PENDING" ]]; then sed "s/^/  /" <<< "$PENDING"; else echo "  (aucune)"; fi

echo "› Application des migrations…"
DATABASE_URL="$REHEARSAL_URL" DIRECT_URL="$REHEARSAL_URL" npx prisma migrate deploy >/dev/null 2>&1
AFTER=$(count_rows)

FAILED=0
IFS=',' read -ra ROWS <<< "$BEFORE"
for row in "${ROWS[@]}"; do
  table=${row%%=*}; before=${row#*=}
  after=$(tr ',' '\n' <<< "$AFTER" | grep -E "^${table}=" | cut -d= -f2)
  if [[ "$after" != "$before" ]]; then echo "FAIL $table : $before ligne(s) avant, ${after:-?} après"; FAILED=1; fi
done
[[ $FAILED -eq 0 ]] && echo "OK   aucune ligne existante perdue (${#ROWS[@]} tables comparées)"

if DATABASE_URL="$REHEARSAL_URL" DIRECT_URL="$REHEARSAL_URL" \
  npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code >/dev/null 2>&1; then
  echo "OK   schéma obtenu = schema.prisma"
else
  echo "FAIL le schéma obtenu diffère de schema.prisma"; FAILED=1
fi
echo "OK   organisations sans abonnement après migration : $("${PSQL[@]}" -d "$DB" -At -c 'SELECT COUNT(*) FROM "Organisation" o WHERE NOT EXISTS (SELECT 1 FROM "Abonnement" a WHERE a."organisationId" = o.id)') (restent non soumises)"
exit $FAILED
