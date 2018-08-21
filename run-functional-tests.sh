#!/usr/bin/env bash
[ -d test/functional ] || { echo >&2 "You should run this from Snakepit project-root.  Aborting."; exit 1; }
command -v pit >/dev/null 2>&1 || { echo >&2 "Unable to find pit command (snakepit-client).  Aborting."; exit 1; }
pit status >/dev/null || { echo >&2 "Problem accessing your pit. Aborting."; exit 1; }
if [ -f .test.env ]; then
    source .test.env
fi
for test in "$@"; do
    echo "Running test: $test"
    bash test/functional/$test/test.sh
done
