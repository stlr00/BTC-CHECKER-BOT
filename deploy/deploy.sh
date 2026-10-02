#!/usr/bin/env bash
# Деплой бота на сервере. Запускается из GitHub Actions по SSH как forced command ключа деплоя:
# в stdin приходят секреты строками KEY=VALUE, затем код обновляется до origin/main,
# собирается, сервис перезапускается и проверяется, что бот поднялся.
#
# Всё тело в фигурных скобках: bash прочитает скрипт целиком до `git reset`,
# который может этот самый файл обновить.
{
set -euo pipefail

APP_DIR=/root/BTC-CHECKER-BOT
SERVICE=btc-checker-bot
ALLOWED_KEYS='BOT_TOKEN|VK_TOKEN|VK_GROUP_ID|YANDEX_API_KEY|YANDEX_FOLDER_ID'

exec 9>/run/lock/btc-checker-bot-deploy.lock
flock -w 300 9 || { echo "❌ Другой деплой всё ещё идёт" >&2; exit 1; }

cd "$APP_DIR"
export PATH="$APP_DIR/.runtime/node/bin:$PATH"

# 1. Секреты → .env. Обновляются только разрешённые непустые ключи, остальные строки остаются как были
updates=$(mktemp)
trap 'rm -f "$updates" "$APP_DIR/.env.tmp"' EXIT
if [ ! -t 0 ]; then
  tr -d '\r' | grep -E "^(${ALLOWED_KEYS})=.+$" > "$updates" || true
fi
if [ -s "$updates" ]; then
  touch .env
  keys=$(cut -d= -f1 "$updates" | paste -sd'|')
  { grep -vE "^(${keys})=" .env || true; cat "$updates"; } > .env.tmp
  chmod 600 .env.tmp
  mv .env.tmp .env
  echo "🔑 Обновлены переменные: $(cut -d= -f1 "$updates" | paste -sd' ')"
fi

# 2. Код и сборка. .env, data/ и .runtime/ git не трогает: они в .gitignore / .git/info/exclude
git fetch --quiet origin main
git reset --hard --quiet origin/main
echo "📦 Версия: $(git log -1 --format='%h %s')"
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent

# 3. Перезапуск и проверка, что бот действительно стартовал
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart "$SERVICE"
for _ in $(seq 1 30); do
  # «Бот @name запущен» (Telegram) или «Бот VK «…» (club…) запущен»
  if journalctl -u "$SERVICE" --since "$since" --no-pager -o cat | grep -q 'Бот .* запущен'; then
    echo "✅ Бот запущен"
    exit 0
  fi
  sleep 1
done

echo "❌ Бот не запустился за 30 с. Журнал:" >&2
journalctl -u "$SERVICE" --since "$since" --no-pager -o cat | tail -40 >&2
exit 1
}
