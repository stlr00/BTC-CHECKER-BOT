import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, Context, GrammyError, InlineKeyboard, Keyboard } from 'grammy';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { MempoolApiError } from '../mempool/mempool-api.service.js';
import { StorageService, type ChatSettings, type Currency, type TimeZone } from '../storage/storage.service.js';
import { WATCHER_TX_EVENT, type WatcherTxEvent } from '../watcher/watcher.events.js';
import { WatcherService } from '../watcher/watcher.service.js';
import { escapeHtml, shortAddress, TIME_ZONES, timeZoneName } from './format.js';
import { MessagesService } from './messages.service.js';
import { parseTarget, type Target } from './parse.js';
import { RefsService } from './refs.service.js';
import { formatCoordinates, parseCoordinates, yandexMapsUrl, type Coordinates } from '../geo/coordinates.js';
import { YandexOcrService, type OcrMimeType } from '../geo/yandex-ocr.service.js';

const BTN = {
  sub: '➕ Подписаться',
  list: '📋 Мои адреса',
  check: '🔍 Проверить',
  block: '⏱ Последний блок',
  settings: '⚙️ Настройки',
} as const;

// Старые надписи: у пользователей может остаться прежняя клавиатура до следующего /start
const LEGACY_BTN = {
  sub: '➕ Подписаться на адрес',
  check: ['🔍 Баланс / транзакция сейчас', '🔍 Проверить сейчас'],
  block: '⏱ Время с последнего блока',
} as const;

const CURRENCIES: Record<Currency, string> = { btc: '₿ BTC', usd: '$ USD', rub: '₽ RUB' };

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;
const MAX_LABEL = 40;
// Лимит Bot API на скачивание файлов — 20 МБ; для фото с текстом этого с запасом хватает
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type PendingAction = 'sub' | 'check';

