import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appConfig, type AppConfig } from '../config/app.config.js';

export interface ChatSubscription {
  label: string | null;
  since: number;
}

export interface TrackedTx {
  confirmed: boolean;
  height: number | null;
  /** Изменение баланса адреса в сатоши */
  net: number;
}

export interface AddressRecord {
  chats: Record<string, ChatSubscription>;
  txs: Record<string, TrackedTx>;
}

export type Currency = 'btc' | 'usd' | 'rub';
export type TimeZone = 'utc' | 'kaliningrad' | 'moscow';

/** Настройки отображения для чата */
export interface ChatSettings {
  /** Основная валюта: показывается первой */
  currency: Currency;
  /** Показывать ли остальные валюты после основной */
  showOthers: boolean;
  /** Часовой пояс для отображения времени */
  timeZone: TimeZone;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { currency: 'btc', showOthers: true, timeZone: 'utc' };

/**
 * Ключ чата: `<транспорт>:<id>`, например `tg:123456` или `vk:2000000001`.
 * Пространства ID у Telegram и VK пересекаются, поэтому без префикса нельзя.
 */
export type ChatKey = string;

interface State {
  version: 2;
  addresses: Record<string, AddressRecord>;
  chats: Record<ChatKey, Partial<ChatSettings>>;
}

const prefixed = (key: string) => (key.includes(':') ? key : `tg:${key}`);
const prefixKeys = <T>(record: Record<string, T> = {}) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [prefixed(key), value]));

/**
 * v1 → v2: до появления VK ключами чатов были голые Telegram ID. Добавляем им префикс `tg:`.
 * Возвращает null, если миграция не нужна.
 */
export function migrateState(raw: { version?: number } & Partial<Omit<State, 'version'>>): State | null {
  if (raw.version === 2) return null;
  const addresses: Record<string, AddressRecord> = {};
  for (const [address, rec] of Object.entries(raw.addresses ?? {})) {
    addresses[address] = { ...rec, chats: prefixKeys(rec.chats) };
  }
  return { version: 2, addresses, chats: prefixKeys(raw.chats) };
}

/** Подписки и известные транзакции в JSON-файле (атомарная запись через tmp + rename). */
@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  private readonly file: string;
  private state: State = { version: 2, addresses: {}, chats: {} };
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  constructor(@Inject(appConfig.KEY) config: AppConfig) {
    this.file = config.dataFile;
  }

  async onModuleInit(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'));
      const migrated = migrateState(raw);
      if (migrated) {
        const backup = this.file.replace(/(\.json)?$/, `.v${raw.version ?? 1}.json`);
        await copyFile(this.file, backup);
        this.state = migrated;
        await this.flush();
        this.logger.log(`Состояние обновлено до версии 2, копия старого: ${backup}`);
      } else {
        this.state = raw;
      }
      this.state.addresses ??= {};
      this.state.chats ??= {};
      this.logger.log(`Загружено адресов: ${this.addresses.length}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  onApplicationShutdown(): Promise<void> {
    return this.flush();
  }

  get addresses(): string[] {
    return Object.keys(this.state.addresses);
  }

  get(address: string): AddressRecord | undefined {
    return this.state.addresses[address];
  }

  create(address: string): AddressRecord {
    return (this.state.addresses[address] ??= { chats: {}, txs: {} });
  }

  remove(address: string): void {
    delete this.state.addresses[address];
  }

  settingsOf(chat: ChatKey): ChatSettings {
    return { ...DEFAULT_CHAT_SETTINGS, ...this.state.chats[chat] };
  }

  updateSettings(chat: ChatKey, patch: Partial<ChatSettings>): ChatSettings {
    this.state.chats[chat] = { ...this.state.chats[chat], ...patch };
    this.save();
    return this.settingsOf(chat);
  }

  addressesOf(chat: ChatKey): { address: string; label: string | null }[] {
    return Object.entries(this.state.addresses)
      .filter(([, rec]) => rec.chats[chat])
      .map(([address, rec]) => ({ address, label: rec.chats[chat].label }));
  }

  chatsOf(address: string): ChatKey[] {
    return Object.keys(this.get(address)?.chats ?? {});
  }

  labelOf(address: string, chat: ChatKey): string | null {
    return this.get(address)?.chats[chat]?.label ?? null;
  }

  isSubscribed(address: string, chat: ChatKey): boolean {
    return Boolean(this.get(address)?.chats[chat]);
  }

  /** Отложенная запись: серия изменений даёт одну запись на диск. */
  save(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 500);
  }

  flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saving = this.saving
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        await writeFile(tmp, snapshot);
        await rename(tmp, this.file);
      })
      .catch((err: Error) => this.logger.error(`Не удалось сохранить состояние: ${err.message}`));
    return this.saving;
  }
}
