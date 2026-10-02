import { Inject, Injectable } from '@nestjs/common';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { MempoolApiService } from '../mempool/mempool-api.service.js';
import type { RecommendedFees } from '../mempool/mempool.types.js';
import { PricesService, type Prices } from '../prices/prices.service.js';
import { StorageService, type ChatKey } from '../storage/storage.service.js';
import { b, code, i, lines, link, rt, type RichPart, type RichText } from '../transport/rich-text.js';
import { netForAddress } from '../watcher/net.js';
import type { WatcherTxEvent } from '../watcher/watcher.events.js';
import { WatcherService } from '../watcher/watcher.service.js';
import {
  ago,
  btc,
  confirmations,
  duration,
  feeRate,
  formatTime,
  money,
  num,
  plural,
  shortAddress,
  shortHash,
} from './format.js';

const SLOW_BLOCK_MS = 30 * 60_000;

/** Тексты сообщений бота в платформонезависимой разметке (RichText). */
@Injectable()
export class MessagesService {
  private readonly web: string;

  constructor(
    @Inject(appConfig.KEY) config: AppConfig,
    private readonly api: MempoolApiService,
    private readonly prices: PricesService,
    private readonly storage: StorageService,
    private readonly watcher: WatcherService,
  ) {
    this.web = config.mempoolUrl;
  }

  private txLink(txid: string): RichText {
    return link(shortHash(txid), `${this.web}/tx/${txid}`, { compact: true });
  }

  private addressLink(address: string, text = shortAddress(address)): RichText {
    return link(text, `${this.web}/address/${address}`, { compact: true });
  }

  private blockLink(height: number | undefined): RichPart {
    return height ? link(`#${num(height)}`, `${this.web}/block/${height}`, { compact: true }) : '—';
  }

  private addressTitle(address: string, chat: ChatKey): RichText {
    const label = this.storage.labelOf(address, chat);
    return label ? rt`${b(label)} · ${this.addressLink(address)}` : this.addressLink(address, address);
  }

  /** Сумма в валютах, выбранных в настройках чата; short — только основная валюта (для списков). */
  private money(chat: ChatKey, sats: number, prices: Prices, { sign = false, short = false } = {}): string {
    const settings = this.storage.settingsOf(chat);
    return money(sats, prices, { sign, currency: settings.currency, showOthers: short ? false : settings.showOthers });
  }

  private time(chat: ChatKey, unixSeconds: number): string {
    return formatTime(unixSeconds, this.storage.settingsOf(chat).timeZone);
  }

  private direction(net: number): string {
    if (net > 0) return '📥 Входящая транзакция';
    if (net < 0) return '📤 Исходящая транзакция';
    return '🔁 Транзакция';
  }

  async notification(event: WatcherTxEvent, chat: ChatKey): Promise<RichText> {
    const amount = this.money(chat, event.net, await this.prices.get(), { sign: true });
    const who = this.addressTitle(event.address, chat);

    if (event.type === 'removed') {
      return lines(
        b('⚠️ Транзакция исчезла из мемпула'),
        'Скорее всего, её заменили (RBF) или вытеснили из-за низкой комиссии.',
        '',
        rt`Адрес: ${who}`,
        `Сумма была: ${amount}`,
        rt`Tx: ${code(event.txid)}`,
      );
    }

    const { tx } = event;
    if (event.type === 'confirmed') {
      return lines(
        b('✅ 1 подтверждение'),
        this.direction(event.net),
        '',
        rt`Адрес: ${who}`,
        rt`Сумма: ${b(amount)}`,
        rt`Блок: ${this.blockLink(tx.status.block_height)} · ${this.time(chat, tx.status.block_time ?? 0)}`,
        rt`Tx: ${this.txLink(tx.txid)}`,
      );
    }

    const rate = feeRate(tx);
    const status = tx.status.confirmed
      ? rt`✅ Сразу попала в блок ${this.blockLink(tx.status.block_height)} (1 подтверждение)`
      : '⏳ В мемпуле, 0 подтверждений';
    return lines(
      b(this.direction(event.net)),
      status,
      '',
      rt`Адрес: ${who}`,
      rt`Сумма: ${b(amount)}`,
      `Комиссия: ${num(tx.fee)} sat${rate ? ` (${rate} sat/vB)` : ''}`,
      rt`Tx: ${this.txLink(tx.txid)}`,
    );
  }

