#!/usr/bin/env bash

lxc delete --force snakepit-worker
lxc delete --force snakepit-daemon
lxc image delete snakepit-worker
lxc image delete snakepit-daemon