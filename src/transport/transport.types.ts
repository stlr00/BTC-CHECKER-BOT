import type { RichText } from './rich-text.js';

export type TransportKind = 'tg' | 'vk';

/** Чат на конкретной платформе. */
export interface ChatRef {
  transport: TransportKind;
  /** ID чата на платформе (в Telegram — chat.id, в VK — peer_id) */
  id: string;
  /** Личная переписка с ботом (не группа / беседа) */
  isPrivate: boolean;
}

/** Ключ чата для хранилища: `tg:123`, `vk:2000000001`. */
export function chatKey(chat: Pick<ChatRef, 'transport' | 'id'>): string {
  return `${chat.transport}:${chat.id}`;
}

export function parseChatKey(key: string): { transport: TransportKind; id: string } | null {
  const m = /^(tg|vk):(.+)$/.exec(key);
  return m ? { transport: m[1] as TransportKind, id: m[2] } : null;
}

export type Button =
  /** Кнопка, которая возвращает боту строку data (callback в Telegram, callback-кнопка в VK) */
  | { type: 'action'; label: string; data: string }
  | { type: 'url'; label: string; url: string };

export interface OutgoingMessage {
  text: RichText;
  /** Кнопки под сообщением, по рядам */
  buttons?: Button[][];
  /** Показать главное меню (клавиатуру с основными командами) */
  menu?: boolean;
}

export type ImageMimeType = 'JPEG' | 'PNG';

interface IncomingBase {
  chat: ChatRef;
  /** ID пользователя на платформе */
  userId: string;
}

export type IncomingUpdate =
  | (IncomingBase & { kind: 'text'; text: string })
  | (IncomingBase & { kind: 'action'; data: string })
  | (IncomingBase & {
      kind: 'image';
      mimeType: ImageMimeType | null;
      size?: number;
      download(): Promise<Buffer>;
    });

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Событие до того, как транспорт дописал к нему чат и пользователя. */
export type IncomingEvent = DistributiveOmit<IncomingUpdate, 'chat' | 'userId'>;

/** Ответы в рамках одного входящего события. Создаётся транспортом. */
export interface ReplyContext {
  reply(message: OutgoingMessage): Promise<void>;
  /** Заменить сообщение, к которому относится нажатая кнопка; если нельзя — отправить новое */
  edit(message: OutgoingMessage): Promise<void>;
  typing(): Promise<void>;
  /** Ответ на нажатие кнопки (всплывающее уведомление); для текстовых событий ничего не делает */
  answerAction(text?: string, alert?: boolean): Promise<void>;
  sendLocation(lat: number, lon: number, accuracyM?: number): Promise<void>;
}

export type UpdateHandler = (update: IncomingUpdate, reply: ReplyContext) => Promise<void>;

/** То, что ядро сообщает транспорту при старте: главное меню и список команд. */
export interface TransportSetup {
  /** Подписи кнопок главного меню по рядам */
  menu: readonly (readonly string[])[];
  commands: readonly { command: string; description: string }[];
}

/** Ограничения клавиатур платформы — ядро учитывает их при раскладке кнопок. */
export interface TransportLimits {
  maxButtonRows: number;
  maxButtonsPerRow: number;
  maxLabelLength: number;
}

/** Чат недоступен: пользователь заблокировал бота или запретил сообщения от сообщества. */
export class ChatUnavailableError extends Error {
  constructor(
    readonly chat: string,
    cause?: unknown,
  ) {
    super(`Чат ${chat} недоступен`, { cause });
  }
}
