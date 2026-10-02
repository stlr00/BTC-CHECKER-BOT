import { Module } from '@nestjs/common';
import { YandexOcrService } from './yandex-ocr.service.js';

@Module({
  providers: [YandexOcrService],
  exports: [YandexOcrService],
})
export class GeoModule {}
