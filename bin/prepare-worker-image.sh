#!/usr/bin/env bash
set -e

bin/prepare-lxd.sh

lxc init ubuntu-minimal:18.04/amd64 snakepit-worker
lxc start snakepit-worker
exe="lxc exec snakepit-worker -- "
$exe systemctl isolate multi-user.target

lxc file push scripts/setup-worker-image.sh snakepit-worker/root/
$exe bash /root/setup-worker-image.sh

lxc stop snakepit-worker
lxc publish --public snakepit-worker --alias snakepit-worker
lxc delete snakepit-worker
