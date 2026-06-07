#!/usr/bin/env bash
# run-wa-validation.sh
# Ejecuta la validación WA con las credenciales de Google desde mission-control.
# Uso:
#   ./scripts/run-wa-validation.sh                          # run completo (405 números ~12 min)
#   ./scripts/run-wa-validation.sh --dry-run                # sin escribir al sheet
#   ./scripts/run-wa-validation.sh --limit=10               # solo primeros N
#   ./scripts/run-wa-validation.sh --export-valid           # al final, copia válidos a nuevo sheet
#   ./scripts/run-wa-validation.sh --export-valid --limit=5 # combo: limita + exporta

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
MC_ENV="/root/claude/mission-control/.env"

if [ ! -f "$MC_ENV" ]; then
  echo "ERROR: No se encontró $MC_ENV"
  exit 1
fi

# Cargar solo las variables Google del .env de mission-control
GOOGLE_CLIENT_ID=$(grep '^GOOGLE_CLIENT_ID=' "$MC_ENV" | cut -d'=' -f2-)
GOOGLE_CLIENT_SECRET=$(grep '^GOOGLE_CLIENT_SECRET=' "$MC_ENV" | cut -d'=' -f2-)
GOOGLE_REFRESH_TOKEN=$(grep '^GOOGLE_REFRESH_TOKEN=' "$MC_ENV" | cut -d'=' -f2-)

export GOOGLE_CLIENT_ID
export GOOGLE_CLIENT_SECRET
export GOOGLE_REFRESH_TOKEN

cd "$PROJECT_DIR"
exec node scripts/validate-wa-numbers.mjs "$@"
