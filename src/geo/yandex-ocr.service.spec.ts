import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app.config.js';
import { OcrError, YandexOcrService } from './yandex-ocr.service.js';

const config = {
  yandexApiKey: 'test-key',
  yandexFolderId: 'b1gfolder',
  yandexOcrUrl: 'https://ocr.example/recognizeText',
} as AppConfig;

describe('YandexOcrService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('отправляет картинку в base64 и возвращает распознанный текст', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ result: { textAnnotation: { fullText: 'Широта: 54.155977' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const text = await new YandexOcrService(config).recognize(Buffer.from('img'), 'JPEG');

    expect(text).toBe('Широта: 54.155977');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.yandexOcrUrl);
    expect(init.headers).toMatchObject({ Authorization: 'Api-Key test-key', 'x-folder-id': 'b1gfolder' });
    expect(JSON.parse(init.body as string)).toEqual({
      mimeType: 'JPEG',
      languageCodes: ['ru', 'en'],
      model: 'page',
      content: Buffer.from('img').toString('base64'),
    });
  });

  it('бросает OcrError с кодом ответа при ошибке API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })));
    await expect(new YandexOcrService(config).recognize(Buffer.from('img'), 'PNG')).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<OcrError>);
  });

  it('выключен без ключа или каталога', () => {
    expect(new YandexOcrService({ ...config, yandexApiKey: '' }).enabled).toBe(false);
    expect(new YandexOcrService(config).enabled).toBe(true);
  });
});
