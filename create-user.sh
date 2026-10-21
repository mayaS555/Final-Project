#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"

NAME="$1"
EMAIL="$2"
PASSWORD="$3"
ROLE="$4"

# Interactive prompt if parameters are missing
if [ -z "$NAME" ]; then
    read -rp "Enter Name: " NAME
fi

if [ -z "$EMAIL" ]; then
    read -rp "Enter Email: " EMAIL
fi

if [ -z "$PASSWORD" ]; then
    read -rsp "Enter Password: " PASSWORD
    echo ""
fi

if [ -z "$ROLE" ]; then
    read -rp "Enter Role (reporter/editor/admin) [default: reporter]: " ROLE
    ROLE="${ROLE:-reporter}"
fi

node "$DIR/scripts/create-user.js" "$NAME" "$EMAIL" "$PASSWORD" "$ROLE"
