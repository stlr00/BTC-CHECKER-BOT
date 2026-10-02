import { Module } from '@nestjs/common';
import { AliceLlmService } from './alice-llm.service.js';
import { GeoService } from './geo.service.js';
import { YandexOcrService } from './yandex-ocr.service.js';

@Module({
  providers: [AliceLlmService, GeoService, YandexOcrService],
  exports: [GeoService, YandexOcrService],
})
export class GeoModule {}
