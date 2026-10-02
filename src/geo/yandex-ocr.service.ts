import { Inject, Injectable } from '@nestjs/common';
import { appConfig, type AppConfig } from '../config/app.config.js';

export class OcrError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type OcrMimeType = 'JPEG' | 'PNG';

interface RecognizeResponse {
  result?: { textAnnotation?: { fullText?: string } };
  textAnnotation?: { fullText?: string };
}

/**
 * Распознавание текста через Yandex Vision OCR.
 * https://aistudio.yandex.ru/docs/ru/vision/ocr/api-ref/TextRecognition/recognize
 */
@Injectable()
export class YandexOcrService {
  constructor(@Inject(appConfig.KEY) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return Boolean(this.config.yandexApiKey && this.config.yandexFolderId);
  }

  async recognize(image: Buffer, mimeType: OcrMimeType): Promise<string> {
    const res = await fetch(this.config.yandexOcrUrl, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${this.config.yandexApiKey}`,
        'x-folder-id': this.config.yandexFolderId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mimeType,
        languageCodes: ['ru', 'en'],
        model: 'page',
        content: image.toString('base64'),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new OcrError(res.status, `Vision OCR ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as RecognizeResponse;
    // REST-ответ оборачивает результат в result, gRPC-шлюз — нет
    return (data.result?.textAnnotation ?? data.textAnnotation)?.fullText ?? '';
  }
}
