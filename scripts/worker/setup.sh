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
aptget install dhcpcd5 sshfs vim iputils-ping npm nfs-common
# aptget install nvidia-driver-410 nvidia-utils-410 nvidia-cuda-toolkit

print_header "Preparing apt"
mv 20auto-upgrades /etc/apt/apt.conf.d/20auto-upgrades
mv apt /usr/local/sbin/apt
mv apt-get /usr/local/sbin/apt-get
mv forwarder/forwarder.sh /usr/bin/forwarder.sh
mv forwarder /opt/forwarder
pushd /opt/forwarder
npm install
popd

print_header "Disabling cloud configuration"
echo 'network: {config: disabled}' >/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

print_header "Preparing SSH"
mkdir -p /root/.ssh
systemctl disable sshd

print_header "Installing worker service"
mv run.sh /usr/bin/run.sh
mv snakepit.service /lib/systemd/system/
systemctl enable snakepit.service

print_header "Configuring /etc/environment..."
mv proxy_env.sh /etc/profile.d/proxy_env.sh