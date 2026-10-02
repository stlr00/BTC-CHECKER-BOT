import { Keyboard } from 'vk-io';
import type { RichText } from '../rich-text.js';
import type { Button, TransportLimits } from '../transport.types.js';

/** Inline-клавиатура VK: до 6 рядов по 5 кнопок; кнопка-ссылка занимает 2 места. */
export const VK_LIMITS: TransportLimits = { maxButtonRows: 6, maxButtonsPerRow: 5, maxLabelLength: 40 };
const MAX_PAYLOAD_BYTES = 255;

/**
 * RichText → плоский текст: оформления в сообщениях сообщества VK нет. Ссылка превращается
 * в «текст (url)», а если текст — лишь краткая запись адреса (compact), остаётся сам адрес.
 */
export function renderPlain(text: RichText): string {
  let out = '';
  for (let n = 0; n < text.length; n++) {
    const segment = text[n];
    if (!segment.url) {
      out += segment.text;
      continue;
    }
    // Соседние сегменты одной ссылки (например, жирный кусок внутри) склеиваем в одну ссылку
    let label = segment.text;
    while (text[n + 1]?.url === segment.url) label += text[++n].text;
    out += segment.compact || label === segment.url ? segment.url : `${label} (${segment.url})`;
  }
  return out;
}

const truncate = (label: string, max: number) => (label.length > max ? `${label.slice(0, max - 1)}…` : label);

/** Кнопки под сообщением → JSON inline-клавиатуры. Бросает ошибку, если ядро нарушило лимиты VK. */
export function renderInlineKeyboard(buttons: Button[][] | undefined): string | undefined {
  const rows = buttons?.filter((row) => row.length);
  if (!rows?.length) return undefined;
  if (rows.length > VK_LIMITS.maxButtonRows) {
    throw new Error(`VK: ${rows.length} рядов кнопок, максимум ${VK_LIMITS.maxButtonRows}`);
  }
  const keyboard = Keyboard.builder().inline();
  rows.forEach((row, n) => {
    const width = row.reduce((sum, button) => sum + (button.type === 'url' ? 2 : 1), 0);
    if (width > VK_LIMITS.maxButtonsPerRow) {
      throw new Error(`VK: ряд кнопок шириной ${width}, максимум ${VK_LIMITS.maxButtonsPerRow}`);
    }
    if (n) keyboard.row();
    for (const button of row) {
      const label = truncate(button.label, VK_LIMITS.maxLabelLength);
      if (button.type === 'url') {
        keyboard.urlButton({ label, url: button.url });
        continue;
      }
      const payload = { d: button.data };
      if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
        throw new Error(`VK: payload кнопки «${label}» длиннее ${MAX_PAYLOAD_BYTES} байт`);
      }
      keyboard.callbackButton({ label, payload });
    }
  });
  return keyboard.toString();
}

/** Главное меню: обычная клавиатура с текстовыми кнопками, нажатие приходит как сообщение. */
export function renderMenu(layout: readonly (readonly string[])[]): string {
  const keyboard = Keyboard.builder();
  layout.forEach((row, n) => {
    if (n) keyboard.row();
    for (const label of row) keyboard.textButton({ label: truncate(label, VK_LIMITS.maxLabelLength) });
  });
  return keyboard.toString();
}