@Injectable()
export class BotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BotService.name);
  private readonly bot: Bot;
  private readonly menu = new Keyboard()
    .text(BTN.sub)
    .text(BTN.list)
    .row()
    .text(BTN.check)
    .text(BTN.block)
    .row()
    .text(BTN.settings)
    // Без .persistent(): пользователь может свернуть клавиатуру кнопкой в поле ввода
    .resized();
  /** Ожидаемый ввод после нажатия кнопки; ключ — `${chatId}:${userId}` */
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    @Inject(appConfig.KEY) private readonly config: AppConfig,
    private readonly messages: MessagesService,
    private readonly watcher: WatcherService,
    private readonly storage: StorageService,
    private readonly refs: RefsService,
    private readonly ocr: YandexOcrService,
  ) {
    this.bot = new Bot(config.botToken);
    this.bot.api.config.use(autoRetry());
    this.register();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: 'start', description: 'Меню и справка' },
      { command: 'sub', description: 'Подписаться: /sub <адрес> [метка]' },
      { command: 'unsub', description: 'Отписаться: /unsub <адрес>' },
      { command: 'list', description: 'Мои адреса' },
      { command: 'check', description: 'Проверить: /check <адрес или txid>' },
      { command: 'block', description: 'Сколько прошло с последнего блока' },
      { command: 'settings', description: 'Валюта и часовой пояс' },
    ]);
    await this.ensureDescriptions();
    this.bot
      .start({ onStart: (me) => this.logger.log(`Бот @${me.username} запущен`) })
      .catch((err: Error) => this.logger.error(`Long polling остановлен: ${err.message}`));
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

  async onApplicationShutdown(): Promise<void> {
    if (this.bot.isRunning()) await this.bot.stop();
  }

  @OnEvent(WATCHER_TX_EVENT, { async: true })
  async onTx(event: WatcherTxEvent): Promise<void> {
    const keyboard = new InlineKeyboard().text('🔍 Баланс адреса', `chk:${this.refs.ref(event.address)}`);
    if (event.type !== 'removed') keyboard.text('🧾 Транзакция', `chk:${this.refs.ref(event.tx.txid)}`);

    for (const chatId of this.storage.chatsOf(event.address)) {
      try {
        const text = await this.messages.notification(event, chatId);
        await this.bot.api.sendMessage(chatId, text, { ...HTML, reply_markup: keyboard });
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 403) {
          this.logger.warn(`Чат ${chatId} заблокировал бота — удаляю его подписки`);
          this.watcher.unsubscribeChat(chatId);
        } else {
          this.logger.error(`Не удалось отправить уведомление в ${chatId}: ${(err as Error).message}`);
        }
      }
    }
  }

  private register(): void {
    const bot = this.bot;

    bot.use(async (ctx, next) => {
      const allowed = this.config.allowedUserIds;
      if (allowed.size && !allowed.has(ctx.from?.id ?? 0)) {
        if (ctx.chat?.type === 'private') await ctx.reply('⛔️ Нет доступа к этому боту.');
        return;
      }
      await next();
    });

    bot.command(['start', 'help'], (ctx) => this.help(ctx));
    bot.command('sub', (ctx) => (ctx.match ? this.subscribeFromText(ctx, ctx.match) : this.askFor(ctx, 'sub')));
    bot.command('unsub', (ctx) => (ctx.match ? this.unsubscribeFromText(ctx, ctx.match) : this.showList(ctx)));
    bot.command('list', (ctx) => this.showList(ctx));
    bot.command('check', (ctx) => (ctx.match ? this.checkFromText(ctx, ctx.match) : this.askFor(ctx, 'check')));
    bot.command('block', (ctx) => this.sendBlock(ctx));
    bot.command('settings', (ctx) => this.showSettings(ctx));

    bot.hears([BTN.sub, LEGACY_BTN.sub], (ctx) => this.askFor(ctx, 'sub'));
    bot.hears(BTN.list, (ctx) => this.showList(ctx));
    bot.hears([BTN.check, ...LEGACY_BTN.check], (ctx) => this.askFor(ctx, 'check'));
    bot.hears([BTN.block, LEGACY_BTN.block], (ctx) => this.sendBlock(ctx));
    bot.hears(BTN.settings, (ctx) => this.showSettings(ctx));

    // chk — новый отчёт, rf — обновить отчёт в том же сообщении
    bot.callbackQuery(/^(chk|rf|sub|unsub):(.+)$/, async (ctx) => {
      const [, action, id] = ctx.match;
      const value = this.refs.resolve(id);
      const target = value ? parseTarget(value) : null;
      if (!target) {
        await ctx.answerCallbackQuery({ text: 'Кнопка устарела — отправьте адрес заново', show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      if (action === 'chk' || action === 'rf') await this.check(ctx, target, action === 'rf');
      else if (action === 'sub') await this.subscribe(ctx, target.value, null);
      else await this.unsubscribe(ctx, target.value, true);
    });
    bot.callbackQuery('sum', async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.safely(ctx, async () => {
        await ctx.replyWithChatAction('typing');
        await ctx.reply(await this.messages.summaryReport(ctx.chat!.id), HTML);
      });
    });
    bot.callbackQuery(/^set:(?:cur:(btc|usd|rub)|tz:(utc|kaliningrad|moscow)|others)$/, async (ctx) => {
      const chatId = ctx.chat!.id;
      const currency = ctx.match[1] as Currency | undefined;
      const timeZone = ctx.match[2] as TimeZone | undefined;
      const patch: Partial<ChatSettings> = currency
        ? { currency }
        : timeZone
          ? { timeZone }
          : { showOthers: !this.storage.settingsOf(chatId).showOthers };
      const settings = this.storage.updateSettings(chatId, patch);
      await ctx.answerCallbackQuery({ text: 'Сохранено' });
      await this.showSettings(ctx, true, settings);
    });
    bot.callbackQuery(/^(blk|rblk)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendBlock(ctx, ctx.match[1] === 'rblk');
    });

    bot.on('message:text', (ctx) => this.onText(ctx, ctx.message.text));
    bot.on('message:photo', (ctx) => this.onImage(ctx, 'JPEG', ctx.message.photo.at(-1)!.file_size));
    bot.on('message:document', async (ctx, next) => {
      // Картинка, отправленная «файлом», приходит без сжатия — для OCR это даже лучше
      const { mime_type, file_size } = ctx.message.document;
      if (mime_type === 'image/jpeg') return this.onImage(ctx, 'JPEG', file_size);
      if (mime_type === 'image/png') return this.onImage(ctx, 'PNG', file_size);
      if (mime_type?.startsWith('image/') && ctx.chat.type === 'private') {
        await ctx.reply('Этот формат не поддерживается. Пришлите фото обычным способом (не файлом) или в JPEG / PNG.');
        return;
      }
      await next();
    });

    bot.catch(({ error, ctx }) => {
      this.logger.error(`Ошибка обработки update ${ctx.update.update_id}: ${(error as Error).message}`);
    });
  }

  private pendingKey(ctx: Context): string {
    return `${ctx.chat?.id}:${ctx.from?.id}`;
  }

  private async help(ctx: Context): Promise<void> {
    await ctx.reply(
      [
        '👋 <b>Бот следит за биткоин-адресами через mempool.space</b>',
        '',
        'После подписки на адрес я пришлю сообщение:',
        '• как только транзакция появится в мемпуле (0 подтверждений);',
        '• когда она получит первое подтверждение;',
        '• если неподтверждённая транзакция пропадёт (RBF / вытеснение).',
        '',
        `<b>${BTN.sub}</b> — добавить адрес (можно с меткой: <code>bc1q… Мой кошелёк</code>)`,
        `<b>${BTN.list}</b> — список подписок, проверка и отписка`,
        `<b>${BTN.check}</b> — баланс адреса или статус транзакции по txid`,
        `<b>${BTN.block}</b> — сколько прошло с момента добычи последнего блока`,
        `<b>${BTN.settings}</b> — валюта сумм (BTC, USD, RUB) и часовой пояс`,
        '',
        'Можно просто прислать адрес или txid — я его проверю.',
        '',
        '📷 Пришлите фото с GPS-координатами на нём (например, со штампом NoteCam) — верну ссылку на Яндекс Карты.',
        '',
        `💻 Исходный код: <a href="${this.config.sourceUrl}">GitHub</a>`,
      ].join('\n'),
      { ...HTML, reply_markup: this.menu },
    );
  }

  private async askFor(ctx: Context, action: PendingAction): Promise<void> {
    this.pending.set(this.pendingKey(ctx), action);
    if (action === 'sub') {
      await ctx.reply('Отправьте биткоин-адрес. Через пробел можно указать метку, например:\n<code>bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh Холодный</code>', HTML);
      return;
    }
    const subs = this.storage.addressesOf(ctx.chat!.id);
    const keyboard = new InlineKeyboard();
    for (const { address, label } of subs) keyboard.text(`💼 ${label ?? shortAddress(address)}`, `chk:${this.refs.ref(address)}`).row();
    if (subs.length > 1) keyboard.text('📊 Все балансы', 'sum');
    await ctx.reply(
      subs.length ? 'Отправьте адрес или txid — или выберите адрес из подписок:' : 'Отправьте адрес или txid транзакции:',
      { reply_markup: keyboard },
    );
  }

  private async onText(ctx: Context, text: string): Promise<void> {
    if (text.startsWith('/')) return;
    const key = this.pendingKey(ctx);
    const action = this.pending.get(key);
    this.pending.delete(key);

    if (action === 'sub') return this.subscribeFromText(ctx, text);
    if (action === 'check') return this.checkFromText(ctx, text);
    // Без явного действия реагируем только в личке, чтобы не мешать в группах
    if (ctx.chat?.type !== 'private') return;
    if (parseTarget(text.split(/\s+/)[0])) return this.checkFromText(ctx, text);
    const coords = parseCoordinates(text);
    if (coords) return this.replyWithMap(ctx, coords);
    await ctx.reply('Не понял 🤔 Пришлите адрес или txid, либо воспользуйтесь кнопками меню.', { reply_markup: this.menu });
  }

  /** Фото с координатами на нём → распознавание текста → ссылка на Яндекс Карты. */
  private async onImage(ctx: Context, mimeType: OcrMimeType, size: number | undefined): Promise<void> {
    // Каждое распознавание платное, поэтому в группах фото не обрабатываем
    if (ctx.chat?.type !== 'private') return;
    if (!this.ocr.enabled) {
      await ctx.reply('📷 Распознавание координат на фото не настроено (нужен ключ Yandex Vision OCR).');
      return;
    }
    if (size && size > MAX_IMAGE_BYTES) {
      await ctx.reply(`Файл слишком большой: максимум ${MAX_IMAGE_BYTES / 1024 / 1024} МБ.`);
      return;
    }

    await ctx.replyWithChatAction('typing');
    try {
      const file = await ctx.getFile();
      const res = await fetch(`https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Не удалось скачать файл из Telegram: HTTP ${res.status}`);
      const text = await this.ocr.recognize(Buffer.from(await res.arrayBuffer()), mimeType);

      const coords = parseCoordinates(text);
      if (coords) return await this.replyWithMap(ctx, coords);

      const preview = text.trim().slice(0, 300);
      await ctx.reply(
        preview
          ? `🤷 Не нашёл координат на фото. Распознанный текст:\n<code>${escapeHtml(preview)}</code>`
          : '🤷 Не нашёл на фото текста. Попробуйте прислать снимок крупнее или файлом без сжатия.',
        HTML,
      );
    } catch (err) {
      this.logger.error(`Распознавание фото не удалось: ${(err as Error).message}`);
      await ctx.reply('😵 Не получилось распознать фото, попробуйте ещё раз чуть позже.');
    }
  }

  private async replyWithMap(ctx: Context, coords: Coordinates): Promise<void> {
    const url = yandexMapsUrl(coords);
    const lines = [`📍 <b>Координаты:</b> <code>${formatCoordinates(coords)}</code>`];
    if (coords.accuracyM !== undefined) lines.push(`Точность: ${coords.accuracyM} м`);
    lines.push('', `<a href="${url}">Открыть в Яндекс Картах</a>`);
    await ctx.reply(lines.join('\n'), {
      ...HTML,
      reply_markup: new InlineKeyboard().url('🗺 Яндекс Карты', url),
    });
  }

  private async subscribeFromText(ctx: Context, text: string): Promise<void> {
    const [first, ...rest] = text.trim().split(/\s+/);
    const target = parseTarget(first ?? '');
    if (target?.kind !== 'address') {
      this.pending.set(this.pendingKey(ctx), 'sub');
      await ctx.reply('Это не похоже на биткоин-адрес. Попробуйте ещё раз:');
      return;
    }
    const label = rest.join(' ').slice(0, MAX_LABEL) || null;
    await this.subscribe(ctx, target.value, label);
  }

  private async subscribe(ctx: Context, address: string, label: string | null): Promise<void> {
    const chatId = ctx.chat!.id;
    const subs = this.storage.addressesOf(chatId);
    if (subs.length >= this.config.maxAddressesPerChat && !subs.some((s) => s.address === address)) {
      await ctx.reply(`Достигнут лимит: ${this.config.maxAddressesPerChat} адресов на чат.`);
      return;
    }
    await this.safely(ctx, async () => {
      await ctx.replyWithChatAction('typing');
      const { existed, pending } = await this.watcher.subscribe(chatId, address, label);
      const lines = existed
        ? [`Вы уже подписаны на <code>${address}</code>${label ? `, метка обновлена: <b>${escapeHtml(label)}</b>` : ''}.`]
        : [
            `🔔 Подписка оформлена${label ? ` — <b>${escapeHtml(label)}</b>` : ''}`,
            `<code>${address}</code>`,
            '',
            'Пришлю уведомление о каждой новой транзакции и о её первом подтверждении.',
          ];
      if (!existed && pending) lines.push(`Сейчас в мемпуле ${pending} неподтв. транзакц. — сообщу, когда подтвердятся.`);
      await ctx.reply(lines.join('\n'), {
        ...HTML,
        reply_markup: new InlineKeyboard().text('🔍 Баланс сейчас', `chk:${this.refs.ref(address)}`),
      });
    });
  }

  private async unsubscribeFromText(ctx: Context, text: string): Promise<void> {
    const target = parseTarget(text.trim().split(/\s+/)[0] ?? '');
    if (target?.kind !== 'address') {
      await ctx.reply('Укажите адрес: /unsub <адрес>');
      return;
    }
    await this.unsubscribe(ctx, target.value, false);
  }

  private async unsubscribe(ctx: Context, address: string, fromList: boolean): Promise<void> {
    const ok = this.watcher.unsubscribe(ctx.chat!.id, address);
    if (fromList) {
      await this.showList(ctx, true);
      return;
    }
    await ctx.reply(ok ? `🔕 Отписались от <code>${address}</code>` : 'Подписки на этот адрес нет.', HTML);
  }

  private async showSettings(ctx: Context, edit = false, settings?: ChatSettings): Promise<void> {
    const current = settings ?? this.storage.settingsOf(ctx.chat!.id);
    const keyboard = new InlineKeyboard();
    for (const [code, name] of Object.entries(CURRENCIES) as [Currency, string][]) {
      keyboard.text(current.currency === code ? `✅ ${name}` : name, `set:cur:${code}`);
    }
    keyboard
      .row()
      .text(current.showOthers ? '🙈 Скрыть остальные валюты' : '👁 Показывать остальные валюты', 'set:others')
      .row();
    for (const tz of Object.keys(TIME_ZONES) as TimeZone[]) {
      const name = timeZoneName(tz);
      keyboard.text(current.timeZone === tz ? `✅ ${name}` : name, `set:tz:${tz}`);
    }
    keyboard.row().url('💻 Исходный код на GitHub', this.config.sourceUrl);

    const text = [
      '⚙️ <b>Настройки</b>',
      '',
      `Основная валюта: <b>${CURRENCIES[current.currency]}</b>`,
      `Остальные валюты: ${current.showOthers ? 'показываются после основной' : 'скрыты'}`,
      `Часовой пояс: <b>${timeZoneName(current.timeZone)}</b>`,
      '',
      'Основная валюта используется для балансов, сумм транзакций и уведомлений.',
      'Если курс временно недоступен, сумма будет показана в BTC.',
      'Часовой пояс применяется ко всем датам и времени в сообщениях.',
    ].join('\n');
    await this.send(ctx, text, keyboard, edit);
  }

  private async showList(ctx: Context, edit = false): Promise<void> {
    const subs = this.storage.addressesOf(ctx.chat!.id);
    const keyboard = new InlineKeyboard();
    let text: string;
    if (!subs.length) {
      text = `Подписок пока нет. Нажмите «${BTN.sub}».`;
    } else {
      text = [
        `📋 <b>Подписки (${subs.length})</b>`,
        '',
        ...subs.map(({ address, label }, i) => `${i + 1}. ${label ? `<b>${escapeHtml(label)}</b>\n    ` : ''}<code>${address}</code>`),
      ].join('\n');
      for (const { address, label } of subs) {
        const id = this.refs.ref(address);
        keyboard.text(`🔍 ${label ?? shortAddress(address)}`, `chk:${id}`).text('❌ Отписаться', `unsub:${id}`).row();
      }
      if (subs.length > 1) keyboard.text('📊 Все балансы', 'sum');
    }
    await this.send(ctx, text, keyboard, edit);
  }

  private async checkFromText(ctx: Context, text: string): Promise<void> {
    const target = parseTarget(text.trim().split(/\s+/)[0] ?? '');
    if (!target) {
      this.pending.set(this.pendingKey(ctx), 'check');
      await ctx.reply('Это не похоже ни на адрес, ни на txid (64 hex-символа). Попробуйте ещё раз:');
      return;
    }
    await this.check(ctx, target, false);
  }

  private async check(ctx: Context, target: Target, edit: boolean): Promise<void> {
    await this.safely(ctx, async () => {
      if (!edit) await ctx.replyWithChatAction('typing');
      const chatId = ctx.chat!.id;
      const id = this.refs.ref(target.value);
      const keyboard = new InlineKeyboard().text('🔄 Обновить', `rf:${id}`);
      let text: string;
      if (target.kind === 'address') {
        text = await this.messages.addressReport(target.value, chatId);
        if (!this.storage.get(target.value)?.chats[chatId]) keyboard.text('🔔 Подписаться', `sub:${id}`);
      } else {
        text = await this.messages.txReport(target.value, chatId);
      }
      await this.send(ctx, text, keyboard, edit);
    });
  }

  private async sendBlock(ctx: Context, edit = false): Promise<void> {
    await this.safely(ctx, async () => {
      if (!edit) await ctx.replyWithChatAction('typing');
      const text = await this.messages.blockReport(ctx.chat!.id);
      await this.send(ctx, text, new InlineKeyboard().text('🔄 Обновить', 'rblk'), edit);
    });
  }

  private async send(ctx: Context, text: string, keyboard: InlineKeyboard, edit: boolean): Promise<void> {
    if (!edit) {
      await ctx.reply(text, { ...HTML, reply_markup: keyboard });
      return;
    }
    try {
      await ctx.editMessageText(text, { ...HTML, reply_markup: keyboard });
    } catch (err) {
      // Данные не изменились с прошлого раза — это не ошибка
      if (!(err instanceof GrammyError && err.description.includes('message is not modified'))) throw err;
    }
  }

  /** Понятное пользователю сообщение вместо молчания при ошибке API. */
  private async safely(ctx: Context, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      let text = '😵 mempool.space сейчас не отвечает, попробуйте чуть позже.';
      if (err instanceof MempoolApiError && err.status === 400) text = '❌ Некорректный адрес или txid.';
      else if (err instanceof MempoolApiError && err.status === 404) text = '🔎 Не найдено: такой транзакции нет ни в мемпуле, ни в блокчейне.';
      else this.logger.error((err as Error).message);
      await ctx.reply(text);
    }
  }
}
