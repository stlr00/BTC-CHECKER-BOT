import { describe, expect, it } from 'vitest';
import { b, code, i, lines, link, rt } from './rich-text.js';
import { renderHtml, renderInlineKeyboard as tgKeyboard } from './telegram/telegram.render.js';
import type { Button } from './transport.types.js';
import { renderInlineKeyboard as vkKeyboard, renderMenu as vkMenu, renderPlain } from './vk/vk.render.js';

const sample = lines(
  rt`💼 ${b('Холодный <кошелёк>')} · ${link('bc1qxy…0wlh', 'https://mempool.space/address/bc1qxy2', { compact: true })}`,
  rt`Код: ${code('a & b')}`,
  i('курсив'),
  rt`💻 Исходный код: ${link('GitHub', 'https://github.com/stlr00/BTC-CHECKER-BOT')}`,
);

describe('rich-text', () => {
  it('lines() выкидывает пустые строки целиком и оставляет явные пустые', () => {
    expect(renderPlain(lines('a', false, null, '', 'b'))).toBe('a\n\nb');
  });
});

describe('Telegram render', () => {
  it('рисует HTML с экранированием', () => {
    expect(renderHtml(sample)).toBe(
      [
        '💼 <b>Холодный &lt;кошелёк&gt;</b> · <a href="https://mempool.space/address/bc1qxy2">bc1qxy…0wlh</a>',
        'Код: <code>a &amp; b</code>',
        '<i>курсив</i>',
        '💻 Исходный код: <a href="https://github.com/stlr00/BTC-CHECKER-BOT">GitHub</a>',
      ].join('\n'),
    );
  });

  it('рисует inline-клавиатуру по рядам', () => {
    const keyboard = tgKeyboard([
      [{ type: 'action', label: 'A', data: 'a' }, { type: 'url', label: 'U', url: 'https://x.test' }],
      [{ type: 'action', label: 'B', data: 'b' }],
    ]);
    expect(keyboard?.inline_keyboard).toEqual([
      [{ text: 'A', callback_data: 'a' }, { text: 'U', url: 'https://x.test' }],
      [{ text: 'B', callback_data: 'b' }],
    ]);
    expect(tgKeyboard([])).toBeUndefined();
  });
});

describe('VK render', () => {
  it('рисует плоский текст: компактная ссылка — адрес, обычная — «текст (url)»', () => {
    expect(renderPlain(sample)).toBe(
      [
        '💼 Холодный <кошелёк> · https://mempool.space/address/bc1qxy2',
        'Код: a & b',
        'курсив',
        '💻 Исходный код: GitHub (https://github.com/stlr00/BTC-CHECKER-BOT)',
      ].join('\n'),
    );
  });

  it('склеивает соседние сегменты одной ссылки', () => {
    expect(renderPlain(link(rt`Жирный ${b('кусок')}`, 'https://x.test'))).toBe('Жирный кусок (https://x.test)');
  });

  it('рисует callback- и url-кнопки, обрезает длинные подписи', () => {
    const json = JSON.parse(
      vkKeyboard([
        [{ type: 'action', label: 'Очень длинная подпись кнопки, которая не влезет в VK', data: 'chk:abc' }],
        [{ type: 'url', label: 'Карта', url: 'https://yandex.ru/maps' }],
      ])!,
    );
    expect(json.inline).toBe(true);
    const [[first], [second]] = json.buttons;
    expect(first.action).toMatchObject({ type: 'callback', payload: JSON.stringify({ d: 'chk:abc' }) });
    expect(first.action.label.length).toBeLessThanOrEqual(40);
    expect(first.action.label.endsWith('…')).toBe(true);
    expect(second.action).toMatchObject({ type: 'open_link', link: 'https://yandex.ru/maps', label: 'Карта' });
  });

  it('падает, если ядро нарушило лимиты VK', () => {
    const btn = (n: number): Button => ({ type: 'action', label: `b${n}`, data: `d${n}` });
    expect(() => vkKeyboard(Array.from({ length: 7 }, (_, n) => [btn(n)]))).toThrow(/рядов/);
    expect(() => vkKeyboard([[1, 2, 3, 4, 5, 6].map(btn)])).toThrow(/шириной/);
    // Три ссылки = 6 мест в ряду
    const link3: Button[] = [1, 2, 3].map((n) => ({ type: 'url', label: `u${n}`, url: 'https://x.test' }));
    expect(() => vkKeyboard([link3])).toThrow(/шириной/);
    expect(() => vkKeyboard([[{ type: 'action', label: 'x', data: 'x'.repeat(300) }]])).toThrow(/payload/);
  });

  it('рисует главное меню обычной (не inline) клавиатурой', () => {
    const json = JSON.parse(vkMenu([['A', 'B'], ['C']]));
    expect(json.inline).toBeFalsy();
    expect(json.buttons.map((row: { action: { label: string } }[]) => row.map((x) => x.action.label))).toEqual([['A', 'B'], ['C']]);
  });
});
