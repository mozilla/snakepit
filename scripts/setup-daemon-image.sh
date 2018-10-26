#!/usr/bin/env bash
set -e

aptget() {
    DEBIAN_FRONTEND=noninteractive apt-get -yq "$@"
}

aptget update
aptget install nfs-ganesha-vfs
