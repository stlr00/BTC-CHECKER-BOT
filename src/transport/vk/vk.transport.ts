import { Logger } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { APIError, VK, type MessageContext, type MessageEventContext } from 'vk-io';
import type { AppConfig } from '../../config/app.config.js';
import { ChatTransport } from '../chat-transport.js';
import {
  ChatUnavailableError,
  type ChatRef,
  type ImageMimeType,
  type IncomingEvent,
  type IncomingUpdate,
  type OutgoingMessage,
  type ReplyContext,
  type TransportSetup,
} from '../transport.types.js';
import { renderInlineKeyboard, renderMenu, renderPlain, VK_LIMITS } from './vk.render.js';

const API_VERSION = '5.199';
// 7 — нет прав, 900 — в чёрном списке, 901 — не разрешил сообщения сообщества, 902 — настройки приватности
const CHAT_UNAVAILABLE_CODES = new Set([7, 900, 901, 902]);
// peer_id бесед начинаются с 2e9, всё, что меньше, — личная переписка
const CHAT_PEER_OFFSET = 2_000_000_000;
// В беседах обращение к боту приходит в виде «[club123|@bot] текст»
const MENTION = /^\[club\d+\|[^\]]*\]\s*,?\s*/;

const IMAGE_EXTENSIONS: Record<string, ImageMimeType | null> = {
  jpg: 'JPEG',
  jpeg: 'JPEG',
  png: 'PNG',
  gif: null,
  webp: null,
  heic: null,
  bmp: null,
  tiff: null,
};

/** VK: бот сообщества через Bots Long Poll API (события message_new и message_event). */
export class VkTransport extends ChatTransport {
  readonly kind = 'vk' as const;
  readonly limits = VK_LIMITS;

  private readonly logger = new Logger(VkTransport.name);
  private readonly vk: VK;
  private menu = renderMenu([]);
  private groupId: number;

  constructor(config: AppConfig) {
    super();
    this.groupId = config.vkGroupId;
    this.vk = new VK({ token: config.vkToken, pollingGroupId: config.vkGroupId || undefined, apiVersion: API_VERSION });
    this.register();
  }

  async start(setup: TransportSetup): Promise<void> {
    this.menu = renderMenu(setup.menu);
    // Ключ сообщества знает своё сообщество: ID можно не задавать, а заодно узнаём название для лога
    const {
      groups: [group],
    } = await this.vk.api.groups.getById(this.groupId ? { group_id: this.groupId } : {});
    this.groupId = group.id;
    await this.vk.updates.start();
    this.logger.log(`Бот VK «${group.name}» (club${group.id}) запущен`);
  }

  async stop(): Promise<void> {
    await this.vk.updates.stop();
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    try {
      await this.sendTo(Number(chatId), message);
    } catch (err) {
      if (err instanceof APIError && CHAT_UNAVAILABLE_CODES.has(Number(err.code))) {
        throw new ChatUnavailableError(`vk:${chatId}`, err);
      }
      throw err;
    }
  }

  private async sendTo(peerId: number, message: OutgoingMessage): Promise<void> {
    const keyboard = message.menu ? this.menu : renderInlineKeyboard(message.buttons);
    await this.vk.api.messages.send({
      peer_id: peerId,
      random_id: randomInt(1, 2 ** 31),
      message: renderPlain(message.text),
      dont_parse_links: 1,
      ...(keyboard ? { keyboard } : {}),
    });
  }

  // ─── Входящие события → IncomingUpdate ────────────────────────────────────

  private register(): void {
    this.vk.updates.on('message_new', (ctx) => this.onMessage(ctx));
    this.vk.updates.on('message_event', (ctx) => this.onEvent(ctx));
  }

  private async onMessage(ctx: MessageContext): Promise<void> {
    if (ctx.isOutbox || !ctx.isFromUser) return;
    const reply = this.replyContext(ctx.peerId);

    const photo = ctx.getAttachments('photo').at(0);
    if (photo?.largeSizeUrl) {
      const href = photo.largeSizeUrl;
      return this.dispatch(ctx.peerId, ctx.senderId, { kind: 'image', mimeType: 'JPEG', download: () => download(href) }, reply);
    }

    const doc = ctx.getAttachments('doc').find((d) => (d.extension ?? '').toLowerCase() in IMAGE_EXTENSIONS);
    if (doc) {
      const href = doc.url;
      const mimeType = IMAGE_EXTENSIONS[(doc.extension ?? '').toLowerCase()] ?? null;
      return this.dispatch(
        ctx.peerId,
        ctx.senderId,
        { kind: 'image', mimeType, size: doc.size, download: () => (href ? download(href) : Promise.reject(new Error('VK не дал ссылку на файл'))) },
        reply,
      );
    }

    const text = (ctx.text ?? '').replace(MENTION, '').trim();
    if (text) await this.dispatch(ctx.peerId, ctx.senderId, { kind: 'text', text }, reply);
  }

  private async onEvent(ctx: MessageEventContext): Promise<void> {
    const data = (ctx.eventPayload as { d?: unknown } | undefined)?.d;
    const reply = this.replyContext(ctx.peerId, ctx);
    if (typeof data !== 'string') {
      await reply.answerAction();
      return;
    }
    await this.dispatch(ctx.peerId, ctx.userId, { kind: 'action', data }, reply);
  }

  private async dispatch(peerId: number, userId: number, event: IncomingEvent, reply: ReplyContext): Promise<void> {
    if (!this.handler) return;
    const chat: ChatRef = { transport: 'vk', id: String(peerId), isPrivate: peerId < CHAT_PEER_OFFSET };
    try {
      await this.handler({ ...event, chat, userId: String(userId) } as IncomingUpdate, reply);
    } catch (err) {
      this.logger.error(`Ошибка обработки события VK ${peerId}: ${(err as Error).message}`);
    }
  }

  private replyContext(peerId: number, event?: MessageEventContext): ReplyContext {
    const api = this.vk.api;
    return {
      reply: (message) => this.sendTo(peerId, message),
      edit: async (message) => {
        if (!event?.conversationMessageId) return this.sendTo(peerId, message);
        try {
          await api.messages.edit({
            peer_id: peerId,
            conversation_message_id: event.conversationMessageId,
            message: renderPlain(message.text),
            dont_parse_links: 1,
            keyboard: renderInlineKeyboard(message.buttons) ?? '{"buttons":[],"inline":true}',
          });
        } catch (err) {
          // Старые сообщения VK редактировать не даёт — тогда просто отправляем новое
          this.logger.warn(`Не удалось отредактировать сообщение VK: ${(err as Error).message}`);
          await this.sendTo(peerId, message);
        }
      },
      typing: async () => {
        await api.messages
          .setActivity({ peer_id: peerId, type: 'typing', group_id: this.groupId })
          .catch(() => undefined);
      },
      answerAction: async (text) => {
        if (!event) return;
        // Без ответа у кнопки крутится индикатор загрузки, поэтому отвечаем всегда
        await api.messages.sendMessageEventAnswer({
          event_id: event.eventId,
          user_id: event.userId,
          peer_id: peerId,
          ...(text ? { event_data: JSON.stringify({ type: 'show_snackbar', text: text.slice(0, 90) }) } : {}),
        });
      },
      sendLocation: async (lat, lon) => {
        await api.messages.send({ peer_id: peerId, random_id: randomInt(1, 2 ** 31), lat, long: lon });
      },
    };
  }
}

async function download(href: string): Promise<Buffer> {
  const res = await fetch(href, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Не удалось скачать файл из VK: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
