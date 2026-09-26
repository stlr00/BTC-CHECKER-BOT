import { Inject, Injectable } from '@nestjs/common';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { MempoolApiService } from '../mempool/mempool-api.service.js';
import type { RecommendedFees } from '../mempool/mempool.types.js';
import { PricesService, type Prices } from '../prices/prices.service.js';
import { StorageService } from '../storage/storage.service.js';
import { netForAddress } from '../watcher/net.js';
import type { WatcherTxEvent } from '../watcher/watcher.events.js';
import { WatcherService } from '../watcher/watcher.service.js';
import {
  ago,
  btc,
  confirmations,
  duration,
  escapeHtml,
  feeRate,
  formatTime,
  num,
  plural,
  shortAddress,
  money,
  shortHash,
} from './format.js';

const SLOW_BLOCK_MS = 30 * 60_000;

/** Тексты сообщений бота (HTML parse mode). */
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

  private txLink(txid: string): string {
    return `<a href="${this.web}/tx/${txid}">${shortHash(txid)}</a>`;
  }

  private addressLink(address: string, text = shortAddress(address)): string {
    return `<a href="${this.web}/address/${address}">${escapeHtml(text)}</a>`;
  }

  private blockLink(height: number | undefined): string {
    return height ? `<a href="${this.web}/block/${height}">#${num(height)}</a>` : '—';
  }

  private addressTitle(address: string, chatId: number): string {
    const label = this.storage.labelOf(address, chatId);
    return label ? `<b>${escapeHtml(label)}</b> · ${this.addressLink(address)}` : this.addressLink(address, address);
  }

  /** Сумма в валютах, выбранных в настройках чата; short — только основная валюта (для списков). */
  private money(chatId: number, sats: number, prices: Prices, { sign = false, short = false } = {}): string {
    const settings = this.storage.settingsOf(chatId);
    return money(sats, prices, { sign, currency: settings.currency, showOthers: short ? false : settings.showOthers });
  }

  private time(chatId: number, unixSeconds: number): string {
    return formatTime(unixSeconds, this.storage.settingsOf(chatId).timeZone);
  }

  private direction(net: number): string {
    if (net > 0) return '📥 Входящая транзакция';
    if (net < 0) return '📤 Исходящая транзакция';
    return '🔁 Транзакция';
  }

  async notification(event: WatcherTxEvent, chatId: number): Promise<string> {
    const amount = this.money(chatId, event.net, await this.prices.get(), { sign: true });
    const who = this.addressTitle(event.address, chatId);

    if (event.type === 'removed') {
      return [
        '⚠️ <b>Транзакция исчезла из мемпула</b>',
        'Скорее всего, её заменили (RBF) или вытеснили из-за низкой комиссии.',
        '',
        `Адрес: ${who}`,
        `Сумма была: ${amount}`,
        `Tx: <code>${event.txid}</code>`,
      ].join('\n');
    }

    const { tx } = event;
    if (event.type === 'confirmed') {
      return [
        '✅ <b>1 подтверждение</b>',
        this.direction(event.net),
        '',
        `Адрес: ${who}`,
        `Сумма: <b>${amount}</b>`,
        `Блок: ${this.blockLink(tx.status.block_height)} · ${this.time(chatId, tx.status.block_time ?? 0)}`,
        `Tx: ${this.txLink(tx.txid)}`,
      ].join('\n');
    }

    const rate = feeRate(tx);
    const status = tx.status.confirmed
      ? `✅ Сразу попала в блок ${this.blockLink(tx.status.block_height)} (1 подтверждение)`
      : '⏳ В мемпуле, 0 подтверждений';
    return [
      `<b>${this.direction(event.net)}</b>`,
      status,
      '',
      `Адрес: ${who}`,
      `Сумма: <b>${amount}</b>`,
      `Комиссия: ${num(tx.fee)} sat${rate ? ` (${rate} sat/vB)` : ''}`,
      `Tx: ${this.txLink(tx.txid)}`,
    ].join('\n');
  }

  async addressReport(address: string, chatId: number): Promise<string> {
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
    const subscribed = Boolean(this.storage.get(address)?.chats[chatId]);

    const lines = [`💼 ${this.addressTitle(address, chatId)}`, '', `Баланс: <b>${this.money(chatId, balance, prices)}</b>`];
    if (mem.tx_count) {
      lines.push(
        `Неподтверждённые: ${this.money(chatId, pending, prices, { sign: true })} (${mem.tx_count} tx)`,
        `С учётом мемпула: ${this.money(chatId, balance + pending, prices)}`,
      );
    }
    lines.push(
      `Получено всего: ${btc(chain.funded_txo_sum)}`,
      `Отправлено всего: ${btc(chain.spent_txo_sum)}`,
      `Транзакций: ${num(chain.tx_count + mem.tx_count)}`,
      `Подписка: ${subscribed ? '🔔 включена' : '🔕 нет'}`,
    );

    if (txs.length) {
      lines.push('', '<b>Последние транзакции:</b>');
      for (const tx of txs.slice(0, 5)) {
        const { net } = netForAddress(tx, address);
        const when = tx.status.confirmed
          ? `${num(confirmations(tx, tip))} подтв., ${ago(tx.status.block_time ?? 0)}`
          : 'в мемпуле';
        lines.push(`${tx.status.confirmed ? '✅' : '⏳'} ${this.money(chatId, net, prices, { sign: true, short: true })} · ${when} · ${this.txLink(tx.txid)}`);
      }
    }
    return lines.join('\n');
  }

  async txReport(txid: string, chatId: number): Promise<string> {
    const [tx, tip, prices] = await Promise.all([this.api.tx(txid), this.api.tipHeight(), this.prices.get()]);
    const total = tx.vout.reduce((sum, out) => sum + out.value, 0);
    const rate = feeRate(tx);
    const lines = [`🧾 <b>Транзакция</b> ${this.txLink(tx.txid)}`, `<code>${tx.txid}</code>`, ''];

    if (tx.status.confirmed) {
      const conf = confirmations(tx, tip);
      lines.push(
        `Статус: ✅ <b>${num(conf)} ${plural(conf, 'подтверждение', 'подтверждения', 'подтверждений')}</b>`,
        `Блок: ${this.blockLink(tx.status.block_height)}, ${ago(tx.status.block_time ?? 0)}`,
        `Время блока: ${this.time(chatId, tx.status.block_time ?? 0)}`,
      );
    } else {
      const rbf = tx.vin.some((input) => input.sequence < 0xfffffffe);
      lines.push('Статус: ⏳ <b>в мемпуле</b>, 0 подтверждений', `RBF: ${rbf ? 'да (может быть заменена)' : 'нет'}`);
      const fees = await this.api.recommendedFees().catch(() => null);
      if (fees) {
        lines.push(`Рекомендуемые сейчас: ${fees.fastestFee} / ${fees.halfHourFee} / ${fees.hourFee} sat/vB (быстро / 30 мин / 1 ч)`);
        if (rate) lines.push(`Прогноз: ${this.eta(Number(rate), fees)}`);
      }
    }

    lines.push(
      '',
      `Сумма выходов: ${this.money(chatId, total, prices)}`,
      `Комиссия: ${num(tx.fee)} sat${rate ? ` (${rate} sat/vB)` : ''}`,
      `Входов / выходов: ${tx.vin.length} / ${tx.vout.length}`,
      `Размер: ${num(Math.ceil(tx.weight / 4))} vB`,
    );

    const mine = this.storage
      .addressesOf(chatId)
      .map((sub) => ({ ...sub, ...netForAddress(tx, sub.address) }))
      .filter((sub) => sub.received || sub.sent);
    if (mine.length) {
      lines.push('', '<b>Ваши адреса в этой транзакции:</b>');
      for (const sub of mine) {
        lines.push(`${this.money(chatId, sub.net, prices, { sign: true })} · ${sub.label ? escapeHtml(sub.label) : shortAddress(sub.address)}`);
      }
    }
    return lines.join('\n');
  }

  private eta(rate: number, fees: RecommendedFees): string {
    if (rate >= fees.fastestFee) return '🚀 скорее всего, в ближайшем блоке';
    if (rate >= fees.halfHourFee) return '🕐 примерно в течение 30 минут';
    if (rate >= fees.hourFee) return '🕑 примерно в течение часа';
    return '🐢 комиссия ниже рекомендуемой, ожидание может быть долгим';
  }

  async summaryReport(chatId: number): Promise<string> {
    const subs = this.storage.addressesOf(chatId);
    const prices = await this.prices.get();
    const lines = ['📊 <b>Балансы подписанных адресов</b>', ''];
    let total = 0;
    for (const { address, label } of subs) {
      const info = await this.api.address(address);
      const balance = info.chain_stats.funded_txo_sum - info.chain_stats.spent_txo_sum;
      const pending = info.mempool_stats.funded_txo_sum - info.mempool_stats.spent_txo_sum;
      total += balance;
      const name = label ? `<b>${escapeHtml(label)}</b>` : this.addressLink(address);
      lines.push(`${name}: ${this.money(chatId, balance, prices)}${pending ? `\n    ⏳ ${this.money(chatId, pending, prices, { sign: true, short: true })}` : ''}`);
    }
    lines.push('', `Итого: <b>${this.money(chatId, total, prices)}</b>`);
    return lines.join('\n');
  }

  async blockReport(chatId: number): Promise<string> {
    const blocks = await this.api.recentBlocks();
    const [block] = blocks;
    const oldest = blocks[blocks.length - 1];
    const sinceMs = Date.now() - block.timestamp * 1000;
    const avgMs = blocks.length > 1 ? ((block.timestamp - oldest.timestamp) * 1000) / (blocks.length - 1) : null;

    const lines = [
      `⛏ <b>Последний блок</b> ${this.blockLink(block.height)}`,
      '',
      `Прошло с момента добычи: <b>${sinceMs > 0 ? duration(sinceMs) : 'только что'}</b>`,
      `Время блока: ${this.time(chatId, block.timestamp)}`,
    ];
    const seen = this.watcher.lastBlock;
    if (seen?.height === block.height) {
      lines.push(`Бот узнал о блоке: ${duration(Date.now() - seen.receivedAt)} назад`);
    }
    if (block.extras?.pool?.name) lines.push(`Майнер: ${escapeHtml(block.extras.pool.name)}`);
    lines.push(`Транзакций: ${num(block.tx_count)} · ${(block.size / 1e6).toFixed(2)} MB`);
    if (block.extras?.medianFee) lines.push(`Медианная комиссия: ${block.extras.medianFee.toFixed(1)} sat/vB`);
    if (avgMs) lines.push(`Средний интервал (последние ${blocks.length}): ${duration(avgMs)}`);
    if (sinceMs > SLOW_BLOCK_MS) {
      lines.push('', `🐌 Блока нет дольше ${duration(SLOW_BLOCK_MS)} — такое бывает, блоки находятся случайно.`);
    }
    lines.push('', '<i>Метку времени ставит майнер, она может отличаться от реальной на несколько минут.</i>');
    return lines.join('\n');
  }
}
