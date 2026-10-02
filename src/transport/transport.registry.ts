import { Inject, Injectable } from '@nestjs/common';
import type { ChatTransport } from './chat-transport.js';
import { parseChatKey, type OutgoingMessage, type TransportKind } from './transport.types.js';

export const CHAT_TRANSPORTS = Symbol('CHAT_TRANSPORTS');

/** Все включённые транспорты; маршрутизирует сообщения по ключу чата. */
@Injectable()
export class TransportRegistry {
  constructor(@Inject(CHAT_TRANSPORTS) readonly transports: ChatTransport[]) {}

  get(kind: TransportKind): ChatTransport | undefined {
    return this.transports.find((t) => t.kind === kind);
  }

  /** Отправка по ключу чата `tg:…` / `vk:…`. Если транспорт выключен — сообщение пропускается. */
  async send(chat: string, message: OutgoingMessage): Promise<boolean> {
    const parsed = parseChatKey(chat);
    const transport = parsed && this.get(parsed.transport);
    if (!parsed || !transport) return false;
    await transport.send(parsed.id, message);
    return true;
  }
}
