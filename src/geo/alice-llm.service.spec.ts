import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app.config.js';
import { AliceLlmService, parseLlmAnswer, SYSTEM_PROMPT } from './alice-llm.service.js';

const config = {
  yandexApiKey: 'test-key',
  yandexFolderId: 'b1gfolder',
  yandexLlmUrl: 'https://llm.example/v1/chat/completions',
  yandexLlmModel: 'aliceai-llm',
} as AppConfig;

const reply = (content: string) => Response.json({ choices: [{ message: { content } }] });

describe('AliceLlmService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('отправляет текст OCR с промптом в OpenAI-совместимый API и разбирает ответ', async () => {
    const fetchMock = vi.fn(async () => reply('{"lat": 54.155977, "lon": 37.619617}'));
    vi.stubGlobal('fetch', fetchMock);

    const ocr = 'Шир0та 54155977 Д0лгота 37619617';
    expect(await new AliceLlmService(config).extractCoordinates(ocr)).toEqual({ lat: 54.155977, lon: 37.619617 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(config.yandexLlmUrl);
    expect(init.headers).toMatchObject({ Authorization: 'Api-Key test-key', 'OpenAI-Project': 'b1gfolder' });
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: 'gpt://b1gfolder/aliceai-llm', temperature: 0 });
    expect(body.messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: ocr },
    ]);
  });

  it('возвращает null при ошибке API, не бросая исключение', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Permission denied', { status: 403 })));
    expect(await new AliceLlmService(config).extractCoordinates('Широта 54 1')).toBeNull();

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNRESET'))));
    expect(await new AliceLlmService(config).extractCoordinates('Широта 54 1')).toBeNull();
  });

  it('не ходит в API без ключа и для пустого текста', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await new AliceLlmService({ ...config, yandexApiKey: '' }).extractCoordinates('текст')).toBeNull();
    expect(await new AliceLlmService(config).extractCoordinates('   ')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseLlmAnswer', () => {
  const ocr = 'Широта 54 155977 Долгота 37,619617';

  it('снимает markdown-обёртку', () => {
    expect(parseLlmAnswer('```json\n{"lat": 54.155977, "lon": 37.619617}\n```', ocr)).toEqual({
      lat: 54.155977,
      lon: 37.619617,
    });
  });

  it('принимает явный отказ модели', () => {
    expect(parseLlmAnswer('{"lat": null, "lon": null}', ocr)).toBeNull();
  });

  it('отбрасывает выдуманные координаты, которых нет в тексте', () => {
    expect(parseLlmAnswer('{"lat": 55.7558, "lon": 37.6173}', ocr)).toBeNull();
  });

  it('отбрасывает значения вне диапазона и мусор', () => {
    expect(parseLlmAnswer('{"lat": 154.1, "lon": 37.6}', '154 37')).toBeNull();
    expect(parseLlmAnswer('Координаты не найдены', ocr)).toBeNull();
    expect(parseLlmAnswer('{lat: 54}', ocr)).toBeNull();
  });

  it('узнаёт градусы в слипшемся числе', () => {
    expect(parseLlmAnswer('{"lat": 54.155977, "lon": 37.619617}', 'Ш 54155977 Д 37619617')).toEqual({
      lat: 54.155977,
      lon: 37.619617,
    });
  });
});
