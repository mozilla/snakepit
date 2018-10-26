#!/usr/bin/env bash
set -e

bin/prepare-lxd.sh

lxc init ubuntu-minimal:18.04/amd64 snaked
lxc start snaked
exe="lxc exec snaked -- "
$exe systemctl isolate multi-user.target

lxc file push scripts/setup-daemon-image.sh snaked/root/
$exe bash /root/setup-daemon-image.sh

lxc stop snaked
lxc publish snaked --alias snaked
lxc delete snaked
