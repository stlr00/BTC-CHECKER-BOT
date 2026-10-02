import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app.config.js';
import { migrateState, StorageService } from './storage.service.js';

const v1 = {
  version: 1,
  addresses: {
    bc1qaddr: {
      chats: { '123': { label: 'Холодный', since: 1 }, 'tg:456': { label: null, since: 2 } },
      txs: { aa: { confirmed: true, height: 10, net: 5 } },
    },
  },
  chats: { '123': { currency: 'rub' as const } },
};

describe('migrateState', () => {
  it('добавляет префикс tg: к ключам чатов без префикса', () => {
    expect(migrateState(v1)).toEqual({
      version: 2,
      addresses: {
        bc1qaddr: {
          chats: { 'tg:123': { label: 'Холодный', since: 1 }, 'tg:456': { label: null, since: 2 } },
          txs: { aa: { confirmed: true, height: 10, net: 5 } },
        },
      },
      chats: { 'tg:123': { currency: 'rub' } },
    });
  });

  it('не трогает состояние версии 2', () => {
    expect(migrateState({ version: 2, addresses: {}, chats: {} })).toBeNull();
  });
});

describe('StorageService', () => {
  let dir = '';
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('при загрузке мигрирует файл v1 и сохраняет копию старого', async () => {
    dir = await mkdtemp(join(tmpdir(), 'btc-bot-'));
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify(v1));

    const storage = new StorageService({ dataFile: file } as AppConfig);
    await storage.onModuleInit();

    expect(storage.chatsOf('bc1qaddr')).toEqual(['tg:123', 'tg:456']);
    expect(storage.labelOf('bc1qaddr', 'tg:123')).toBe('Холодный');
    expect(storage.settingsOf('tg:123').currency).toBe('rub');
    expect(JSON.parse(await readFile(join(dir, 'state.v1.json'), 'utf8'))).toEqual(v1);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(2);
  });
});
