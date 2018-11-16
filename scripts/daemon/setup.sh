#!/usr/bin/env bash
set -e

aptget() {
    DEBIAN_FRONTEND=noninteractive apt-get -yq "$@"
}

aptget update
aptget install openssh-server

mkdir -p /data
useradd -m -s /usr/sbin/nologin -u 2525 worker
mv /root/sshd_config /etc/ssh/sshd_config
