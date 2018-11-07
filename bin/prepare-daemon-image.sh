#!/usr/bin/env bash
set -e

bin/prepare-lxd.sh

lxc init ubuntu-minimal:18.04/amd64 snakepit-daemon
lxc start snakepit-daemon
exe="lxc exec snakepit-daemon -- "
$exe systemctl isolate multi-user.target

lxc file push scripts/setup-daemon-image.sh snakepit-daemon/root/
$exe bash /root/setup-daemon-image.sh

lxc stop snakepit-daemon
lxc publish --public snakepit-daemon --alias snakepit-daemon
lxc delete snakepit-daemon
