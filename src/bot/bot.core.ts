import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { formatCoordinates, googleMapsUrl, parseCoordinates, yandexMapsUrl, type Coordinates } from '../geo/coordinates.js';
import { GeoService, type LocatedCoordinates } from '../geo/geo.service.js';
import { YandexOcrService } from '../geo/yandex-ocr.service.js';
import { MempoolApiError } from '../mempool/mempool-api.service.js';
import { StorageService, type ChatSettings, type Currency, type TimeZone } from '../storage/storage.service.js';
import type { ChatTransport } from '../transport/chat-transport.js';
import { b, code, i, lines, link, rt, type RichPart, type RichText } from '../transport/rich-text.js';
import { TransportRegistry } from '../transport/transport.registry.js';
import {
  chatKey,
  ChatUnavailableError,
  type Button,
  type IncomingUpdate,
  type OutgoingMessage,
  type ReplyContext,
  type TransportLimits,
} from '../transport/transport.types.js';
import { WATCHER_TX_EVENT, type WatcherTxEvent } from '../watcher/watcher.events.js';
import { WatcherService } from '../watcher/watcher.service.js';
import { shortAddress, TIME_ZONES, timeZoneName } from './format.js';
import { action, BTN, COMMANDS, LEGACY_BTN, MENU_LAYOUT, url } from './menu.js';
import { MessagesService } from './messages.service.js';
import { parseTarget, type Target } from './parse.js';
import { RefsService } from './refs.service.js';

const CURRENCIES: Record<Currency, string> = { btc: '₿ BTC', usd: '$ USD', rub: '₽ RUB' };
const MAX_LABEL = 40;
// Лимит Bot API Telegram на скачивание файлов — 20 МБ; для фото с текстом этого с запасом хватает
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type PendingAction = 'sub' | 'check';

/** Входящее событие вместе с тем, чем на него отвечать. */
interface Ctx {
  update: IncomingUpdate;
  reply: ReplyContext;
  /** Ключ чата в хранилище: `tg:…` / `vk:…` */
  chat: string;
  limits: TransportLimits;
}

/**
 * Ядро бота: команды, кнопки, подписки, отчёты, координаты с фото, уведомления.
 * Не знает, через какой мессенджер работает, — общается с ним через ChatTransport.
 */
