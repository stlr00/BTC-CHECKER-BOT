import type { Tx } from '../mempool/mempool.types.js';
import type { Prices } from '../prices/prices.service.js';
import type { ChatSettings, Currency, TimeZone } from '../storage/storage.service.js';

const SATS = 100_000_000;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function btc(sats: number, { sign = false } = {}): string {
  const abs = (Math.abs(sats) / SATS).toFixed(8);
  const prefix = sats < 0 ? '−' : sign && sats > 0 ? '+' : '';
  return `${prefix}${abs} BTC`;
}

function fiat(value: number, locale: string): string {
  const digits = value < 100 ? 2 : 0;
  return value.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const CURRENCY_ORDER: readonly Currency[] = ['btc', 'usd', 'rub'];

/**
 * Сумма в валютах чата: основная первой, остальные — через «·» (если включены).
 * «+5 499 ₽ · 0.00100000 BTC · $65.20». Знак ставится только у основной валюты.
 * Если курс основной фиатной валюты недоступен, основной становится BTC.
 */
export function money(
  sats: number,
  prices: Prices,
  { sign = false, currency = 'btc', showOthers = true }: { sign?: boolean } & Partial<ChatSettings> = {},
): string {
  const coins = Math.abs(sats) / SATS;
  const prefix = sats < 0 ? '−' : sign && sats > 0 ? '+' : '';
  const format = (c: Currency): string | null => {
    if (c === 'btc') return `${coins.toFixed(8)} BTC`;
    if (c === 'usd') return prices.usd ? `$${fiat(coins * prices.usd, 'en-US')}` : null;
    return prices.rub ? `${fiat(coins * prices.rub, 'ru-RU')} ₽` : null;
  };

  const primary = format(currency) ? currency : 'btc';
  const parts = [prefix + format(primary)];
  if (showOthers) {
    for (const c of CURRENCY_ORDER) {
      const text = c === primary ? null : format(c);
      if (text) parts.push(text);
    }
  }
  return parts.join(' · ');
}

export function num(n: number): string {
  return n.toLocaleString('ru-RU');
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

export function shortAddress(address: string): string {
  return address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-8)}` : address;
}

/** «2 д 3 ч», «2 ч 5 мин», «12 мин 34 сек», «45 сек». */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин ${s} сек`;
  return `${s} сек`;
}

export function ago(unixSeconds: number): string {
  return `${duration(Date.now() - unixSeconds * 1000)} назад`;
}

export const TIME_ZONES: Record<TimeZone, { iana: string; label: string; city: string | null }> = {
  utc: { iana: 'UTC', label: 'UTC', city: null },
  kaliningrad: { iana: 'Europe/Kaliningrad', label: 'UTC+2', city: 'Калининград' },
  moscow: { iana: 'Europe/Moscow', label: 'UTC+3', city: 'Москва' },
};

export function timeZoneName(tz: TimeZone): string {
  const { label, city } = TIME_ZONES[tz];
  return city ? `${label} ${city}` : label;
}

/** «2026-09-26 08:31:07 UTC+3» в часовом поясе чата. */
export function formatTime(unixSeconds: number, tz: TimeZone = 'utc'): string {
  const { iana, label } = TIME_ZONES[tz];
  // Шведская локаль даёт ISO-подобный формат «YYYY-MM-DD HH:mm:ss»
  const text = new Intl.DateTimeFormat('sv-SE', {
    timeZone: iana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(unixSeconds * 1000));
  return `${text} ${label}`;
}

export function feeRate(tx: Tx): string | null {
  return tx.weight ? (tx.fee / (tx.weight / 4)).toFixed(1) : null;
}

export function confirmations(tx: Tx, tipHeight: number): number {
  return tx.status.confirmed && tx.status.block_height ? tipHeight - tx.status.block_height + 1 : 0;
}

export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}
