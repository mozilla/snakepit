#!/bin/bash
if [ ! -f /code/bin/db-init.sh ]; then
    echo "This command should be run inside the snakepit container."
    exit 1
fi
if [ "$#" -ne 1 ]; then
  echo "Usage: db-restore.sh some-dump-file.sql"
  exit 1
fi

/code/bin/db-drop.sh
echo "Restoring snakepit DB from dump file $1..."
psql -U postgres snakepit < $1
echo "Done."
