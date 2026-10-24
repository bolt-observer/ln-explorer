#!/usr/bin/env bash
# Run on the VM from the checkout after `git checkout <ref>`:
#   bash deploy/vm-deploy.sh
# 1. Refuses to start without the data volume when backups exist (a lost
#    volume would otherwise silently restart history from zero).
# 2. Takes a consistent sqlite backup (SQLite online backup API) into
#    ~/backups before rebuilding, keeping the newest $KEEP_BACKUPS.
# 3. Rebuilds and restarts in the background; output goes to /tmp/build.log.
set -euo pipefail
cd "$(dirname "$0")/.."
VOLUME=explorer_explorer-data
CONTAINER=explorer-explorer-1
BACKUP_DIR=${BACKUP_DIR:-$HOME/backups}
KEEP_BACKUPS=${KEEP_BACKUPS:-5}
export COMPOSE_PROJECT_NAME=explorer

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  if compgen -G "$BACKUP_DIR/explorer-*.sqlite" >/dev/null && [ "${ALLOW_NEW_VOLUME:-0}" != 1 ]; then
    echo "volume $VOLUME is missing but backups exist in $BACKUP_DIR." >&2
    echo "Restore one first (see DEPLOYMENT.md) or rerun with ALLOW_NEW_VOLUME=1." >&2
    exit 1
  fi
  echo "volume $VOLUME not found: first deploy, it will be created"
fi

if docker ps -q -f "name=^${CONTAINER}$" | grep -q .; then
  mkdir -p "$BACKUP_DIR"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  docker exec "$CONTAINER" python -c "import sqlite3; s = sqlite3.connect('/data/explorer.sqlite'); d = sqlite3.connect('/tmp/backup.sqlite'); s.backup(d); d.close()"
  docker cp "$CONTAINER:/tmp/backup.sqlite" "$BACKUP_DIR/explorer-$stamp.sqlite" >/dev/null
  docker exec "$CONTAINER" rm -f /tmp/backup.sqlite
  ls -1t "$BACKUP_DIR"/explorer-*.sqlite | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
  echo "backup: $BACKUP_DIR/explorer-$stamp.sqlite ($(du -h "$BACKUP_DIR/explorer-$stamp.sqlite" | cut -f1))"
fi

git log -1 --format=%H
(setsid nohup docker compose up -d --build > /tmp/build.log 2>&1 < /dev/null &)
echo "build started"
