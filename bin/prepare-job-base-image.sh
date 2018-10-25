#!/usr/bin/env bash
set -e

lxc init ubuntu:18.04 snake
lxc start snake
exe="lxc exec snake -- "
$exe systemctl isolate multi-user.target
# Official Nvidia Ubuntu PPA
# !This image and your GPU nodes should feature the very same driver!
$exe add-apt-repository -y ppa:graphics-drivers/ppa
$exe apt update
$exe apt install -y --no-install-recommends \
    curl jq nodejs npm git build-essential \
    nvidia-driver-410 nvidia-utils-410 nvidia-cuda-toolkit
$exe bash -c 'git clone https://github.com/mozilla/httpfs.git /code; cd /code; npm install'
lxc stop snake
lxc publish snake --alias snake
