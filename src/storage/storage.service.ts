import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

/** Настройки отображения для чата */
export interface ChatSettings {
  /** Основная валюта: показывается первой */
  currency: Currency;
  /** Показывать ли остальные валюты после основной */
  showOthers: boolean;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { currency: 'btc', showOthers: true };

interface State {
  version: 1;
  addresses: Record<string, AddressRecord>;
  chats: Record<string, Partial<ChatSettings>>;
}

/** Подписки и известные транзакции в JSON-файле (атомарная запись через tmp + rename). */
@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  private readonly file: string;
  private state: State = { version: 1, addresses: {}, chats: {} };
  private saveTimer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  constructor(@Inject(appConfig.KEY) config: AppConfig) {
    this.file = config.dataFile;
  }

  async onModuleInit(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'));
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

  settingsOf(chatId: number): ChatSettings {
    return { ...DEFAULT_CHAT_SETTINGS, ...this.state.chats[chatId] };
  }

  updateSettings(chatId: number, patch: Partial<ChatSettings>): ChatSettings {
    this.state.chats[chatId] = { ...this.state.chats[chatId], ...patch };
    this.save();
    return this.settingsOf(chatId);
  }

  addressesOf(chatId: number): { address: string; label: string | null }[] {
    return Object.entries(this.state.addresses)
      .filter(([, rec]) => rec.chats[chatId])
      .map(([address, rec]) => ({ address, label: rec.chats[chatId].label }));
  }

  chatsOf(address: string): number[] {
    return Object.keys(this.get(address)?.chats ?? {}).map(Number);
  }

  labelOf(address: string, chatId: number): string | null {
    return this.get(address)?.chats[chatId]?.label ?? null;
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
