import { registerAs } from '@nestjs/config';

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const appConfig = registerAs('app', () => {
  const env = process.env;
  const vkGroupId = int(env.VK_GROUP_ID, 0);
  if (!env.BOT_TOKEN && !env.VK_TOKEN) {
    throw new Error(
      'Не задан ни один мессенджер: укажите BOT_TOKEN (Telegram, от @BotFather) и/или VK_TOKEN (ключ сообщества VK). ' +
        'Пример — в .env.example.',
    );
  }
  // Сайт mempool (для ссылок), REST API и WebSocket выводятся из одного базового URL
  const mempoolUrl = (env.MEMPOOL_URL ?? 'https://mempool.space').replace(/\/+$/, '');

  return {
    // Telegram: пусто — транспорт выключен
    botToken: env.BOT_TOKEN ?? '',
    // VK: ключ доступа сообщества с правом «сообщения сообщества»; пусто — транспорт выключен
    vkToken: env.VK_TOKEN ?? '',
    // ID сообщества VK; 0 — определить по ключу сообщества при старте
    vkGroupId,
    mempoolUrl,
    mempoolApi: env.MEMPOOL_API ?? `${mempoolUrl}/api`,
    mempoolWs: env.MEMPOOL_WS ?? `${mempoolUrl.replace(/^http/, 'ws')}/api/v1/ws`,
    // Курс ЦБ РФ в JSON (зеркало cbr.ru), нужен для пересчёта в рубли
    rubRateUrl: env.RUB_RATE_URL ?? 'https://www.cbr-xml-daily.ru/daily_json.js',
    // Yandex Vision OCR: распознавание координат на фото. Без ключа функция выключена
    yandexApiKey: env.YANDEX_API_KEY ?? '',
    yandexFolderId: env.YANDEX_FOLDER_ID ?? '',
    yandexOcrUrl: env.YANDEX_OCR_URL ?? 'https://ai.api.cloud.yandex.net/ocr/v1/recognizeText',
    // Alice AI LLM — подстраховка, когда парсер не нашёл координат в тексте OCR
    yandexLlmUrl: env.YANDEX_LLM_URL ?? 'https://llm.api.cloud.yandex.net/v1/chat/completions',
    yandexLlmModel: env.YANDEX_LLM_MODEL ?? 'aliceai-llm',
    // Ссылка на исходники в справке, настройках и описании бота
    sourceUrl: env.SOURCE_URL ?? 'https://github.com/stlr00/BTC-CHECKER-BOT',
    pollIntervalMs: int(env.POLL_INTERVAL_SEC, 60) * 1000,
    requestGapMs: int(env.REQUEST_GAP_MS, 250),
    dataFile: env.DATA_FILE ?? 'data/state.json',
    maxAddressesPerChat: int(env.MAX_ADDRESSES_PER_CHAT, 20),
    // ID пользователей Telegram / VK через запятую; пусто = бот на этой платформе доступен всем
    allowedUserIds: new Set(list(env.ALLOWED_USER_IDS)),
    allowedVkUserIds: new Set(list(env.ALLOWED_VK_USER_IDS)),
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
