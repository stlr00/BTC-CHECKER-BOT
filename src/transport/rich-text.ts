/**
 * Платформонезависимая разметка сообщений. Ядро бота собирает текст из сегментов, а каждый
 * транспорт сам решает, как их показать: Telegram — HTML, VK — плоский текст.
 */
export type TextStyle = 'bold' | 'italic' | 'code';

export interface Segment {
  text: string;
  style?: TextStyle;
  url?: string;
  /**
   * Текст ссылки — лишь короткая запись её адреса (сокращённый txid, номер блока).
   * Там, где ссылку на словах не сделать (VK), достаточно показать сам адрес.
   */
  compact?: boolean;
}

export type RichText = Segment[];

export type RichPart = string | number | Segment | RichText | null | undefined | false;

function toSegments(part: RichPart): RichText {
  if (part === null || part === undefined || part === false) return [];
  if (typeof part === 'string' || typeof part === 'number') return [{ text: String(part) }];
  return Array.isArray(part) ? part : [part];
}

/** Склеивает части в RichText; пустые части (null / false) пропускаются. */
export function rich(...parts: RichPart[]): RichText {
  return parts.flatMap(toSegments).filter((s) => s.text !== '');
}

/** Шаблонная строка: rt`Баланс: ${b(sum)}`. */
export function rt(strings: TemplateStringsArray, ...values: RichPart[]): RichText {
  return rich(...strings.flatMap((s, i) => (i < values.length ? [s, values[i]] : [s])));
}

/** Строки через перевод строки. null / undefined / false — строки нет вовсе; '' — пустая строка. */
export function lines(...items: RichPart[]): RichText {
  const present = items.filter((item) => item !== null && item !== undefined && item !== false);
  return rich(...present.flatMap((item, n) => (n ? ['\n', item] : [item])));
}

const styled = (style: TextStyle) => (part: RichPart) =>
  toSegments(part).map((s) => (s.style ? s : { ...s, style }));

export const b = styled('bold');
export const i = styled('italic');
export const code = styled('code');

export function link(text: RichPart, url: string, { compact = false } = {}): RichText {
  return toSegments(text).map((s) => ({ ...s, url, ...(compact ? { compact } : {}) }));
}

/** Текст без разметки — для логов и тестов. */
export function plainText(text: RichText): string {
  return text.map((s) => s.text).join('');
}
