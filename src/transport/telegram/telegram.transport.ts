import { Logger } from '@nestjs/common';
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, Context, GrammyError } from 'grammy';
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
  type TransportLimits,
  type TransportSetup,
} from '../transport.types.js';
import { renderHtml, renderInlineKeyboard, renderMenu } from './telegram.render.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;
// Bot API принимает точность геопозиции до 1500 м
const MAX_LOCATION_ACCURACY_M = 1500;

/** Telegram Bot API через grammy, long polling. */
export class TelegramTransport extends ChatTransport {
  readonly kind = 'tg' as const;
  readonly limits: TransportLimits = { maxButtonRows: 100, maxButtonsPerRow: 8, maxLabelLength: 64 };

  private readonly logger = new Logger(TelegramTransport.name);
  private readonly bot: Bot;
  private menu = renderMenu([]);

  constructor(private readonly config: AppConfig) {
    super();
    this.bot = new Bot(config.botToken);
    this.bot.api.config.use(autoRetry());
    this.register();
  }

  async start(setup: TransportSetup): Promise<void> {
    this.menu = renderMenu(setup.menu);
    await this.bot.api.setMyCommands([...setup.commands]);
    await this.ensureDescriptions();
    this.bot
      .start({ onStart: (me) => this.logger.log(`Бот @${me.username} запущен`) })
      .catch((err: Error) => this.logger.error(`Long polling остановлен: ${err.message}`));
  }

  async stop(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop();
  }

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    try {
      await this.bot.api.sendMessage(chatId, renderHtml(message.text), this.markup(message));
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 403) throw new ChatUnavailableError(`tg:${chatId}`, err);
      throw err;
    }
  }

  private markup(message: OutgoingMessage) {
    // В Telegram у сообщения одна клавиатура: либо главное меню, либо кнопки под сообщением
    const reply_markup = message.menu ? this.menu : renderInlineKeyboard(message.buttons);
    return { ...HTML, ...(reply_markup ? { reply_markup } : {}) };
  }

  /**
   * Описание (видно в пустом чате до /start) и «About» профиля со ссылкой на исходники.
   * Заполняются, только если пустые, чтобы не затирать текст, заданный в @BotFather.
   */
  private async ensureDescriptions(): Promise<void> {
    const api = this.bot.api;
    try {
      const [{ description }, { short_description }] = await Promise.all([
        api.getMyDescription(),
        api.getMyShortDescription(),
      ]);
      if (!description) {
        await api.setMyDescription(
          [
            'Следит за биткоин-адресами через mempool.space: присылает уведомления о новых транзакциях ' +
              'и их первом подтверждении, показывает баланс в BTC / USD / RUB и время с последнего блока.',
            '',
            `Исходный код: ${this.config.sourceUrl}`,
          ].join('\n'),
        );
      }
      if (!short_description) {
        await api.setMyShortDescription(
          `Уведомления о транзакциях на BTC-адресах. Код: ${this.config.sourceUrl.replace(/^https?:\/\//, '')}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Не удалось обновить описание бота: ${(err as Error).message}`);
    }
  }

  // ─── Входящие события → IncomingUpdate ────────────────────────────────────

  private register(): void {
    const bot = this.bot;
    bot.on('message:text', (ctx) => this.dispatch(ctx, { kind: 'text', text: ctx.message.text }));
    bot.on('callback_query:data', (ctx) => this.dispatch(ctx, { kind: 'action', data: ctx.callbackQuery.data }));
    bot.on('message:photo', (ctx) =>
      this.dispatch(ctx, { kind: 'image', mimeType: 'JPEG', size: ctx.message.photo.at(-1)?.file_size, download: () => this.download(ctx) }),
    );
    bot.on('message:document', async (ctx) => {
      // Картинка, отправленная «файлом», приходит без сжатия — для OCR это даже лучше
      const { mime_type, file_size } = ctx.message.document;
      if (!mime_type?.startsWith('image/')) return;
      const mimeType: ImageMimeType | null = mime_type === 'image/jpeg' ? 'JPEG' : mime_type === 'image/png' ? 'PNG' : null;
      await this.dispatch(ctx, { kind: 'image', mimeType, size: file_size, download: () => this.download(ctx) });
    });
    bot.catch(({ error, ctx }) => {
      this.logger.error(`Ошибка обработки update ${ctx.update.update_id}: ${(error as Error).message}`);
    });
  }

  private async dispatch(ctx: Context, event: IncomingEvent): Promise<void> {
    if (!this.handler || !ctx.chat || !ctx.from) return;
    const chat: ChatRef = { transport: 'tg', id: String(ctx.chat.id), isPrivate: ctx.chat.type === 'private' };
    await this.handler({ ...event, chat, userId: String(ctx.from.id) } as IncomingUpdate, this.replyContext(ctx));
  }

  private async download(ctx: Context): Promise<Buffer> {
    const file = await ctx.getFile();
    const res = await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Не удалось скачать файл из Telegram: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  private replyContext(ctx: Context): ReplyContext {
    return {
      reply: async (message) => {
        await ctx.reply(renderHtml(message.text), this.markup(message));
      },
      edit: async (message) => {
        if (!ctx.callbackQuery?.message) {
          await ctx.reply(renderHtml(message.text), this.markup(message));
          return;
        }
        try {
          await ctx.editMessageText(renderHtml(message.text), {
            ...HTML,
            reply_markup: renderInlineKeyboard(message.buttons),
          });
        } catch (err) {
          // Данные не изменились с прошлого раза — это не ошибка
          if (!(err instanceof GrammyError && err.description.includes('message is not modified'))) throw err;
        }
      },
      typing: async () => {
        await ctx.replyWithChatAction('typing');
      },
      answerAction: async (text, alert) => {
        if (ctx.callbackQuery) await ctx.answerCallbackQuery(text ? { text, show_alert: alert } : undefined);
      },
      sendLocation: async (lat, lon, accuracyM) => {
        const accuracy = accuracyM && accuracyM <= MAX_LOCATION_ACCURACY_M ? accuracyM : undefined;
        await ctx.replyWithLocation(lat, lon, accuracy ? { horizontal_accuracy: accuracy } : {});
      },
    };
  }
}
