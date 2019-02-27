#!/usr/bin/env bash

set -e
tmpd=$(mktemp -d)
mkfifo "${tmpd}/key" "${tmpd}/key.pub"
(
    cat "${tmpd}/key"
    echo "-----BEGIN SSH-RSA PUBLIC KEY-----"
    cat "${tmpd}/key.pub"
) &
echo "y" | ssh-keygen -q -N "" -f "${tmpd}/key" 2>/dev/null 1>/dev/null
rm -rf "$tmpd"