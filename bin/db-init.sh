#!/bin/bash
if [ ! -f /code/bin/db-init.sh ]; then
    echo "This command should be run inside the snakepit container."
    exit 1
fi

echo "Creating snakepit DB..."
createdb -U postgres snakepit
echo "Done."
echo "Preparing tables..."
psql -q -U postgres -d snakepit -f /code/sql/create.sql
echo "Done."