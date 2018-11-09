#!/usr/bin/env bash
set -e

lxd_endpoint=$1

command=$'\n "sudo lxc exec snakepit -- /code/scripts/setup-service.sh '$lxd_endpoint$'"\n'
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
cp "/code/scripts/snakepit.conf.template" "$conf"
echo -e "# Local interface the snakepit service should use (e.g. 192.168.1.1).\ninterface: 0.0.0.0\n" >>$conf
echo -e "# Local port of the snakepit service.\nport: 80\n" >>$conf
echo -e "# External URL.\nexternal: \"http://snakepit.lxd\"\n" >>$conf
echo -e "# LXD REST URL.\nlxdEndpoint: \"$lxd_endpoint\"\n" >>$conf
echo -e "# LXD REST certificate.\nlxdcert: \"$config_dir/lxd.crt\"\n" >>$conf
echo -e "# LXD REST key.\nlxdkey: \"$config_dir/lxd.key\"\n" >>$conf
echo -e "# Path to data root.\ndataRoot: \"/data\"\n" >>$conf
echo -e "# Path to session token secret file.\ntokenSecretPath: \"$token_secret_path\"\n" >>$conf

if systemctl is-active --quiet snakepit; then
    systemctl stop snakepit
fi
cp /code/scripts/snakepit.service /lib/systemd/system/
systemctl enable snakepit
systemctl start snakepit
