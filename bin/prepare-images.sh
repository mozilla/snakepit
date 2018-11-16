#!/usr/bin/env bash
set -e
bin/prepare-lxd.sh
roles=(daemon worker)

for role in "${roles[@]}"; do
	lxc init ubuntu-minimal:18.04/amd64 snakepit-${role}
    lxc start snakepit-${role}
    exe="lxc exec snakepit-${role} -- "
    $exe systemctl isolate multi-user.target

    $exe mkdir -p /root/.ssh
    $exe ssh-keygen -t rsa -b 4096 -f /root/.ssh/id_rsa -N "" -C "${role}@snakepit"
    lxc file pull snakepit-${role}/root/.ssh/id_rsa.pub /tmp/snakepit_${role}_id.pub

    tar cf - -C scripts/${role} . | lxc exec snakepit-${role} -- tar xvf - -C /root
    $exe bash /root/setup.sh
    $exe mv /root/run.sh /usr/bin/run.sh
    $exe mv /root/snakepit.service /lib/systemd/system/
    $exe systemctl enable snakepit
done

lxc file push -p /tmp/snakepit_daemon_id.pub snakepit-worker/root/.ssh/authorized_keys
lxc exec snakepit-worker -- chown -R root:root /root/.ssh
lxc file push -p /tmp/snakepit_worker_id.pub snakepit-daemon/home/worker/.ssh/authorized_keys
lxc exec snakepit-daemon -- chown -R worker:worker /home/worker/.ssh

for role in "${roles[@]}"; do
    rm -f /tmp/snakepit_${role}_id.pub
    # lxc stop snakepit-${role}
    # lxc publish --public snakepit-${role} --alias snakepit-${role}
    # lxc delete snakepit-${role}
done