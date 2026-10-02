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
  if (!env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN не задан. Скопируйте .env.example в .env и укажите токен от @BotFather.');
  }
  // Сайт mempool (для ссылок), REST API и WebSocket выводятся из одного базового URL
  const mempoolUrl = (env.MEMPOOL_URL ?? 'https://mempool.space').replace(/\/+$/, '');

  return {
    botToken: env.BOT_TOKEN,
    mempoolUrl,
    mempoolApi: env.MEMPOOL_API ?? `${mempoolUrl}/api`,
    mempoolWs: env.MEMPOOL_WS ?? `${mempoolUrl.replace(/^http/, 'ws')}/api/v1/ws`,
    // Курс ЦБ РФ в JSON (зеркало cbr.ru), нужен для пересчёта в рубли
    rubRateUrl: env.RUB_RATE_URL ?? 'https://www.cbr-xml-daily.ru/daily_json.js',
    // Yandex Vision OCR: распознавание координат на фото. Без ключа функция выключена
    yandexApiKey: env.YANDEX_API_KEY ?? '',
    yandexFolderId: env.YANDEX_FOLDER_ID ?? '',
    yandexOcrUrl: env.YANDEX_OCR_URL ?? 'https://ai.api.cloud.yandex.net/ocr/v1/recognizeText',
    // Ссылка на исходники в справке, настройках и описании бота
    sourceUrl: env.SOURCE_URL ?? 'https://github.com/stlr00/BTC-CHECKER-BOT',
    pollIntervalMs: int(env.POLL_INTERVAL_SEC, 60) * 1000,
    requestGapMs: int(env.REQUEST_GAP_MS, 250),
    dataFile: env.DATA_FILE ?? 'data/state.json',
    maxAddressesPerChat: int(env.MAX_ADDRESSES_PER_CHAT, 20),
    // Пусто = бот доступен всем
    allowedUserIds: new Set(list(env.ALLOWED_USER_IDS).map(Number)),
  };
});

export type AppConfig = ReturnType<typeof appConfig>;
