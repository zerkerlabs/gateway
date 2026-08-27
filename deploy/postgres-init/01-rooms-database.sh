#!/bin/sh
# Runs once, on an empty data directory, as part of the postgres image's
# first-boot initialisation. The gateway and Rooms are separate deployables with
# separate schemas and separate migration histories; they share a server here
# only because one demo box does not need two.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE DATABASE "${ROOMS_DB:-rooms}" OWNER "$POSTGRES_USER";
EOSQL