  async addressReport(address: string, chat: ChatKey): Promise<RichText> {
    const [info, txs, tip, prices] = await Promise.all([
      this.api.address(address),
      this.api.addressTxs(address),
      this.api.tipHeight(),
      this.prices.get(),
    ]);
    const chain = info.chain_stats;
    const mem = info.mempool_stats;
    const balance = chain.funded_txo_sum - chain.spent_txo_sum;
    const pending = mem.funded_txo_sum - mem.spent_txo_sum;

    const out: RichPart[] = [rt`💼 ${this.addressTitle(address, chat)}`, '', rt`Баланс: ${b(this.money(chat, balance, prices))}`];
    if (mem.tx_count) {
      out.push(
        `Неподтверждённые: ${this.money(chat, pending, prices, { sign: true })} (${mem.tx_count} tx)`,
        `С учётом мемпула: ${this.money(chat, balance + pending, prices)}`,
      );
    }
    out.push(
      `Получено всего: ${btc(chain.funded_txo_sum)}`,
      `Отправлено всего: ${btc(chain.spent_txo_sum)}`,
      `Транзакций: ${num(chain.tx_count + mem.tx_count)}`,
      `Подписка: ${this.storage.isSubscribed(address, chat) ? '🔔 включена' : '🔕 нет'}`,
    );

    if (txs.length) {
      out.push('', b('Последние транзакции:'));
      for (const tx of txs.slice(0, 5)) {
        const { net } = netForAddress(tx, address);
        const when = tx.status.confirmed
          ? `${num(confirmations(tx, tip))} подтв., ${ago(tx.status.block_time ?? 0)}`
          : 'в мемпуле';
        const amount = this.money(chat, net, prices, { sign: true, short: true });
        out.push(rt`${tx.status.confirmed ? '✅' : '⏳'} ${amount} · ${when} · ${this.txLink(tx.txid)}`);
      }
    }
    return lines(...out);
  }

  async txReport(txid: string, chat: ChatKey): Promise<RichText> {
    const [tx, tip, prices] = await Promise.all([this.api.tx(txid), this.api.tipHeight(), this.prices.get()]);
    const total = tx.vout.reduce((sum, o) => sum + o.value, 0);
    const rate = feeRate(tx);
    const out: RichPart[] = [rt`🧾 ${b('Транзакция')} ${this.txLink(tx.txid)}`, code(tx.txid), ''];

    if (tx.status.confirmed) {
      const conf = confirmations(tx, tip);
      out.push(
        rt`Статус: ✅ ${b(`${num(conf)} ${plural(conf, 'подтверждение', 'подтверждения', 'подтверждений')}`)}`,
        rt`Блок: ${this.blockLink(tx.status.block_height)}, ${ago(tx.status.block_time ?? 0)}`,
        `Время блока: ${this.time(chat, tx.status.block_time ?? 0)}`,
      );
    } else {
      const rbf = tx.vin.some((input) => input.sequence < 0xfffffffe);
      out.push(rt`Статус: ⏳ ${b('в мемпуле')}, 0 подтверждений`, `RBF: ${rbf ? 'да (может быть заменена)' : 'нет'}`);
      const fees = await this.api.recommendedFees().catch(() => null);
      if (fees) {
        out.push(`Рекомендуемые сейчас: ${fees.fastestFee} / ${fees.halfHourFee} / ${fees.hourFee} sat/vB (быстро / 30 мин / 1 ч)`);
        if (rate) out.push(`Прогноз: ${this.eta(Number(rate), fees)}`);
      }
    }

    out.push(
      '',
      `Сумма выходов: ${this.money(chat, total, prices)}`,
      `Комиссия: ${num(tx.fee)} sat${rate ? ` (${rate} sat/vB)` : ''}`,
      `Входов / выходов: ${tx.vin.length} / ${tx.vout.length}`,
      `Размер: ${num(Math.ceil(tx.weight / 4))} vB`,
    );

    const mine = this.storage
      .addressesOf(chat)
      .map((sub) => ({ ...sub, ...netForAddress(tx, sub.address) }))
      .filter((sub) => sub.received || sub.sent);
    if (mine.length) {
      out.push('', b('Ваши адреса в этой транзакции:'));
      for (const sub of mine) {
        out.push(`${this.money(chat, sub.net, prices, { sign: true })} · ${sub.label ?? shortAddress(sub.address)}`);
      }
    }
    return lines(...out);
  }

