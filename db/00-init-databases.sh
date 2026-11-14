#!/bin/sh
# Runs once, on the very first start of the Postgres container (empty volume).
# Creates two separate databases, each with its own login:
#   n8n       -> n8n's internal tables (owned by N8N_DB_USER)
#   claimflow -> our application tables (owned by CLAIMFLOW_DB_USER)
# Keeping them apart means app migrations can never touch n8n's tables, and vice versa.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v n8n_user="$N8N_DB_USER" -v n8n_pw="$N8N_DB_PASSWORD" \
  -v app_user="$CLAIMFLOW_DB_USER" -v app_pw="$CLAIMFLOW_DB_PASSWORD" <<'SQL'
CREATE ROLE :"n8n_user" LOGIN PASSWORD :'n8n_pw';
CREATE DATABASE n8n OWNER :"n8n_user";
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_pw';
CREATE DATABASE claimflow OWNER :"app_user";
SQL

# Load app schema + seed data into the claimflow DB (added in stage 2).
for f in /claimflow-sql/schema.sql /claimflow-sql/seed.sql; do
  if [ -f "$f" ]; then
    echo "Loading $f"
    psql -v ON_ERROR_STOP=1 --username "$CLAIMFLOW_DB_USER" --dbname claimflow -f "$f"
  fi
done
