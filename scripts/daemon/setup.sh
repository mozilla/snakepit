#!/usr/bin/env bash
set -e

aptget() {
    DEBIAN_FRONTEND=noninteractive apt-get -yq "$@"
}

print_header () {
    printf "\n>>>>>>>> $1 <<<<<<<<\n\n"
}

mkdir /ro
mkdir /data
mkdir /data/ro
mkdir /data/rw

print_header "Installing dependencies"
aptget update
aptget install dhcpcd5 openssh-server vim iputils-ping moreutils bindfs

print_header "Creating user worker"
useradd -m -s /usr/sbin/nologin -u 2525 worker
password=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
echo "worker:${password}" | chpasswd

print_header "Installing read-only mount"
mv data-ro.mount /lib/systemd/system/
systemctl enable data-ro.mount

print_header "Configuring ssh-daemon"
mv /root/sshd_config /etc/ssh/sshd_config

print_header "Disabling cloud configuration"
echo 'network: {config: disabled}' >/etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

print_header "Installing daemon service"
mv run.sh /usr/bin/run.sh
mv snakepit.service /lib/systemd/system/
systemctl enable snakepit
