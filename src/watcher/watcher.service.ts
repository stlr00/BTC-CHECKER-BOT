import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { setTimeout as sleep } from 'node:timers/promises';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { MempoolApiError, MempoolApiService } from '../mempool/mempool-api.service.js';
import { MempoolSocketService } from '../mempool/mempool-socket.service.js';
import { MempoolEvents, type Block, type Tx } from '../mempool/mempool.types.js';
import { StorageService, type ChatKey, type TrackedTx } from '../storage/storage.service.js';
import { netForAddress } from './net.js';
import { WATCHER_TX_EVENT, type WatcherTxEvent } from './watcher.events.js';

/**
 * Следит за подписанными адресами и публикует WATCHER_TX_EVENT.
 *
 * Источник истины — REST /address/:addr/txs: состояние каждой транзакции сравнивается с запомненным.
 * WebSocket-события и новые блоки лишь запускают внеочередную проверку, а периодический опрос
 * страхует на случай, если WebSocket отвалился.
 */
@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);
  private readonly inflight = new Map<string, { again: boolean; promise: Promise<void> }>();
  private pollTimer?: NodeJS.Timeout;
  private stopped = false;
  lastBlock: { height: number; timestamp: number; receivedAt: number } | null = null;

  constructor(
    @Inject(appConfig.KEY) private readonly config: AppConfig,
    private readonly api: MempoolApiService,
    private readonly socket: MempoolSocketService,
    private readonly storage: StorageService,
    private readonly events: EventEmitter2,
  ) {}

  onApplicationBootstrap(): void {
    this.syncSocket();
    this.socket.start();
    this.schedulePoll(5_000);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.pollTimer);
  }

  /**
   * Подписка чата на адрес. Текущие транзакции запоминаются без уведомлений,
   * неподтверждённые остаются под наблюдением до первого подтверждения.
   */
  async subscribe(chatId: ChatKey, address: string, label: string | null = null) {
    let rec = this.storage.get(address);
    const existed = Boolean(rec?.chats[chatId]);
    if (!rec) {
      const txs = await this.api.addressTxs(address);
      rec = this.storage.get(address) ?? this.storage.create(address);
      for (const tx of txs) rec.txs[tx.txid] ??= this.txState(tx, address);
    }
    const prev = rec.chats[chatId];
    rec.chats[chatId] = { label: label || prev?.label || null, since: prev?.since ?? Date.now() };
    this.storage.save();
    this.syncSocket();
    const pending = Object.values(rec.txs).filter((t) => !t.confirmed).length;
    return { existed, pending };
  }

  unsubscribe(chatId: ChatKey, address: string): boolean {
    const rec = this.storage.get(address);
    if (!rec?.chats[chatId]) return false;
    delete rec.chats[chatId];
    if (Object.keys(rec.chats).length === 0) this.storage.remove(address);
    this.storage.save();
    this.syncSocket();
    return true;
  }

  unsubscribeChat(chatId: ChatKey): void {
    for (const { address } of this.storage.addressesOf(chatId)) this.unsubscribe(chatId, address);
  }

  /** Проверка адреса; параллельные вызовы для одного адреса схлопываются в один повторный прогон. */
  checkAddress(address: string): Promise<void> {
    const running = this.inflight.get(address);
    if (running) {
      running.again = true;
      return running.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          await this.check(address);
        } while (entry.again);
      } finally {
        this.inflight.delete(address);
      }
    })();
    this.inflight.set(address, entry);
    return entry.promise;
  }

  @OnEvent(MempoolEvents.AddressActivity)
  onAddressActivity(addresses: string[]): void {
    for (const address of addresses) if (this.storage.get(address)) this.safeCheck(address);
  }

  @OnEvent(MempoolEvents.Connected)
  onSocketConnected(): void {
    this.syncSocket();
  }

  @OnEvent(MempoolEvents.Block, { async: true })
  async onBlock(block: Block): Promise<void> {
    this.lastBlock = { height: block.height, timestamp: block.timestamp, receivedAt: Date.now() };
    this.logger.log(`Новый блок #${block.height}`);
    // Индексатору нужно пару секунд, чтобы блок появился в REST API
    await sleep(3_000);
    for (const address of this.storage.addresses) {
      const rec = this.storage.get(address);
      if (rec && Object.values(rec.txs).some((t) => !t.confirmed)) this.safeCheck(address);
    }
  }

  private safeCheck(address: string): void {
    this.checkAddress(address).catch((err: Error) => this.logger.warn(`Проверка ${address} не удалась: ${err.message}`));
  }

  private txState(tx: Tx, address: string): TrackedTx {
    return {
      confirmed: tx.status.confirmed,
      height: tx.status.block_height ?? null,
      net: netForAddress(tx, address).net,
    };
  }

  private async check(address: string): Promise<void> {
    const rec = this.storage.get(address);
    if (!rec) return;
    const txs = await this.api.addressTxs(address);
    if (this.storage.get(address) !== rec) return; // отписались, пока ждали ответ

    const seen = new Set<string>();
    const events: WatcherTxEvent[] = [];

    // API отдаёт новые первыми; уведомляем в хронологическом порядке
    for (const tx of [...txs].reverse()) {
      seen.add(tx.txid);
      const known = rec.txs[tx.txid];
      const state = this.txState(tx, address);

      if (!known) {
        rec.txs[tx.txid] = state;
        events.push({ type: 'new', address, tx, net: state.net });
      } else if (!known.confirmed && state.confirmed) {
        Object.assign(known, state);
        events.push({ type: 'confirmed', address, tx, net: state.net });
      } else if (known.confirmed && !state.confirmed) {
        // Реорганизация: транзакция вернулась в мемпул, подтверждение придёт повторно
        Object.assign(known, state);
      }
    }

    for (const [txid, known] of Object.entries(rec.txs)) {
      if (seen.has(txid)) continue;
      if (known.confirmed) {
        // Выпала из окна последних транзакций и больше в нём не появится
        delete rec.txs[txid];
        continue;
      }
      // Неподтверждённая пропала из списка: подтвердилась за пределами окна или удалена из мемпула
      try {
        const tx = await this.api.tx(txid);
        if (tx.status.confirmed) {
          Object.assign(known, this.txState(tx, address));
          events.push({ type: 'confirmed', address, tx, net: known.net });
        }
      } catch (err) {
        if (!(err instanceof MempoolApiError) || err.status !== 404) throw err;
        delete rec.txs[txid];
        events.push({ type: 'removed', address, txid, net: known.net });
      }
    }

    this.storage.save();
    for (const event of events) this.events.emit(WATCHER_TX_EVENT, event);
  }

  private syncSocket(): void {
    this.socket.setAddresses(this.storage.addresses);
  }

  private schedulePoll(delay = this.config.pollIntervalMs): void {
    if (this.stopped) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      for (const address of this.storage.addresses) {
        if (this.stopped) return;
        try {
          await this.checkAddress(address);
        } catch (err) {
          this.logger.warn(`Опрос ${address} не удался: ${(err as Error).message}`);
        }
      }
      this.schedulePoll();
    }, delay);
  }
}
