#!/usr/bin/env bash

config_dir="$PWD/config"
if [ -d "$config_dir" ]; then
    echo "The directory $config_dir already exists. If you want to reconfigure, remove (and secure its contents) before running again."
    exit
fi
mkdir "$config_dir"

read -re -p "Path to root data directory (prepared with dictionaries.sh script): " -i "/home/snakepit/data" data_root

read -re -p "Address of the snakepit service that clients should use to connect (without protocol/port): " -i `hostname` snakepit_fqdn
read -re -p "Local interface the snakepit service should use (e.g. 192.168.1.1): " snakepit_interface
read -re -p "Local port of the snakepit service: " -i "7443" snakepit_port

echo "https://$snakepit_fqdn:$snakepit_port" >"$config_dir/.pitconnect.txt"

read -re -p "Path to certificate PEM-file (keep empty to generate a self-signed certificate): " cert_pem
if [ -z "$cert_pem" ]; then
    read -re -p "Country code of the service: " -i "US" country
    read -re -p "State within country: " -i "California" state
    read -re -p "City or area within state: " -i "San Francisco" location
    read -re -p "Organization: " organization
    read -re -p "Department within organization: " unit
    cert_pem="$config_dir/cert.pem"
    key_pem="$config_dir/key.pem"
    subject="/C=$country/ST=$state/L=$location/O=$organization/OU=$unit/CN=$snakepit_fqdn"
    openssl req -x509 -newkey rsa:4096 -keyout "$key_pem" -out "$cert_pem" -days 3650 -nodes -subj "$subject"
    chmod 700 "$key_pem"
    cat "$cert_pem" >>"$config_dir/.pitconnect.txt"
else
    read -re -p "Path to key PEM-file: " key_pem
fi

token_secret_path="$config_dir/token-secret.txt"
openssl rand -base64 32 >"$token_secret_path"
chmod 700 "$token_secret_path"

conf="$config_dir/snakepit.conf"
cp "./bin/snakepit.conf.template" "$conf"
echo -e "# Fully qualified domain name of the snakepit service.\nfqdn: $snakepit_fqdn\n" >>$conf
echo -e "# Local interface the snakepit service should use (e.g. 192.168.1.1).\ninterface: $snakepit_interface\n" >>$conf
echo -e "# Local port of the snakepit service.\nport: $snakepit_port\n" >>$conf
echo -e "# Path to data root.\ndataRoot: \"$data_root\"\n" >>$conf
echo -e "# Path to key PEM-file.\nkeyPemPath: \"$key_pem\"\n" >>$conf
echo -e "# Path to certificate PEM-file.\ncertPemPath: \"$cert_pem\"\n" >>$conf
echo -e "# Path to session token secret file.\ntokenSecretPath: \"$token_secret_path\"\n" >>$conf

echo ""
echo "Now you can distribute the file $config_dir/.pitconnect.txt to your users."


