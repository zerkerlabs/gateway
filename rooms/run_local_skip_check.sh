#!/bin/bash
# Runs just the ZMem httpapi integration test against a local backend.
# Unlike `make integration-test`, this needs no TEST_DATABASE_URL/Postgres —
# only the ZMEM_TEST_* variables from the README's local-backend section.
# `unset CI` keeps the test's skip (not fail) behavior when those are unset,
# matching a developer's laptop rather than the CI job.
unset CI
go test -tags=integration -race -count=1 ./internal/httpapi/... -run ZMemIntegration -v
