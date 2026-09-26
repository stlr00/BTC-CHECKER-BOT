import { Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { appConfig, type AppConfig } from '../config/app.config.js';
import type { AddressInfo, Block, RecommendedFees, Tx } from './mempool.types.js';

export class MempoolApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * REST-клиент mempool.space (Esplora-совместимый API).
 * Запросы идут последовательно с паузой, чтобы не упереться в rate limit публичного инстанса.
 */
@Injectable()
export class MempoolApiService {
  private readonly logger = new Logger(MempoolApiService.name);
  private readonly base: string;
  private readonly gapMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private priceCache: { at: number; value: number | null } = { at: 0, value: null };

  constructor(@Inject(appConfig.KEY) config: AppConfig) {
    this.base = config.mempoolApi.replace(/\/+$/, '');
    this.gapMs = config.requestGapMs;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    // Ошибка одного запроса не должна ломать очередь
    this.queue = run.catch(() => undefined).then(() => sleep(this.gapMs));
    return run;
  }

  private request<T>(path: string, asText = false): Promise<T> {
    return this.enqueue(async () => {
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(this.base + path, { signal: AbortSignal.timeout(15_000) });
        if (res.status === 429 && attempt < 4) {
          await sleep(2000 * attempt);
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new MempoolApiError(res.status, `${res.status} ${path}: ${body.slice(0, 200)}`);
        }
        return (asText ? res.text() : res.json()) as Promise<T>;
      }
    });
  }

  address(address: string): Promise<AddressInfo> {
    return this.request(`/address/${address}`);
  }

  /** До 50 неподтверждённых + 25 последних подтверждённых транзакций, новые первыми. */
  addressTxs(address: string): Promise<Tx[]> {
    return this.request(`/address/${address}/txs`);
  }

  tx(txid: string): Promise<Tx> {
    return this.request(`/tx/${txid}`);
  }

  async tipHeight(): Promise<number> {
    return Number(await this.request<string>('/blocks/tip/height', true));
  }

  /** Последние 15 блоков с расширенной информацией (пул, комиссии). */
  recentBlocks(): Promise<Block[]> {
    return this.request('/v1/blocks');
  }

  recommendedFees(): Promise<RecommendedFees> {
    return this.request('/v1/fees/recommended');
  }

  /** Курс BTC/USD с кешем на 5 минут. Не критичен: при ошибке — последнее известное значение или null. */
  async usdPrice(): Promise<number | null> {
    if (Date.now() - this.priceCache.at < 5 * 60_000) return this.priceCache.value;
    try {
      const prices = await this.request<{ USD?: number }>('/v1/prices');
      this.priceCache = { at: Date.now(), value: prices.USD ?? null };
    } catch (err) {
      this.logger.warn(`Не удалось получить курс: ${(err as Error).message}`);
      // повторим попытку через минуту
      this.priceCache = { at: Date.now() - 4 * 60_000, value: this.priceCache.value };
    }
    return this.priceCache.value;
  }
}
