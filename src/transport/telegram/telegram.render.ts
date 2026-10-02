import { InlineKeyboard, Keyboard } from 'grammy';
import type { RichText } from '../rich-text.js';
import type { Button } from '../transport.types.js';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

const TAGS = { bold: 'b', italic: 'i', code: 'code' } as const;

/** RichText → HTML для parse_mode: 'HTML'. */
export function renderHtml(text: RichText): string {
  return text
    .map((segment) => {
      let html = escapeHtml(segment.text);
      if (segment.style) html = `<${TAGS[segment.style]}>${html}</${TAGS[segment.style]}>`;
      if (segment.url) html = `<a href="${escapeAttr(segment.url)}">${html}</a>`;
      return html;
    })
    .join('');
}

export function renderInlineKeyboard(buttons: Button[][] | undefined): InlineKeyboard | undefined {
  if (!buttons?.length) return undefined;
  const keyboard = new InlineKeyboard();
  buttons.forEach((row, n) => {
    if (n) keyboard.row();
    for (const button of row) {
      if (button.type === 'url') keyboard.url(button.label, button.url);
      else keyboard.text(button.label, button.data);
    }
  });
  return keyboard;
}

/** Главное меню. Без .persistent(): пользователь может свернуть клавиатуру кнопкой в поле ввода. */
export function renderMenu(layout: readonly (readonly string[])[]): Keyboard {
  const keyboard = new Keyboard();
  layout.forEach((row, n) => {
    if (n) keyboard.row();
    for (const label of row) keyboard.text(label);
  });
  return keyboard.resized();
}
