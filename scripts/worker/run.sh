#!/usr/bin/env bash
mkdir -p /data
hostname=`hostname`
daemon=`expr match ${hostname} '\(sp[0-9]+\)-[0-9]+'`-0.lxd
sshfs worker@${daemon} /data -o cache=yes,kernel_cache,big_writes,sshfs_sync,Ciphers=aes128-ctr,reconnect,ServerAliveInterval=15,ServerAliveCountMax=100

# shutdown 0