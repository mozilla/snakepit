#!/bin/bash

owner=snakepit
if [ -z "$1" ]; then
    root_dir="/var/snakepit"
else
    root_dir="$1"
    if ! [ -z "$2" ]; then
        owner="$2"
    fi
fi
if ! id "$owner" >/dev/null 2>&1; then
    echo "Unknown user: $owner"
    exit 1
fi

mkdir -p "$root_dir"
mkdir -p "$root_dir/shared"
mkdir -p "$root_dir/home"
mkdir -p "$root_dir/groups"
mkdir -p "$root_dir/cache"
mkdir -p "$root_dir/pits"

chown -R $owner:$owner "$root_dir"
chmod -R 700 "$root_dir"