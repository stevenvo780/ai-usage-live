#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Uso:
  ./ai-usage.sh [daily|weekly|monthly|session|blocks]
  ./ai-usage.sh [claude|codex|gemini] [daily|weekly|monthly|session|blocks]

Ejemplos:
  ./ai-usage-live
  ./ai-usage.sh daily
  ./ai-usage.sh monthly
  ./ai-usage.sh claude blocks
  ./ai-usage.sh codex session
  ./ai-usage.sh gemini daily

Filtros opcionales:
  SINCE=2026-06-01 ./ai-usage.sh daily
  UNTIL=2026-06-16 ./ai-usage.sh daily
  JSON=1 ./ai-usage.sh daily
  NO_COST=1 ./ai-usage.sh daily
  ai-usage-quota edit

Notas:
  - Lee datos locales de Claude Code, Codex CLI y Gemini CLI con ccusage.
  - ai-usage-live ademas lee cuota restante con Claude /usage y Gemini /stats model.
  - Los costos son estimaciones locales, no facturacion oficial.
  - Las cuotas reales de plan/API pueden requerir mirar el panel oficial de cada proveedor.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

source_or_view="${1:-daily}"
view="${2:-}"

case "$source_or_view" in
  claude|codex|gemini)
    source_args=("$source_or_view")
    view="${view:-daily}"
    ;;
  daily|weekly|monthly|session|blocks)
    source_args=()
    view="$source_or_view"
    ;;
  *)
    echo "Opcion no reconocida: $source_or_view" >&2
    usage >&2
    exit 2
    ;;
esac

if [[ "${source_args[0]:-}" == "codex" || "${source_args[0]:-}" == "gemini" ]]; then
  if [[ "$view" == "weekly" || "$view" == "blocks" ]]; then
    echo "$source_or_view no soporta '$view' en ccusage. Usa daily, monthly o session." >&2
    exit 2
  fi
fi

args=()
[[ -n "${SINCE:-}" ]] && args+=(--since "$SINCE")
[[ -n "${UNTIL:-}" ]] && args+=(--until "$UNTIL")
[[ -n "${TIMEZONE:-}" ]] && args+=(--timezone "$TIMEZONE")
[[ "${JSON:-0}" == "1" ]] && args+=(--json)
[[ "${NO_COST:-0}" == "1" ]] && args+=(--no-cost)

if command -v ccusage >/dev/null 2>&1; then
  ccusage "${source_args[@]}" "$view" "${args[@]}"
else
  npx -y ccusage@latest "${source_args[@]}" "$view" "${args[@]}"
fi
