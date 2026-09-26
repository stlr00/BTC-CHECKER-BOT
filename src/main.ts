import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  // HTTP-сервер не нужен: бот работает через long polling
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

bootstrap().catch((err: Error) => {
  new Logger('Bootstrap').error(`Не удалось запустить бота: ${err.message}`);
  process.exit(1);
});
