#!/bin/bash

root_dir=$1

if [ -z "$2" ]; then
    owner=snakepit
else
    owner=$2
fi

mkdir -p "$root_dir"
chmod 755 "$root_dir"

mkdir -p "$root_dir/shared"
chmod -R 755 "$root_dir/shared"

mkdir -p "$root_dir/groups"
chmod -R 700 "$root_dir/groups"

mkdir -p "$root_dir/archive"
chmod -R 700 "$root_dir/archive"

mkdir -p "$root_dir/cache"
chmod -R 700 "$root_dir/cache"

mkdir -p "$root_dir/uploads"
chmod -R 700 "$root_dir/uploads"

mkdir -p "$root_dir/jobs"
chmod 700 "$root_dir/jobs"
shopt -s nullglob
for entry in "$root_dir/jobs/"* ; do
    chmod -R 755 "$entry"
done

chown -R $owner:$owner "$root_dir"