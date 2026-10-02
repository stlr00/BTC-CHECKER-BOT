import { Injectable, Logger } from '@nestjs/common';
import { AliceLlmService } from './alice-llm.service.js';
import { parseCoordinates, type Coordinates } from './coordinates.js';

export interface LocatedCoordinates {
  coords: Coordinates;
  /** parser — нашли регулярными выражениями, llm — помогла Alice AI */
  source: 'parser' | 'llm';
}

/** Поиск координат в тексте OCR: сначала бесплатный парсер, затем Alice AI LLM. */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  constructor(private readonly llm: AliceLlmService) {}

  async locateInText(text: string): Promise<LocatedCoordinates | null> {
    const parsed = parseCoordinates(text);
    if (parsed) return { coords: parsed, source: 'parser' };

    const fromLlm = await this.llm.extractCoordinates(text);
    if (fromLlm) return { coords: fromLlm, source: 'llm' };

    // Сохраняем в журнал, чтобы по реальным примерам дорабатывать парсер
    if (text.trim()) this.logger.warn(`Координаты не найдены в тексте OCR: ${JSON.stringify(text.slice(0, 500))}`);
    return null;
  }
}
