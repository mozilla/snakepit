#!/usr/bin/env bash
set -e

bin/prepare-lxd.sh

lxc init ubuntu-minimal:18.04/amd64 snakew
lxc start snakew
exe="lxc exec snakew -- "
$exe systemctl isolate multi-user.target

lxc file push scripts/setup-worker-image.sh snakew/root/
$exe bash /root/setup-worker-image.sh

lxc stop snakew
lxc publish snakew --alias snakew
lxc delete snakew
