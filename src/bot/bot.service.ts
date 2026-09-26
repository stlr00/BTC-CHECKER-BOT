import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, Context, GrammyError, InlineKeyboard, Keyboard } from 'grammy';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { MempoolApiError } from '../mempool/mempool-api.service.js';
import { StorageService, type ChatSettings, type Currency } from '../storage/storage.service.js';
import { WATCHER_TX_EVENT, type WatcherTxEvent } from '../watcher/watcher.events.js';
import { WatcherService } from '../watcher/watcher.service.js';
import { escapeHtml, shortAddress } from './format.js';
import { MessagesService } from './messages.service.js';
import { parseTarget, type Target } from './parse.js';
import { RefsService } from './refs.service.js';

const BTN = {
  sub: '➕ Подписаться на адрес',
  list: '📋 Мои адреса',
  check: '🔍 Баланс / транзакция сейчас',
  block: '⏱ Время с последнего блока',
  settings: '⚙️ Настройки',
} as const;

const CURRENCIES: Record<Currency, string> = { btc: '₿ BTC', usd: '$ USD', rub: '₽ RUB' };

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;
const MAX_LABEL = 40;

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
      { command: 'settings', description: 'Валюта отображения сумм' },
    ]);
    this.bot
      .start({ onStart: (me) => this.logger.log(`Бот @${me.username} запущен`) })
      .catch((err: Error) => this.logger.error(`Long polling остановлен: ${err.message}`));
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

    bot.hears(BTN.sub, (ctx) => this.askFor(ctx, 'sub'));
    bot.hears(BTN.list, (ctx) => this.showList(ctx));
    bot.hears(BTN.check, (ctx) => this.askFor(ctx, 'check'));
    bot.hears(BTN.block, (ctx) => this.sendBlock(ctx));
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
    bot.callbackQuery(/^set:(?:cur:(btc|usd|rub)|others)$/, async (ctx) => {
      const chatId = ctx.chat!.id;
      const currency = ctx.match[1] as Currency | undefined;
      const settings = this.storage.updateSettings(
        chatId,
        currency ? { currency } : { showOthers: !this.storage.settingsOf(chatId).showOthers },
      );
      await ctx.answerCallbackQuery({ text: 'Сохранено' });
      await this.showSettings(ctx, true, settings);
    });
    bot.callbackQuery(/^(blk|rblk)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendBlock(ctx, ctx.match[1] === 'rblk');
    });

    bot.on('message:text', (ctx) => this.onText(ctx, ctx.message.text));

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
        `<b>${BTN.settings}</b> — в какой валюте показывать суммы: BTC, USD или RUB`,
        '',
        'Можно просто прислать адрес или txid — я его проверю.',
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
    await ctx.reply('Не понял 🤔 Пришлите адрес или txid, либо воспользуйтесь кнопками меню.', { reply_markup: this.menu });
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
      .text(current.showOthers ? '🙈 Скрыть остальные валюты' : '👁 Показывать остальные валюты', 'set:others');

    const text = [
      '⚙️ <b>Настройки</b>',
      '',
      `Основная валюта: <b>${CURRENCIES[current.currency]}</b>`,
      `Остальные валюты: ${current.showOthers ? 'показываются после основной' : 'скрыты'}`,
      '',
      'Основная валюта используется для балансов, сумм транзакций и уведомлений.',
      'Если курс временно недоступен, сумма будет показана в BTC.',
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
      const text = await this.messages.blockReport();
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
