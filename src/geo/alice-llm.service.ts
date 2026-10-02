import { Inject, Injectable, Logger } from '@nestjs/common';
import { appConfig, type AppConfig } from '../config/app.config.js';
import type { Coordinates } from './coordinates.js';

const MAX_INPUT_CHARS = 4000;

export const SYSTEM_PROMPT = [
  'Ты извлекаешь GPS-координаты из текста, распознанного OCR с фотографии или скриншота.',
  'В тексте бывают ошибки распознавания: пропущенная или лишняя точка, пробел или запятая вместо',
  'десятичного разделителя, похожие символы (O и 0, l и I и 1, З и 3, S и 5, B и 8), лишний мусор вокруг.',
  'Координаты могут быть подписаны (Широта/Долгота, Lat/Lon), записаны парой чисел или в градусах,',
  'минутах и секундах. Переведи их в десятичные градусы; южная широта и западная долгота — со знаком минус.',
  'Не округляй: сохрани все цифры дробной части из текста, а градусы-минуты-секунды переводи с точностью 6 знаков.',
  'Не придумывай координаты: если в тексте их нет или они неоднозначны, верни null.',
  'Ответь ТОЛЬКО JSON без пояснений и без markdown: {"lat": число, "lon": число} или {"lat": null, "lon": null}.',
].join(' ');

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

/**
 * Подстраховка парсера: Alice AI LLM (Yandex AI Studio, OpenAI-совместимый API) достаёт координаты
 * из текста OCR, если регулярные выражения не справились. Любая ошибка → null, бот просто скажет,
 * что координат не нашёл.
 */
@Injectable()
export class AliceLlmService {
  private readonly logger = new Logger(AliceLlmService.name);

  constructor(@Inject(appConfig.KEY) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.yandexApiKey && this.config.yandexFolderId);
  }

  private get modelUri(): string {
    const model = this.config.yandexLlmModel;
    return model.startsWith('gpt://') ? model : `gpt://${this.config.yandexFolderId}/${model}`;
  }

  async extractCoordinates(ocrText: string): Promise<Coordinates | null> {
    if (!this.enabled || !ocrText.trim()) return null;
    try {
      const res = await fetch(this.config.yandexLlmUrl, {
        method: 'POST',
        headers: {
          Authorization: `Api-Key ${this.config.yandexApiKey}`,
          'OpenAI-Project': this.config.yandexFolderId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelUri,
          temperature: 0,
          max_tokens: 100,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: ocrText.slice(0, MAX_INPUT_CHARS) },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`Alice AI LLM ${res.status}: ${body.slice(0, 300)}`);
        return null;
      }
      const data = (await res.json()) as ChatCompletionResponse;
      const answer = data.choices?.[0]?.message?.content ?? '';
      const coords = parseLlmAnswer(answer, ocrText);
      if (!coords) this.logger.warn(`Alice AI LLM не дала координат: ${answer.slice(0, 200)}`);
      return coords;
    } catch (err) {
      this.logger.warn(`Alice AI LLM недоступна: ${(err as Error).message}`);
      return null;
    }
  }
}

/**
 * Разбор ответа модели с защитой от выдуманных значений: координаты должны быть в допустимых
 * диапазонах, а их целые градусы — встречаться в исходном тексте OCR.
 */
export function parseLlmAnswer(answer: string, ocrText: string): Coordinates | null {
  const json = answer.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  let parsed: { lat?: unknown; lon?: unknown };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const lat = Number(parsed.lat);
  const lon = Number(parsed.lon);
  if (parsed.lat === null || parsed.lon === null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;

  const numbersInText = new Set(ocrText.match(/\d+/g) ?? []);
  const degreesPresent = (value: number) => {
    const degrees = String(Math.trunc(Math.abs(value)));
    // «54 155977» и «54155977» — градусы могут быть и отдельным числом, и началом слипшегося
    return numbersInText.has(degrees) || [...numbersInText].some((n) => n.length > 4 && n.startsWith(degrees));
  };
  return degreesPresent(lat) && degreesPresent(lon) ? { lat, lon } : null;
}
