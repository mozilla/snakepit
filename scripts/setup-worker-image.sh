#!/usr/bin/env bash
set -e

aptget() {
    DEBIAN_FRONTEND=noninteractive apt-get -yq "$@"
}

aptget update
aptget install software-properties-common

# Official Nvidia Ubuntu PPA
# !This image and your GPU nodes should feature the very same driver!
add-apt-repository -y ppa:graphics-drivers/ppa

aptget update
aptget install git build-essential libfuse-dev libnfs11 libtool m4 automake libnfs-dev xsltproc \

cd /root 
git clone https://github.com/sahlberg/fuse-nfs.git
cd fuse-nfs
./setup.sh
./configure
make
make install
cd ..
rm -rf fuse-nfs

aptget remove git build-essential libtool m4 automake libfuse-dev libnfs-dev xsltproc

aptget install nvidia-driver-410 nvidia-utils-410 nvidia-cuda-toolkit