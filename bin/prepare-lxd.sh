#!/usr/bin/env bash
set -e

if [ $(lxc remote list | grep ubuntu-minimal | wc -l) -gt "0" ]; then
    echo "Remote ubuntu-minimal already configured - skipping..."
else
    echo "Adding remote ubuntu-minimal..."
    lxc remote add --protocol simplestreams ubuntu-minimal https://cloud-images.ubuntu.com/minimal/releases/
fi