import type { Button } from '../transport/transport.types.js';

/** Кнопки главного меню. Транспорт рисует их своей клавиатурой, нажатие приходит как текст. */
export const BTN = {
  sub: '➕ Подписаться',
  list: '📋 Мои адреса',
  check: '🔍 Проверить',
  block: '⏱ Последний блок',
  settings: '⚙️ Настройки',
} as const;

/** Раскладка главного меню по рядам. */
export const MENU_LAYOUT: readonly (readonly string[])[] = [[BTN.sub, BTN.list], [BTN.check, BTN.block], [BTN.settings]];

// Старые надписи: у пользователей Telegram может остаться прежняя клавиатура до следующего /start
export const LEGACY_BTN = {
  sub: ['➕ Подписаться на адрес'],
  check: ['🔍 Баланс / транзакция сейчас', '🔍 Проверить сейчас'],
  block: ['⏱ Время с последнего блока'],
} as const;

/** Команды, которые транспорт может зарегистрировать на платформе (меню команд Telegram). */
export const COMMANDS = [
  { command: 'start', description: 'Меню и справка' },
  { command: 'sub', description: 'Подписаться: /sub <адрес> [метка]' },
  { command: 'unsub', description: 'Отписаться: /unsub <адрес>' },
  { command: 'list', description: 'Мои адреса' },
  { command: 'check', description: 'Проверить: /check <адрес или txid>' },
  { command: 'block', description: 'Сколько прошло с последнего блока' },
  { command: 'settings', description: 'Валюта и часовой пояс' },
] as const;

export const action = (label: string, data: string): Button => ({ type: 'action', label, data });
export const url = (label: string, href: string): Button => ({ type: 'url', label, url: href });
