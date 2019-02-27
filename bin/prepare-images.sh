#!/usr/bin/env bash
set -e
roles=(daemon worker)

print_header () {
    printf "\n>>>>>>>> $1 <<<<<<<<\n\n"
}

print_header "Configuring image source"
bin/prepare-lxd.sh

for role in "${roles[@]}"; do
    print_header "Creating ${role} image"
    lxc init ubuntu-minimal:18.04/amd64 snakepit-${role}
    lxc start snakepit-${role}
    exe="lxc exec snakepit-${role} -- "
    sleep 2
    $exe systemctl isolate multi-user.target

    print_header "Starting ${role} setup"
    tar cf - -C scripts/${role} . | lxc exec snakepit-${role} -- tar xvf - --no-same-owner -C /root
    $exe bash /root/setup.sh
done
