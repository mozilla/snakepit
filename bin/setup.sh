#!/usr/bin/env bash

if [ -d "./connect" ]; then
    echo "The directory ./connect already exists. If you want to reconfigure connectivity, remove (and secure its contents) before running again."
    exit
fi
mkdir "./connect"

read -e -p "Address of the snakepit service that clients should use to connect (without protocol/port): " -i `hostname` SNAKEPIT_FQDN
read -e -p "Port of the snakepit service: " -i "7443" SNAKEPIT_PORT

read -e -p "Country code of the service: " -i "US" COUNTRY
read -e -p "State within country: " -i "California" STATE
read -e -p "City or area within state: " -i "San Francisco" LOCATION
read -e -p "Organization: " ORGANIZATION
read -e -p "Department within organization: " UNIT

SUBJ="/C=$COUNTRY/ST=$STATE/L=$LOCATION/O=$ORGANIZATION/OU=$UNIT/CN=$SNAKEPIT_FQDN"
openssl req -x509 -newkey rsa:4096 -keyout ./connect/key.pem -out ./connect/cert.pem -days 3650 -nodes -subj "$SUBJ"

echo "https://$SNAKEPIT_FQDN:$SNAKEPIT_PORT" >./connect/.pitconnect.txt
cat ./connect/cert.pem >>./connect/.pitconnect.txt

echo ""
echo "Now you can distribute the file ./connect/.pitconnect.txt to your users."


