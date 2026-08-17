#!/bin/bash
# XMP API Personal Cost Fetcher (replaces Playwright-based fetch-personal-xmp.sh)
# Usage: bash scripts/fetch-personal-xmp-api.sh [date]
cd "$(dirname "$0")/.."
node scripts/fetch-personal-xmp-api.js "$@" 2>/dev/null
