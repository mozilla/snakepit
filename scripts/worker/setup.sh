#!/usr/bin/env bash
set -e

aptget() {
    DEBIAN_FRONTEND=noninteractive apt-get -yq "$@"
}

print_header () {
    printf "\n>>>>>>>> $1 <<<<<<<<\n\n"
}

print_header "Installing dependencies"
# # Official Nvidia Ubuntu PPA
# aptget update
# aptget install software-properties-common
# # !This image and your GPU nodes should feature the very same driver!
# add-apt-repository -y ppa:graphics-drivers/ppa
aptget update
aptget install sshfs vim iputils-ping
# aptget install nvidia-driver-410 nvidia-utils-410 nvidia-cuda-toolkit

print_header "Creating default pit info file"
echo 'PIT_DAEMON_HOST="snakepit-daemon.lxd"' >>/etc/pit_info

print_header "Creating data mount"
mkdir /data
mv data.mount /lib/systemd/system/
systemctl enable data.mount

print_header "Installing worker service"
mv run.sh /usr/bin/run.sh
mv snakepit.service /lib/systemd/system/
systemctl enable snakepit.service
