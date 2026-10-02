import { beforeEach, describe, expect, it, vi, type Mocked } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AppConfig } from '../config/app.config.js';
import { MempoolApiError, MempoolApiService } from '../mempool/mempool-api.service.js';
import { MempoolSocketService } from '../mempool/mempool-socket.service.js';
import type { Tx } from '../mempool/mempool.types.js';
import { StorageService } from '../storage/storage.service.js';
import { WATCHER_TX_EVENT, type WatcherTxEvent } from './watcher.events.js';
import { WatcherService } from './watcher.service.js';

const ME = 'bc1qme000000000000000000000000000000000';
const OTHER = 'bc1qother0000000000000000000000000000000';
const CHAT = 'tg:42';

function tx(txid: string, { value = 10_000, confirmed = false, height = 0, incoming = true } = {}): Tx {
  const mine = { scriptpubkey_address: ME, value };
  const other = { scriptpubkey_address: OTHER, value };
  return {
    txid,
    vin: [{ txid: 'prev', vout: 0, sequence: 0xfffffffd, prevout: incoming ? other : mine }],
    vout: [incoming ? mine : other],
    weight: 560,
    size: 140,
    fee: 280,
    status: confirmed ? { confirmed: true, block_height: height, block_time: 1_700_000_000 } : { confirmed: false },
  };
}

describe('WatcherService', () => {
  let chain: Tx[];
  let api: Mocked<Pick<MempoolApiService, 'addressTxs' | 'tx'>>;
  let storage: StorageService;
  let events: WatcherTxEvent[];
  let watcher: WatcherService;

  beforeEach(() => {
    chain = [];
    api = {
      addressTxs: vi.fn(async (_address: string) => structuredClone(chain)),
      tx: vi.fn(async (txid: string) => {
        const found = chain.find((t) => t.txid === txid);
        if (!found) throw new MempoolApiError(404, 'not found');
        return structuredClone(found);
      }),
    };
    const config = { pollIntervalMs: 60_000, dataFile: '/dev/null' } as AppConfig;
    storage = new StorageService(config);
    vi.spyOn(storage, 'save').mockImplementation(() => undefined);
    const socket = { setAddresses: vi.fn(), start: vi.fn() } as unknown as MempoolSocketService;
    const emitter = new EventEmitter2();
    events = [];
    emitter.on(WATCHER_TX_EVENT, (e: WatcherTxEvent) => events.push(e));
    watcher = new WatcherService(config, api as unknown as MempoolApiService, socket, storage, emitter);
  });

  it('не уведомляет о транзакциях, существовавших до подписки', async () => {
    chain = [tx('old', { confirmed: true, height: 100 })];
    await watcher.subscribe(CHAT, ME);
    await watcher.checkAddress(ME);
    expect(events).toEqual([]);
  });

  it('уведомляет о новой транзакции в мемпуле, а затем о первом подтверждении', async () => {
    await watcher.subscribe(CHAT, ME);

    chain = [tx('a')];
    await watcher.checkAddress(ME);
    expect(events).toMatchObject([{ type: 'new', net: 10_000, tx: { txid: 'a', status: { confirmed: false } } }]);

    await watcher.checkAddress(ME);
    expect(events).toHaveLength(1);

    chain = [tx('a', { confirmed: true, height: 101 })];
    await watcher.checkAddress(ME);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'confirmed', tx: { txid: 'a' } });

    await watcher.checkAddress(ME);
    expect(events).toHaveLength(2);
  });

  it('считает исходящую транзакцию отрицательной суммой', async () => {
    await watcher.subscribe(CHAT, ME);
    chain = [tx('out', { incoming: false, value: 5_000 })];
    await watcher.checkAddress(ME);
    expect(events[0]).toMatchObject({ type: 'new', net: -5_000 });
  });

  it('сообщает о транзакции, сразу попавшей в блок', async () => {
    await watcher.subscribe(CHAT, ME);
    chain = [tx('b', { confirmed: true, height: 200 })];
    await watcher.checkAddress(ME);
    expect(events).toMatchObject([{ type: 'new', tx: { status: { confirmed: true } } }]);
  });

  it('отслеживает до подтверждения неподтверждённые транзакции, бывшие на момент подписки', async () => {
    chain = [tx('p')];
    const { pending } = await watcher.subscribe(CHAT, ME);
    expect(pending).toBe(1);

    chain = [tx('p', { confirmed: true, height: 300 })];
    await watcher.checkAddress(ME);
    expect(events).toMatchObject([{ type: 'confirmed', tx: { txid: 'p' } }]);
  });

  it('сообщает об исчезновении неподтверждённой транзакции из мемпула', async () => {
    await watcher.subscribe(CHAT, ME);
    chain = [tx('rbf')];
    await watcher.checkAddress(ME);

    chain = [];
    await watcher.checkAddress(ME);
    expect(events[1]).toEqual({ type: 'removed', address: ME, txid: 'rbf', net: 10_000 });
    expect(storage.get(ME)!.txs.rbf).toBeUndefined();
  });

  it('схлопывает параллельные проверки одного адреса', async () => {
    await watcher.subscribe(CHAT, ME);
    api.addressTxs.mockClear();
    chain = [tx('c')];
    await Promise.all([watcher.checkAddress(ME), watcher.checkAddress(ME), watcher.checkAddress(ME)]);
    expect(api.addressTxs.mock.calls.length).toBeLessThanOrEqual(2);
    expect(events).toHaveLength(1);
  });

  it('удаляет адрес из хранилища после отписки последнего чата', async () => {
    await watcher.subscribe(CHAT, ME);
    await watcher.subscribe('vk:7', ME);
    expect(watcher.unsubscribe(CHAT, ME)).toBe(true);
    expect(storage.get(ME)).toBeDefined();
    watcher.unsubscribe('vk:7', ME);
    expect(storage.get(ME)).toBeUndefined();
  });
});
