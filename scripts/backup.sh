#!/usr/bin/env bash
# Sauvegarde PostgreSQL de Rayon (LECTURE SEULE sur la base source).
#
#   BACKUP_DATABASE_URL="postgresql://…" BACKUP_DIR=/var/backups/rayon bash scripts/backup.sh
#
# - format « custom » de pg_dump (compressé, restauration sélective possible) ;
# - nom horodaté UTC, empreinte SHA-256 à côté du fichier ;
# - conservation : 14 sauvegardes quotidiennes (BACKUP_KEEP pour changer) ;
# - à planifier chaque nuit (cron, systemd timer, tâche planifiée) ET à copier
#   hors du serveur (stockage objet chiffré) : une sauvegarde sur la même
#   machine que la base ne protège pas d'une perte du serveur.
# Utiliser l'URL DIRECTE (port 5432), jamais le pooler en mode transaction.
set -euo pipefail

: "${BACKUP_DATABASE_URL:?BACKUP_DATABASE_URL est requis (URL directe de la base à sauvegarder)}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
PG_DUMP="${PG_DUMP:-pg_dump}"

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
file="$BACKUP_DIR/rayon-$stamp.dump"

"$PG_DUMP" --format=custom --compress=6 --no-owner --no-privileges --file="$file" "$BACKUP_DATABASE_URL"
sha256sum "$file" > "$file.sha256"
echo "Sauvegarde écrite : $file ($(du -h "$file" | cut -f1))"

# Rotation : on garde les BACKUP_KEEP plus récentes.
ls -1t "$BACKUP_DIR"/rayon-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -f -- "$old" "$old.sha256"
  echo "Ancienne sauvegarde supprimée : $old"
done
