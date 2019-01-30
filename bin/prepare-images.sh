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

    print_header "Creating ${role} SSH identity"
    $exe mkdir -p /root/.ssh
    $exe ssh-keygen -t rsa -b 4096 -f /root/.ssh/id_rsa -N "" -C "${role}@snakepit"
    lxc file pull snakepit-${role}/root/.ssh/id_rsa.pub /tmp/snakepit_${role}_id.pub

    print_header "Starting ${role} setup"
    tar cf - -C scripts/${role} . | lxc exec snakepit-${role} -- tar xvf - -C /root
    $exe bash /root/setup.sh
done

print_header "Pairing daemon and worker"
lxc file push -p /tmp/snakepit_daemon_id.pub snakepit-worker/root/.ssh/authorized_keys
lxc exec snakepit-worker -- chown -R root:root /root/.ssh
lxc file push -p /tmp/snakepit_worker_id.pub snakepit-daemon/home/worker/.ssh/authorized_keys   
lxc exec snakepit-daemon -- chown -R worker:worker /home/worker/.ssh

for role in "${roles[@]}"; do
    print_header "Finalizing ${role}..."
    rm -f /tmp/snakepit_${role}_id.pub
    lxc stop snakepit-${role}
    lxc publish --public snakepit-${role} --alias snakepit-${role}
    lxc delete snakepit-${role}
done