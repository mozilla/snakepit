#!/bin/bash
if [ ! -f /code/bin/db-init.sh ]; then
    echo "This command should be run inside the snakepit container."
    exit 1
fi
if [ "$#" -ne 1 ]; then
  echo "Usage: db-dump.sh some-dump-file.sql"
  exit 1
fi

echo "Writing snakepit DB to dump file $1..."
pg_dump -U postgres snakepit > $1
echo "Done."
