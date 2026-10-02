import { EventEmitter2 } from '@nestjs/event-emitter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app.config.js';
import type { AliceLlmService } from '../geo/alice-llm.service.js';
import { GeoService } from '../geo/geo.service.js';
import type { YandexOcrService } from '../geo/yandex-ocr.service.js';
import type { MempoolApiService } from '../mempool/mempool-api.service.js';
import type { MempoolSocketService } from '../mempool/mempool-socket.service.js';
import { StorageService } from '../storage/storage.service.js';
import { ChatTransport } from '../transport/chat-transport.js';
import { plainText, rt } from '../transport/rich-text.js';
import { TransportRegistry } from '../transport/transport.registry.js';
import {
  ChatUnavailableError,
  type IncomingEvent,
  type OutgoingMessage,
  type ReplyContext,
  type TransportKind,
  type TransportLimits,
} from '../transport/transport.types.js';
import { renderInlineKeyboard as renderVkKeyboard, VK_LIMITS } from '../transport/vk/vk.render.js';
import { WatcherService } from '../watcher/watcher.service.js';
import { BotCore } from './bot.core.js';
import { BTN } from './menu.js';
import type { MessagesService } from './messages.service.js';
import { RefsService } from './refs.service.js';

const ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

/** Транспорт-заглушка: записывает всё, что отправило ядро. VK-вариант ещё и проверяет лимиты клавиатур. */
class FakeTransport extends ChatTransport {
  readonly sent: { chatId: string; message: OutgoingMessage }[] = [];
  readonly unavailable = new Set<string>();

