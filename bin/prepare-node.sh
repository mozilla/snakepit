#!/usr/bin/env bash

apt update
apt install nfs-common openssh-server

adduser --disabled-password --gecos "" -u 1555 snakepit
adduser --disabled-password --gecos "" -u 2555 snake
echo 'snakepit ALL=(snake) NOPASSWD: /bin/bash' | sudo EDITOR='tee -a' visudo
