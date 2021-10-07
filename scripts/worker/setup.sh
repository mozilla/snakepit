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
#just 'cuda' gets the latest, '11-4' currently)
aptget install cuda-11-2
# 11-2 installs 470 or what the host has installed?), downgrade to 460.32.03
# need to specify exact versions of all dependencies, otherwise apt will try to use latest and fail
DEBIAN_FRONTEND=noninteractive \
apt-get -yq --allow-downgrades install \
    libnvidia-cfg1-460=460.32.03-0ubuntu1 \
    libnvidia-common-460=460.32.03-0ubuntu1 \
    libnvidia-compute-460=460.32.03-0ubuntu1 \
    libnvidia-decode-460=460.32.03-0ubuntu1 \
    libnvidia-encode-460=460.32.03-0ubuntu1 \
    libnvidia-extra-460=460.32.03-0ubuntu1 \
    libnvidia-fbc1-460=460.32.03-0ubuntu1 \
    libnvidia-gl-460=460.32.03-0ubuntu1 \
    libnvidia-ifr1-460=460.32.03-0ubuntu1 \
    nvidia-compute-utils-460=460.32.03-0ubuntu1 \
    nvidia-dkms-460=460.32.03-0ubuntu1 \
    nvidia-driver-460=460.32.03-0ubuntu1 \
    nvidia-kernel-common-460=460.32.03-0ubuntu1 \
    nvidia-kernel-source-460=460.32.03-0ubuntu1 \
    nvidia-modprobe=460.32.03-0ubuntu1 \
    nvidia-prime \
    nvidia-settings=460.32.03-0ubuntu1 \
    nvidia-utils-460=460.32.03-0ubuntu1 \
    xserver-xorg-video-nvidia-460=460.32.03-0ubuntu1
# clean up
apt clean

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

print_header "Configuring APT proxy"
mv proxy_apt.conf /etc/apt/apt.conf.d/proxy.conf

print_header "Configuring /etc/profile.d proxy environment variables"
mv proxy_env.sh /etc/profile.d/proxy_env.sh

# /etc/environment doesn't do any variable interpolation (can't do HTTP_PROXY=$http_proxy)
print_header "Configuring /etc/environment"
echo 'http_proxy="http://192.168.1.1:3128/"' >> /etc/environment
echo 'https_proxy="http://192.168.1.1:3128/"' >> /etc/environment
echo 'ftp_proxy="http://192.168.1.1:3128/"' >> /etc/environment
echo 'no_proxy="localhost,127.0.0.1,::1,.mlc,192.168.1.1,10.2.224.243"' >> /etc/environment
# all caps versions of the above
echo 'HTTP_PROXY="http://192.168.1.1:3128/"' >> /etc/environment
echo 'HTTPS_PROXY="http://192.168.1.1:3128/"' >> /etc/environment
echo 'FTP_PROXY="http://192.168.1.1:3128/"' >> /etc/environment
echo 'NO_PROXY="localhost,127.0.0.1,::1,.mlc,192.168.1.1,10.2.224.243"' >> /etc/environment
