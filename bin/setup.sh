#!/usr/bin/env bash

if [ -d "./config" ]; then
    echo "The directory ./config already exists. If you want to reconfigure, remove (and secure its contents) before running again."
    exit
fi
mkdir "./config"

read -e -p "Address of the snakepit service that clients should use to connect (without protocol/port): " -i `hostname` SNAKEPIT_FQDN
read -e -p "Port of the snakepit service: " -i "7443" SNAKEPIT_PORT

read -e -p "Country code of the service: " -i "US" COUNTRY
read -e -p "State within country: " -i "California" STATE
read -e -p "City or area within state: " -i "San Francisco" LOCATION
read -e -p "Organization: " ORGANIZATION
read -e -p "Department within organization: " UNIT

SUBJ="/C=$COUNTRY/ST=$STATE/L=$LOCATION/O=$ORGANIZATION/OU=$UNIT/CN=$SNAKEPIT_FQDN"
openssl req -x509 -newkey rsa:4096 -keyout ./config/key.pem -out ./config/cert.pem -days 3650 -nodes -subj "$SUBJ"

openssl rand -base64 32 >./config/token-secret.txt

echo "{ \"tokenTTL\": \"1d\", \"hashRounds\": 10, \"fqdn\": \"$SNAKEPIT_FQDN\", \"port\": $SNAKEPIT_PORT }" >./config/snakepit.config

echo "https://$SNAKEPIT_FQDN:$SNAKEPIT_PORT" >./config/.pitconnect.txt
cat ./config/cert.pem >>./config/.pitconnect.txt

echo ""
echo "Now you can distribute the file ./config/.pitconnect.txt to your users."


