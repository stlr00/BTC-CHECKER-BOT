import { Inject, Injectable, Logger } from '@nestjs/common';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { MempoolApiService } from '../mempool/mempool-api.service.js';

/** Цена 1 BTC в фиатных валютах; null — курс сейчас недоступен. */
export interface Prices {
  usd: number | null;
  rub: number | null;
}

const RUB_TTL_MS = 60 * 60_000;
const RUB_RETRY_MS = 5 * 60_000;

/**
 * mempool.space не отдаёт курс рубля, поэтому BTC/RUB = BTC/USD (mempool) × USD/RUB (ЦБ РФ).
 * Курс ЦБ меняется раз в сутки, кешируем его на час.
 */
@Injectable()
export class PricesService {
  private readonly logger = new Logger(PricesService.name);
  private usdRub: { value: number | null; expiresAt: number } = { value: null, expiresAt: 0 };

  constructor(
    @Inject(appConfig.KEY) private readonly config: AppConfig,
    private readonly api: MempoolApiService,
  ) {}

  async get(): Promise<Prices> {
    const [usd, usdRub] = await Promise.all([this.api.usdPrice(), this.usdRubRate()]);
    return { usd, rub: usd && usdRub ? usd * usdRub : null };
  }

  private async usdRubRate(): Promise<number | null> {
    if (Date.now() < this.usdRub.expiresAt) return this.usdRub.value;
    try {
      const res = await fetch(this.config.rubRateUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { Valute?: { USD?: { Value: number; Nominal: number } } };
      const usd = data.Valute?.USD;
      if (!usd?.Value) throw new Error('в ответе нет курса USD');
      this.usdRub = { value: usd.Value / (usd.Nominal || 1), expiresAt: Date.now() + RUB_TTL_MS };
    } catch (err) {
      this.logger.warn(`Не удалось получить курс USD/RUB: ${(err as Error).message}`);
      // оставляем последнее известное значение и пробуем снова через несколько минут
      this.usdRub = { value: this.usdRub.value, expiresAt: Date.now() + RUB_RETRY_MS };
    }
    return this.usdRub.value;
  }
}
