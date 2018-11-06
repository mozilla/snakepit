#!/usr/bin/env bash
set -e
if [ $# -ne 1 ] && [ $# -ne 2 ] ; then
    echo "Usage: prepare-service-container.sh <data-path> [code-path]"
    exit 1
fi

bin/prepare-lxd.sh

uid=`ls -ldn "$1" | awk '{print $3}'`

if lxc network show snakebr0 > /dev/null 2>&1; then
    address=`lxc network get snakebr0 ipv4.address`
else
    if ! lxc network show lxdbr0 > /dev/null 2>&1; then
        lxc network create lxdbr0
    fi
    address=`lxc network get lxdbr0 ipv4.address`
fi
address="`echo "$address" | cut -d/ -f 1`"

lxc init ubuntu-minimal:18.04/amd64 snakepit
lxc config set snakepit raw.idmap "both $uid 0"
lxc config device add snakepit data disk path=/data source="$1"
if [ $# -eq 2 ]; then
    lxc config device add snakepit code disk path=/code source="$2"
fi

lxc start snakepit
exe="lxc exec snakepit -- "
$exe systemctl isolate multi-user.target

$exe bash -c 'DEBIAN_FRONTEND=noninteractive apt-get -yq update && \
    apt-get install -yq curl jq nodejs npm git build-essential'

if [ $# -ne 2 ]; then
    $exe bash -c 'git clone https://github.com/mozilla/snakepit.git /code; cd /code; npm install'
fi

$exe /code/scripts/setup-service.sh "https://${address}:8443"
