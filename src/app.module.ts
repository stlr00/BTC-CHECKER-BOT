import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { BotModule } from './bot/bot.module.js';
import { appConfig } from './config/app.config.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig], ignoreEnvFile: true }),
    EventEmitterModule.forRoot(),
    BotModule,
  ],
})
export class AppModule {}