@Injectable()
export class BotCore implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BotCore.name);
  /** Ожидаемый ввод после нажатия кнопки; ключ — `${chat}:${userId}` */
  private readonly pending = new Map<string, PendingAction>();

  constructor(
    @Inject(appConfig.KEY) private readonly config: AppConfig,
    private readonly registry: TransportRegistry,
    private readonly messages: MessagesService,
    private readonly watcher: WatcherService,
    private readonly storage: StorageService,
    private readonly refs: RefsService,
    private readonly ocr: YandexOcrService,
    private readonly geo: GeoService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Мессенджеры стартуют независимо: ошибка VK (например, неверный ключ) не должна ронять Telegram
    const results = await Promise.allSettled(
      this.registry.transports.map(async (transport) => {
        transport.onUpdate((update, reply) => this.handle(transport, update, reply));
        await transport.start({ menu: MENU_LAYOUT, commands: COMMANDS });
      }),
    );
    results.forEach((result, n) => {
      if (result.status === 'rejected') {
        this.logger.error(`Мессенджер ${this.registry.transports[n].kind} не запустился: ${(result.reason as Error).message}`);
      }
    });
    if (results.every((r) => r.status === 'rejected')) throw new Error('Не запустился ни один мессенджер');
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.registry.transports.map((t) => t.stop()));
  }

  // ─── Уведомления ───────────────────────────────────────────────────────────

  @OnEvent(WATCHER_TX_EVENT, { async: true })
  async onTx(event: WatcherTxEvent): Promise<void> {
    const buttons: Button[][] = [[action('🔍 Баланс адреса', `chk:${this.refs.ref(event.address)}`)]];
    if (event.type !== 'removed') buttons[0].push(action('🧾 Транзакция', `chk:${this.refs.ref(event.tx.txid)}`));

    for (const chat of this.storage.chatsOf(event.address)) {
      try {
        const text = await this.messages.notification(event, chat);
        await this.registry.send(chat, { text, buttons });
      } catch (err) {
        if (err instanceof ChatUnavailableError) {
          this.logger.warn(`Чат ${chat} недоступен (бот заблокирован) — удаляю его подписки`);
          this.watcher.unsubscribeChat(chat);
        } else {
          this.logger.error(`Не удалось отправить уведомление в ${chat}: ${(err as Error).message}`);
        }
      }
    }
  }

  // ─── Маршрутизация входящих событий ───────────────────────────────────────

  async handle(transport: ChatTransport, update: IncomingUpdate, reply: ReplyContext): Promise<void> {
    const ctx: Ctx = { update, reply, chat: chatKey(update.chat), limits: transport.limits };
    try {
      if (!this.isAllowed(update)) {
        if (update.chat.isPrivate && update.kind !== 'action') await reply.reply({ text: rt`⛔️ Нет доступа к этому боту.` });
        if (update.kind === 'action') await reply.answerAction('⛔️ Нет доступа', true);
        return;
      }
      if (update.kind === 'text') await this.onText(ctx, update.text);
      else if (update.kind === 'action') await this.onAction(ctx, update.data);
      else await this.onImage(ctx, update);
    } catch (err) {
      this.logger.error(`Ошибка обработки события ${ctx.chat}: ${(err as Error).message}`);
    }
  }

  private isAllowed(update: IncomingUpdate): boolean {
    const allowed = update.chat.transport === 'tg' ? this.config.allowedUserIds : this.config.allowedVkUserIds;
    return !allowed.size || allowed.has(update.userId);
  }

  private async onText(ctx: Ctx, text: string): Promise<void> {
    const command = /^\/([a-z]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (command) return this.onCommand(ctx, command[1].toLowerCase(), (command[2] ?? '').trim());

    const label = text.trim();
    if (label === BTN.sub || (LEGACY_BTN.sub as readonly string[]).includes(label)) return this.askFor(ctx, 'sub');
    if (label === BTN.list) return this.showList(ctx);
    if (label === BTN.check || (LEGACY_BTN.check as readonly string[]).includes(label)) return this.askFor(ctx, 'check');
    if (label === BTN.block || (LEGACY_BTN.block as readonly string[]).includes(label)) return this.sendBlock(ctx);
    if (label === BTN.settings) return this.showSettings(ctx);

    const key = this.pendingKey(ctx);
    const pending = this.pending.get(key);
    this.pending.delete(key);
    if (pending === 'sub') return this.subscribeFromText(ctx, text);
    if (pending === 'check') return this.checkFromText(ctx, text);

    // Без явного действия реагируем только в личке, чтобы не мешать в группах
    if (!ctx.update.chat.isPrivate) return;
    if (parseTarget(text.split(/\s+/)[0])) return this.checkFromText(ctx, text);
    const coords = parseCoordinates(text);
    if (coords) return this.replyWithMap(ctx, coords);
    await ctx.reply.reply({ text: rt`Не понял 🤔 Пришлите адрес или txid, либо воспользуйтесь кнопками меню.`, menu: true });
  }

  private async onCommand(ctx: Ctx, command: string, args: string): Promise<void> {
    switch (command) {
      case 'start':
      case 'help':
        return this.help(ctx);
      case 'sub':
        return args ? this.subscribeFromText(ctx, args) : this.askFor(ctx, 'sub');
      case 'unsub':
        return args ? this.unsubscribeFromText(ctx, args) : this.showList(ctx);
      case 'list':
        return this.showList(ctx);
      case 'check':
        return args ? this.checkFromText(ctx, args) : this.askFor(ctx, 'check');
      case 'block':
        return this.sendBlock(ctx);
      case 'settings':
        return this.showSettings(ctx);
      default:
        if (ctx.update.chat.isPrivate) await ctx.reply.reply({ text: rt`Такой команды нет. /help — список команд.` });
    }
  }

  private async onAction(ctx: Ctx, data: string): Promise<void> {
    const { reply } = ctx;
    // chk — новый отчёт, rf — обновить отчёт в том же сообщении
    let m = /^(chk|rf|sub|unsub):(.+)$/.exec(data);
    if (m) {
      const value = this.refs.resolve(m[2]);
      const target = value ? parseTarget(value) : null;
      if (!target) return reply.answerAction('Кнопка устарела — отправьте адрес заново', true);
      await reply.answerAction();
      if (m[1] === 'chk' || m[1] === 'rf') return this.check(ctx, target, m[1] === 'rf');
      if (m[1] === 'sub') return this.subscribe(ctx, target.value, null);
      return this.unsubscribe(ctx, target.value, true);
    }
    if ((m = /^list:(\d+)$/.exec(data))) {
      await reply.answerAction();
      return this.showList(ctx, true, Number(m[1]));
    }
    if (data === 'sum') {
      await reply.answerAction();
      return this.safely(ctx, async () => {
        await reply.typing();
        await reply.reply({ text: await this.messages.summaryReport(ctx.chat) });
      });
    }
    if ((m = /^set:(?:cur:(btc|usd|rub)|tz:(utc|kaliningrad|moscow)|others)$/.exec(data))) {
      const currency = m[1] as Currency | undefined;
      const timeZone = m[2] as TimeZone | undefined;
      const patch: Partial<ChatSettings> = currency
        ? { currency }
        : timeZone
          ? { timeZone }
          : { showOthers: !this.storage.settingsOf(ctx.chat).showOthers };
      const settings = this.storage.updateSettings(ctx.chat, patch);
      await reply.answerAction('Сохранено');
      return this.showSettings(ctx, true, settings);
    }
    if (data === 'blk' || data === 'rblk') {
      await reply.answerAction();
      return this.sendBlock(ctx, data === 'rblk');
    }
    await reply.answerAction('Кнопка устарела', true);
  }

  private pendingKey(ctx: Ctx): string {
    return `${ctx.chat}:${ctx.update.userId}`;
  }

  // ─── Сценарии ──────────────────────────────────────────────────────────────

  private async help(ctx: Ctx): Promise<void> {
    await ctx.reply.reply({
      menu: true,
      text: lines(
        b('👋 Бот следит за биткоин-адресами через mempool.space'),
        '',
        'После подписки на адрес я пришлю сообщение:',
        '• как только транзакция появится в мемпуле (0 подтверждений);',
        '• когда она получит первое подтверждение;',
        '• если неподтверждённая транзакция пропадёт (RBF / вытеснение).',
        '',
        rt`${b(BTN.sub)} — добавить адрес (можно с меткой: ${code('bc1q… Мой кошелёк')})`,
        rt`${b(BTN.list)} — список подписок, проверка и отписка`,
        rt`${b(BTN.check)} — баланс адреса или статус транзакции по txid`,
        rt`${b(BTN.block)} — сколько прошло с момента добычи последнего блока`,
        rt`${b(BTN.settings)} — валюта сумм (BTC, USD, RUB) и часовой пояс`,
        '',
        'Можно просто прислать адрес или txid — я его проверю.',
        '',
        '📷 Пришлите фото с GPS-координатами на нём (например, со штампом NoteCam) — верну точку и ссылки на карты.',
        '',
        rt`💻 Исходный код: ${link('GitHub', this.config.sourceUrl)}`,
      ),
    });
  }

  private async askFor(ctx: Ctx, pending: PendingAction): Promise<void> {
    this.pending.set(this.pendingKey(ctx), pending);
    if (pending === 'sub') {
      await ctx.reply.reply({
        text: lines(
          'Отправьте биткоин-адрес. Через пробел можно указать метку, например:',
          code('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh Холодный'),
        ),
      });
      return;
    }
    const subs = this.storage.addressesOf(ctx.chat);
    // Один ряд оставляем под «Все балансы»
    const shown = subs.slice(0, ctx.limits.maxButtonRows - 1);
    const buttons: Button[][] = shown.map(({ address, label }) => [
      action(`💼 ${label ?? shortAddress(address)}`, `chk:${this.refs.ref(address)}`),
    ]);
    if (subs.length > 1) buttons.push([action('📊 Все балансы', 'sum')]);
    await ctx.reply.reply({
      text: rt`${subs.length ? 'Отправьте адрес или txid — или выберите адрес из подписок:' : 'Отправьте адрес или txid транзакции:'}`,
      buttons,
    });
  }

  private async subscribeFromText(ctx: Ctx, text: string): Promise<void> {
    const [first, ...rest] = text.trim().split(/\s+/);
    const target = parseTarget(first ?? '');
    if (target?.kind !== 'address') {
      this.pending.set(this.pendingKey(ctx), 'sub');
      await ctx.reply.reply({ text: rt`Это не похоже на биткоин-адрес. Попробуйте ещё раз:` });
      return;
    }
    const label = rest.join(' ').slice(0, MAX_LABEL) || null;
    await this.subscribe(ctx, target.value, label);
  }

  private async subscribe(ctx: Ctx, address: string, label: string | null): Promise<void> {
    const subs = this.storage.addressesOf(ctx.chat);
    if (subs.length >= this.config.maxAddressesPerChat && !subs.some((s) => s.address === address)) {
      await ctx.reply.reply({ text: rt`Достигнут лимит: ${this.config.maxAddressesPerChat} адресов на чат.` });
      return;
    }
    await this.safely(ctx, async () => {
      await ctx.reply.typing();
      const { existed, pending } = await this.watcher.subscribe(ctx.chat, address, label);
      const out: RichPart[] = existed
        ? [rt`Вы уже подписаны на ${code(address)}${label ? rt`, метка обновлена: ${b(label)}` : ''}.`]
        : [
            rt`🔔 Подписка оформлена${label ? rt` — ${b(label)}` : ''}`,
            code(address),
            '',
            'Пришлю уведомление о каждой новой транзакции и о её первом подтверждении.',
          ];
      if (!existed && pending) out.push(`Сейчас в мемпуле ${pending} неподтв. транзакц. — сообщу, когда подтвердятся.`);
      await ctx.reply.reply({
        text: lines(...out),
        buttons: [[action('🔍 Баланс сейчас', `chk:${this.refs.ref(address)}`)]],
      });
    });
  }

  private async unsubscribeFromText(ctx: Ctx, text: string): Promise<void> {
    const target = parseTarget(text.trim().split(/\s+/)[0] ?? '');
    if (target?.kind !== 'address') {
      await ctx.reply.reply({ text: rt`Укажите адрес: /unsub <адрес>` });
      return;
    }
    await this.unsubscribe(ctx, target.value, false);
  }

  private async unsubscribe(ctx: Ctx, address: string, fromList: boolean): Promise<void> {
    const ok = this.watcher.unsubscribe(ctx.chat, address);
    if (fromList) return this.showList(ctx, true);
    await ctx.reply.reply({ text: ok ? rt`🔕 Отписались от ${code(address)}` : rt`Подписки на этот адрес нет.` });
  }

  private async showSettings(ctx: Ctx, edit = false, settings?: ChatSettings): Promise<void> {
    const current = settings ?? this.storage.settingsOf(ctx.chat);
    const mark = (on: boolean, label: string) => (on ? `✅ ${label}` : label);
    const buttons: Button[][] = [
      (Object.entries(CURRENCIES) as [Currency, string][]).map(([c, name]) =>
        action(mark(current.currency === c, name), `set:cur:${c}`),
      ),
      [action(current.showOthers ? '🙈 Скрыть остальные валюты' : '👁 Показывать остальные валюты', 'set:others')],
      (Object.keys(TIME_ZONES) as TimeZone[]).map((tz) => action(mark(current.timeZone === tz, timeZoneName(tz)), `set:tz:${tz}`)),
      [url('💻 Исходный код на GitHub', this.config.sourceUrl)],
    ];
    const text = lines(
      b('⚙️ Настройки'),
      '',
      rt`Основная валюта: ${b(CURRENCIES[current.currency])}`,
      `Остальные валюты: ${current.showOthers ? 'показываются после основной' : 'скрыты'}`,
      rt`Часовой пояс: ${b(timeZoneName(current.timeZone))}`,
      '',
      'Основная валюта используется для балансов, сумм транзакций и уведомлений.',
      'Если курс временно недоступен, сумма будет показана в BTC.',
      'Часовой пояс применяется ко всем датам и времени в сообщениях.',
    );
    await this.send(ctx, { text, buttons }, edit);
  }

  /** Список подписок; кнопок может быть больше, чем позволяет платформа, — тогда по страницам. */
  private async showList(ctx: Ctx, edit = false, page = 0): Promise<void> {
    const subs = this.storage.addressesOf(ctx.chat);
    if (!subs.length) {
      await this.send(ctx, { text: rt`Подписок пока нет. Нажмите «${BTN.sub}».` }, edit);
      return;
    }
    // По ряду на адрес + ряд «Все балансы» + ряд навигации
    const perPage = Math.max(1, ctx.limits.maxButtonRows - 2);
    const pages = Math.ceil(subs.length / perPage);
    const current = Math.min(Math.max(page, 0), pages - 1);
    const from = current * perPage;

    const text = lines(
      b(`📋 Подписки (${subs.length})${pages > 1 ? ` · стр. ${current + 1}/${pages}` : ''}`),
      '',
      ...subs
        .slice(from, from + perPage)
        .map(({ address, label }, n) => rt`${from + n + 1}. ${label ? rt`${b(label)}\n    ` : ''}${code(address)}`),
    );
    const buttons: Button[][] = subs.slice(from, from + perPage).map(({ address, label }) => {
      const id = this.refs.ref(address);
      return [action(`🔍 ${label ?? shortAddress(address)}`, `chk:${id}`), action('❌ Отписаться', `unsub:${id}`)];
    });
    if (pages > 1) {
      const nav: Button[] = [];
      if (current > 0) nav.push(action('◀ Назад', `list:${current - 1}`));
      if (current < pages - 1) nav.push(action('Вперёд ▶', `list:${current + 1}`));
      buttons.push(nav);
    }
    if (subs.length > 1) buttons.push([action('📊 Все балансы', 'sum')]);
    await this.send(ctx, { text, buttons }, edit);
  }

  private async checkFromText(ctx: Ctx, text: string): Promise<void> {
    const target = parseTarget(text.trim().split(/\s+/)[0] ?? '');
    if (!target) {
      this.pending.set(this.pendingKey(ctx), 'check');
      await ctx.reply.reply({ text: rt`Это не похоже ни на адрес, ни на txid (64 hex-символа). Попробуйте ещё раз:` });
      return;
    }
    await this.check(ctx, target, false);
  }

  private async check(ctx: Ctx, target: Target, edit: boolean): Promise<void> {
    await this.safely(ctx, async () => {
      if (!edit) await ctx.reply.typing();
      const id = this.refs.ref(target.value);
      const row: Button[] = [action('🔄 Обновить', `rf:${id}`)];
      let text: RichText;
      if (target.kind === 'address') {
        text = await this.messages.addressReport(target.value, ctx.chat);
        if (!this.storage.isSubscribed(target.value, ctx.chat)) row.push(action('🔔 Подписаться', `sub:${id}`));
      } else {
        text = await this.messages.txReport(target.value, ctx.chat);
      }
      await this.send(ctx, { text, buttons: [row] }, edit);
    });
  }

  private async sendBlock(ctx: Ctx, edit = false): Promise<void> {
    await this.safely(ctx, async () => {
      if (!edit) await ctx.reply.typing();
      const text = await this.messages.blockReport(ctx.chat);
      await this.send(ctx, { text, buttons: [[action('🔄 Обновить', 'rblk')]] }, edit);
    });
  }

  // ─── Координаты с фото ─────────────────────────────────────────────────────

  /** Фото с координатами на нём → распознавание текста → точка и ссылки на карты. */
  private async onImage(ctx: Ctx, update: Extract<IncomingUpdate, { kind: 'image' }>): Promise<void> {
    // Каждое распознавание платное, поэтому в группах фото не обрабатываем
    if (!update.chat.isPrivate) return;
    const { reply } = ctx;
    if (!update.mimeType) {
      await reply.reply({ text: rt`Этот формат не поддерживается. Пришлите фото обычным способом (не файлом) или в JPEG / PNG.` });
      return;
    }
    if (!this.ocr.enabled) {
      await reply.reply({ text: rt`📷 Распознавание координат на фото не настроено (нужен ключ Yandex Vision OCR).` });
      return;
    }
    if (update.size && update.size > MAX_IMAGE_BYTES) {
      await reply.reply({ text: rt`Файл слишком большой: максимум ${MAX_IMAGE_BYTES / 1024 / 1024} МБ.` });
      return;
    }

    await reply.typing();
    try {
      const text = await this.ocr.recognize(await update.download(), update.mimeType);
      const located = await this.geo.locateInText(text);
      if (located) return await this.replyWithMap(ctx, located.coords, located.source);

      const preview = text.trim().slice(0, 300);
      await reply.reply({
        text: preview
          ? lines('🤷 Не нашёл координат на фото. Распознанный текст:', code(preview))
          : rt`🤷 Не нашёл на фото текста. Попробуйте прислать снимок крупнее или файлом без сжатия.`,
      });
    } catch (err) {
      this.logger.error(`Распознавание фото не удалось: ${(err as Error).message}`);
      await reply.reply({ text: rt`😵 Не получилось распознать фото, попробуйте ещё раз чуть позже.` });
    }
  }

  private async replyWithMap(ctx: Ctx, coords: Coordinates, source: LocatedCoordinates['source'] = 'parser'): Promise<void> {
    await ctx.reply.sendLocation(coords.lat, coords.lon, coords.accuracyM);
    const yandex = yandexMapsUrl(coords);
    const google = googleMapsUrl(coords);
    await ctx.reply.reply({
      text: lines(
        rt`📍 ${b('Координаты:')} ${code(formatCoordinates(coords))}`,
        coords.accuracyM !== undefined && `Точность: ${coords.accuracyM} м`,
        source === 'llm' && i('🤖 Найдено с помощью Alice AI — проверьте точку на карте.'),
      ),
      buttons: [[url('🗺 Яндекс Карты', yandex), url('🌍 Google Maps', google)]],
    });
  }

  // ─── Вспомогательное ──────────────────────────────────────────────────────

  private send(ctx: Ctx, message: OutgoingMessage, edit: boolean): Promise<void> {
    return edit ? ctx.reply.edit(message) : ctx.reply.reply(message);
  }

  /** Понятное пользователю сообщение вместо молчания при ошибке API. */
  private async safely(ctx: Ctx, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      let text = '😵 mempool.space сейчас не отвечает, попробуйте чуть позже.';
      if (err instanceof MempoolApiError && err.status === 400) text = '❌ Некорректный адрес или txid.';
      else if (err instanceof MempoolApiError && err.status === 404) text = '🔎 Не найдено: такой транзакции нет ни в мемпуле, ни в блокчейне.';
      else this.logger.error((err as Error).message);
      await ctx.reply.reply({ text: rt`${text}` });
    }
  }
}
