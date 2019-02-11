#!/usr/bin/env bash
set -e
roles=(daemon worker)

print_header () {
    printf "\n>>>>>>>> $1 <<<<<<<<\n\n"
}

for role in "${roles[@]}"; do
    print_header "Publishing ${role}..."
    lxc stop snakepit-${role} || true
    lxc image delete snakepit-${role} || true
    lxc publish --public snakepit-${role} --alias snakepit-${role} || true
done
