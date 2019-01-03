#!/bin/bash
if [ ! -f /code/bin/db-init.sh ]; then
    echo "This command should be run inside the snakepit container."
    exit 1
fi

pg_dump -U postgres snakepit
