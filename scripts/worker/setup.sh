#!/usr/bin/env bash
set -e

aptget() {
    DEBIAN_FRONTEND=noninteractive apt-get -yq "$@"
}

print_header () {
    printf "\n>>>>>>>> $1 <<<<<<<<\n\n"
}

print_header "Configuring APT repositories"
aptget update
aptget install software-properties-common
apt-key adv --fetch-keys https://developer.download.nvidia.com/compute/cuda/repos/ubuntu1804/x86_64/7fa2af80.pub
echo "deb http://developer.download.nvidia.com/compute/cuda/repos/ubuntu1804/x86_64 /" > /etc/apt/sources.list.d/cuda.list
# seems to not be used
# echo "deb http://developer.download.nvidia.com/compute/machine-learning/repos/ubuntu1804/x86_64 /" > /etc/apt/sources.list.d/nvidia-machine-learning.list

print_header "Installing dependencies"
aptget update
# install general things
aptget install dhcpcd5 sshfs vim iputils-ping npm git
# install nvidia things
# !This image and your GPU nodes should feature the very same driver!
# (just 'cuda' gets the latest)
# cuda conflicts with installing cuda-drivers-460 it seems
# cuda-11-2 doesn't install everything (missing cuda-runtime-11-2 and cuda-demo-suite-11-2)
aptget install cuda-11-2
# 11-2 installs 470 (or what the host has installed?), downgrade to 460
aptget install cuda-drivers-460
# other packages that seem handy
aptget install libcudnn7 libcudnn7-dev libnvinfer-dev libnvinfer5

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

print_header "Configuring proxy environment variables..."
mv proxy_env.sh /etc/profile.d/proxy_env.sh
