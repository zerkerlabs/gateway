#!/bin/bash
unset CI
go test -tags=integration -race -count=1 ./internal/httpapi/... -run ZMemIntegration -v
