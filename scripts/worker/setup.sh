#!/usr/bin/env bash
set -e

aptget() {
    DEBIAN_FRONTEND=noninteractive apt-get -yq "$@"
}

# # Official Nvidia Ubuntu PPA
# aptget update
# aptget install software-properties-common
# # !This image and your GPU nodes should feature the very same driver!
# add-apt-repository -y ppa:graphics-drivers/ppa

aptget update
aptget install sshfs
# aptget install nvidia-driver-410 nvidia-utils-410 nvidia-cuda-toolkit