  private eta(rate: number, fees: RecommendedFees): string {
    if (rate >= fees.fastestFee) return '🚀 скорее всего, в ближайшем блоке';
    if (rate >= fees.halfHourFee) return '🕐 примерно в течение 30 минут';
    if (rate >= fees.hourFee) return '🕑 примерно в течение часа';
    return '🐢 комиссия ниже рекомендуемой, ожидание может быть долгим';
  }

  async summaryReport(chat: ChatKey): Promise<RichText> {
    const subs = this.storage.addressesOf(chat);
    const prices = await this.prices.get();
    const out: RichPart[] = [b('📊 Балансы подписанных адресов'), ''];
    let total = 0;
    for (const { address, label } of subs) {
      const info = await this.api.address(address);
      const balance = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
      const pending = info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum;
      total += balance;
      const name = label ? b(label) : this.addressLink(address);
      out.push(rt`${name}: ${this.money(chat, balance, prices)}`);
      if (pending) out.push(`    ⏳ ${this.money(chat, pending, prices, { sign: true, short: true })}`);
    }
    out.push('', rt`Итого: ${b(this.money(chat, total, prices))}`);
    return lines(...out);
  }

  async blockReport(chat: ChatKey): Promise<RichText> {
    const blocks = await this.api.recentBlocks();
    const [block] = blocks;
    const oldest = blocks[blocks.length - 1];
    const sinceMs = Date.now() - block.timestamp * 1000;
    const avgMs = blocks.length > 1 ? ((block.timestamp - oldest.timestamp) * 1000) / (blocks.length - 1) : null;

    const out: RichPart[] = [
      rt`⛏ ${b('Последний блок')} ${this.blockLink(block.height)}`,
      '',
      rt`Прошло с момента добычи: ${b(sinceMs > 0 ? duration(sinceMs) : 'только что')}`,
      `Время блока: ${this.time(chat, block.timestamp)}`,
    ];
    const seen = this.watcher.lastBlock;
    if (seen?.height === block.height) out.push(`Бот узнал о блоке: ${duration(Date.now() - seen.receivedAt)} назад`);
    if (block.extras?.pool?.name) out.push(`Майнер: ${block.extras.pool.name}`);
    out.push(`Транзакций: ${num(block.tx_count)} · ${(block.size / 1e6).toFixed(2)} MB`);
    if (block.extras?.medianFee) out.push(`Медианная комиссия: ${block.extras.medianFee.toFixed(1)} sat/vB`);
    if (avgMs) out.push(`Средний интервал (последние ${blocks.length}): ${duration(avgMs)}`);
    if (sinceMs > SLOW_BLOCK_MS) {
      out.push('', `🐌 Блока нет дольше ${duration(SLOW_BLOCK_MS)} — такое бывает, блоки находятся случайно.`);
    }
    out.push('', i('Метку времени ставит майнер, она может отличаться от реальной на несколько минут.'));
    return lines(...out);
  }
}
