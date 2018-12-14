#!/usr/bin/env bash
set -e

lxd_endpoint=$1
mount_root=$2
uid=$3

command=$'\n "sudo lxc exec snakepit -- /code/scripts/setup-service.sh '$lxd_endpoint$' '$mount_root' '$uid'"\n'
if ! curl -k -s $lxd_endpoint/1.0 > /dev/null 2>&1; then
    echo "Problem accessing \"$lxd_endpoint\"."
    echo "You have to enable LXD's REST API access over HTTPS."
    echo "Please call $command with the appropriate LXD REST service endpoint."
    exit 1
fi

config_dir="/etc/snakepit"
mkdir -p "$config_dir"

openssl req -new -newkey rsa:4096 -days 3650 -nodes -x509 \
    -subj "/C=US/ST=California/L=San Francisco/O=Mozilla/CN=mozilla.com" \
    -keyout "$config_dir/lxd.key" \
    -out "$config_dir/lxd.crt" \
    > /dev/null 2>&1
echo -n "Local LXD trust password: " 
read -s password
echo ""
json=$(curl \
    -s \
    -k \
    --cert "$config_dir/lxd.crt" \
    --key "$config_dir/lxd.key" \
    $lxd_endpoint/1.0/certificates \
    -X POST \
    -d "{\"type\": \"client\", \"password\": \"$password\"}" \
)
if [[ "`echo $json | jq '.status_code'`" -ne "200" ]]; then
    echo "Problem authenticating at \"$lxd_endpoint\". Please call $command again and provide the correct password."
    exit 2
fi

token_secret_path="$config_dir/token-secret.txt"
touch "$token_secret_path"
chmod 600 "$token_secret_path"
openssl rand -base64 32 >"$token_secret_path"

conf="$config_dir/snakepit.conf"
touch "$conf"
chmod 644 "$conf"
echo -e "# LXD REST URL.\nendpoint: \"$lxd_endpoint\"\n" >>$conf
echo -e "# LXD REST client certificate file.\nclientCert: \"$config_dir/lxd.crt\"\n" >>$conf
echo -e "# LXD REST client key file.\nclientKey: \"$config_dir/lxd.key\"\n" >>$conf
echo -e "# External path of LXD data drive (required for mounting).\nmountRoot: \"$mount_root\"\n" >>$conf
echo -e "# UID of external user that should be mapped to worker/root user (required for write access on mounts).\nmountUid: \"$uid\"\n" >>$conf
echo -e "# Path to session token secret file.\ntokenSecretPath: \"$token_secret_path\"\n" >>$conf

if systemctl is-active --quiet snakepit; then
    systemctl stop snakepit
fi
cp /code/scripts/snakepit.service /lib/systemd/system/
systemctl enable snakepit
reboot
