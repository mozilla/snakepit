#!/bin/bash

if [ $# -ne 2 ] ; then
    echo "Usage: prepare-directories.sh <user> <data-root>"
    exit 1
fi

$owner=$1
$root_dir=$2

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