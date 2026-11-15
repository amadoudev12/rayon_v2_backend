#!/usr/bin/env bash
# Teste une sauvegarde : restauration dans une base JETABLE puis contrôles.
# Une sauvegarde qui n'a jamais été restaurée n'est pas une sauvegarde fiable.
#
#   RESTORE_TARGET_URL="postgresql://…/rayon_restore_test" bash scripts/restore-test.sh backups/rayon-….dump
#
# Garde-fous : la base cible doit se terminer par _test ; elle est vidée puis
# recréée. Aucune autre base n'est touchée. Contrôles : empreinte SHA-256,
# migrations Prisma présentes, nombre de lignes des tables clés, audit
# d'intégrité (scripts/audit-integrity.sql).
set -euo pipefail

dump="${1:?Chemin du fichier de sauvegarde (.dump) requis}"
: "${RESTORE_TARGET_URL:?RESTORE_TARGET_URL est requis (base jetable *_test)}"
PG_RESTORE="${PG_RESTORE:-pg_restore}"
PSQL="${PSQL:-psql}"

db_name="${RESTORE_TARGET_URL##*/}"
db_name="${db_name%%\?*}"
if [[ "$db_name" != *_test ]]; then
  echo "Refus : la base cible « $db_name » ne se termine pas par _test." >&2
  exit 1
fi
admin_url="${RESTORE_TARGET_URL%/*}/postgres"

if [[ -f "$dump.sha256" ]]; then
  (cd "$(dirname "$dump")" && sha256sum --check --quiet "$(basename "$dump").sha256")
  echo "OK   empreinte SHA-256"
fi

"$PSQL" "$admin_url" -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$db_name\"" -c "CREATE DATABASE \"$db_name\""
"$PG_RESTORE" --no-owner --no-privileges --exit-on-error --dbname="$RESTORE_TARGET_URL" "$dump"
echo "OK   restauration sans erreur"

q() { "$PSQL" "$RESTORE_TARGET_URL" -At -v ON_ERROR_STOP=1 -c "$1"; }
echo "     migrations appliquées : $(q 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
for table in Organisation Utilisateur Produit Stock Vente PaiementVente MouvementStock Achat Depense; do
  echo "     $table : $(q "SELECT COUNT(*) FROM \"$table\"") ligne(s)"
done
if q "SELECT 1 FROM information_schema.columns WHERE table_name = 'Vente' AND column_name = 'montantRetourne'" | grep -q 1; then
  echo "--- audit d'intégrité (lignes en infraction) :"
  "$PSQL" "$RESTORE_TARGET_URL" -At -F ' | ' -f "$(dirname "$0")/audit-integrity.sql"
fi
echo "Restauration vérifiée. Base de contrôle conservée : $db_name (à supprimer après examen)."
