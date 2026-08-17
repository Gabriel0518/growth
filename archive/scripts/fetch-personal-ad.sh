#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/fetch-personal-ad.js