  constructor(
    readonly kind: TransportKind,
    readonly limits: TransportLimits,
  ) {
    super();
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(chatId: string, message: OutgoingMessage): Promise<void> {
    if (this.unavailable.has(chatId)) throw new ChatUnavailableError(`${this.kind}:${chatId}`);
    this.validate(message);
    this.sent.push({ chatId, message });
  }

  private validate(message: OutgoingMessage): void {
    if (this.kind === 'vk') renderVkKeyboard(message.buttons);
  }

  async emit(event: IncomingEvent, { chatId = '100', userId = '7', isPrivate = true } = {}) {
    const calls = {
      replies: [] as OutgoingMessage[],
      edits: [] as OutgoingMessage[],
      actions: [] as { text?: string; alert?: boolean }[],
      locations: [] as [number, number, number | undefined][],
    };
    const reply: ReplyContext = {
      reply: async (m) => {
        this.validate(m);
        calls.replies.push(m);
      },
      edit: async (m) => {
        this.validate(m);
        calls.edits.push(m);
      },
      typing: async () => {},
      answerAction: async (text, alert) => {
        calls.actions.push({ text, alert });
      },
      sendLocation: async (lat, lon, accuracy) => {
        calls.locations.push([lat, lon, accuracy]);
      },
    };
    await this.handler!({ ...event, chat: { transport: this.kind, id: chatId, isPrivate }, userId } as never, reply);
    return calls;
  }
}

const text = (m: OutgoingMessage | undefined) => (m ? plainText(m.text) : '');

describe('BotCore', () => {
  let tg: FakeTransport;
  let vk: FakeTransport;
  let storage: StorageService;
  let config: AppConfig;
  let core: BotCore;

  beforeEach(async () => {
    tg = new FakeTransport('tg', { maxButtonRows: 100, maxButtonsPerRow: 8, maxLabelLength: 64 });
    vk = new FakeTransport('vk', VK_LIMITS);
    config = {
      allowedUserIds: new Set<string>(),
      allowedVkUserIds: new Set<string>(),
      maxAddressesPerChat: 20,
      sourceUrl: 'https://github.com/stlr00/BTC-CHECKER-BOT',
      pollIntervalMs: 60_000,
      dataFile: '/dev/null',
    } as AppConfig;
    storage = new StorageService(config);
    vi.spyOn(storage, 'save').mockImplementation(() => undefined);

    const api = { addressTxs: vi.fn(async () => []), tx: vi.fn() } as unknown as MempoolApiService;
    const socket = { setAddresses: vi.fn(), start: vi.fn() } as unknown as MempoolSocketService;
    const watcher = new WatcherService(config, api, socket, storage, new EventEmitter2());
    const messages = {
      addressReport: vi.fn(async (address: string) => rt`отчёт по ${address}`),
      txReport: vi.fn(async (txid: string) => rt`транзакция ${txid}`),
      blockReport: vi.fn(async () => rt`последний блок`),
      summaryReport: vi.fn(async () => rt`сводка`),
      notification: vi.fn(async (_e: unknown, chat: string) => rt`уведомление для ${chat}`),
    } as unknown as MessagesService;
    const ocr = {
      enabled: true,
      recognize: vi.fn(async () => 'Широта: 54.155977\nДолгота: 37.619617\nТочность: 4.66 м'),
    } as unknown as YandexOcrService;
    const geo = new GeoService({ extractCoordinates: vi.fn(async () => null) } as unknown as AliceLlmService);

    core = new BotCore(config, new TransportRegistry([tg, vk]), messages, watcher, storage, new RefsService(storage), ocr, geo);
    await core.onApplicationBootstrap();
  });

  it('/start присылает справку с главным меню', async () => {
    const { replies } = await tg.emit({ kind: 'text', text: '/start' });
    expect(replies[0].menu).toBe(true);
    expect(text(replies[0])).toContain('Бот следит за биткоин-адресами');
  });

  it('кнопка VK «Начать» показывает справку', async () => {
    const { replies } = await vk.emit({ kind: 'text', text: 'Начать' });
    expect(replies[0].menu).toBe(true);
  });

  it('понимает команды с упоминанием бота: /check@bot <адрес>', async () => {
    const { replies } = await tg.emit({ kind: 'text', text: `/check@btc_checker_bot ${ADDRESS}` });
    expect(text(replies[0])).toBe(`отчёт по ${ADDRESS}`);
  });

  it('подписка через кнопку меню в VK: чат хранится с префиксом vk:', async () => {
    await vk.emit({ kind: 'text', text: BTN.sub });
    const { replies } = await vk.emit({ kind: 'text', text: `${ADDRESS} Холодный` });

    expect(text(replies[0])).toContain('Подписка оформлена');
    expect(storage.addressesOf('vk:100')).toEqual([{ address: ADDRESS, label: 'Холодный' }]);
    expect(storage.addressesOf('tg:100')).toEqual([]);
  });

  it('листает длинный список подписок в пределах лимитов VK', async () => {
    for (let n = 0; n < 10; n++) storage.create(`bc1qtest${n}`).chats['vk:100'] = { label: `Адрес ${n}`, since: n };

    const first = await vk.emit({ kind: 'text', text: BTN.list });
    expect(text(first.replies[0])).toContain('стр. 1/3');
    expect(first.replies[0].buttons!.length).toBeLessThanOrEqual(VK_LIMITS.maxButtonRows);

    const second = await vk.emit({ kind: 'action', data: 'list:1' });
    expect(text(second.edits[0])).toContain('стр. 2/3');
    expect(text(second.edits[0])).toContain('Адрес 4');
  });

  it('в Telegram весь список помещается на одну страницу', async () => {
    for (let n = 0; n < 10; n++) storage.create(`bc1qtest${n}`).chats['tg:100'] = { label: null, since: n };
    const { replies } = await tg.emit({ kind: 'text', text: '/list' });
    expect(text(replies[0])).not.toContain('стр.');
    expect(replies[0].buttons).toHaveLength(11); // 10 адресов + «Все балансы»
  });

  it('кнопка настроек сохраняет валюту и обновляет сообщение', async () => {
    const { actions, edits } = await vk.emit({ kind: 'action', data: 'set:cur:rub' });
    expect(storage.settingsOf('vk:100').currency).toBe('rub');
    expect(storage.settingsOf('tg:100').currency).toBe('btc');
    expect(actions[0].text).toBe('Сохранено');
    expect(text(edits[0])).toContain('₽ RUB');
  });

  it('фото с координатами: геопозиция и две кнопки-ссылки на карты', async () => {
    const { locations, replies } = await vk.emit({ kind: 'image', mimeType: 'JPEG', download: async () => Buffer.from('jpg') });
    expect(locations).toEqual([[54.155977, 37.619617, 4.66]]);
    const last = replies.at(-1)!;
    expect(text(last)).toContain('54.155977, 37.619617');
    expect(last.buttons![0].map((b) => b.type)).toEqual(['url', 'url']);
  });

  it('фото в группе не распознаёт: это платно', async () => {
    const calls = await tg.emit({ kind: 'image', mimeType: 'JPEG', download: async () => Buffer.from('') }, { isPrivate: false });
    expect(calls.replies).toEqual([]);
    expect(calls.locations).toEqual([]);
  });

  it('уведомление уходит в нужный мессенджер; недоступный чат отписывается', async () => {
    storage.create(ADDRESS).chats['tg:1'] = { label: null, since: 0 };
    storage.create(ADDRESS).chats['vk:2'] = { label: null, since: 0 };
    vk.unavailable.add('2');

    await core.onTx({ type: 'removed', address: ADDRESS, txid: 'ff'.repeat(32), net: 1000 });

    expect(tg.sent.map((s) => [s.chatId, text(s.message)])).toEqual([['1', 'уведомление для tg:1']]);
    expect(vk.sent).toEqual([]);
    expect(storage.isSubscribed(ADDRESS, 'tg:1')).toBe(true);
    expect(storage.isSubscribed(ADDRESS, 'vk:2')).toBe(false);
  });

  it('ограничение доступа действует отдельно для каждой платформы', async () => {
    config.allowedVkUserIds.add('999');
    const vkCalls = await vk.emit({ kind: 'text', text: '/start' });
    expect(text(vkCalls.replies[0])).toContain('Нет доступа');

    const tgCalls = await tg.emit({ kind: 'text', text: '/start' });
    expect(text(tgCalls.replies[0])).toContain('Бот следит');
  });

  it('устаревшая кнопка отвечает всплывающим сообщением', async () => {
    const { actions } = await vk.emit({ kind: 'action', data: 'chk:нет-такого' });
    expect(actions[0]).toEqual({ text: 'Кнопка устарела — отправьте адрес заново', alert: true });
  });
});
