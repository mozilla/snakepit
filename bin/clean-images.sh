#!/usr/bin/env bash

lxc delete --force snakew
lxc delete --force snaked
lxc image delete snakew
lxc image delete snaked