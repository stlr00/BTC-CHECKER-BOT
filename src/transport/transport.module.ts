import { Logger, Module } from '@nestjs/common';
import { appConfig, type AppConfig } from '../config/app.config.js';
import type { ChatTransport } from './chat-transport.js';
import { TelegramTransport } from './telegram/telegram.transport.js';
import { CHAT_TRANSPORTS, TransportRegistry } from './transport.registry.js';
import { VkTransport } from './vk/vk.transport.js';

/** Создаёт транспорты тех мессенджеров, для которых задан токен. */
@Module({
  providers: [
    {
      provide: CHAT_TRANSPORTS,
      inject: [appConfig.KEY],
      useFactory: (config: AppConfig): ChatTransport[] => {
        const transports: ChatTransport[] = [];
        if (config.botToken) transports.push(new TelegramTransport(config));
        if (config.vkToken) transports.push(new VkTransport(config));
        new Logger('TransportModule').log(`Мессенджеры: ${transports.map((t) => t.kind).join(', ')}`);
        return transports;
      },
    },
    TransportRegistry,
  ],
  exports: [TransportRegistry],
})
export class TransportModule {}
