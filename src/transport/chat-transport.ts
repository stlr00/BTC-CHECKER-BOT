import type { OutgoingMessage, TransportKind, TransportLimits, TransportSetup, UpdateHandler } from './transport.types.js';

/**
 * Транспорт мессенджера. Ядро бота работает только с этим контрактом и ничего не знает
 * о платформе: транспорт нормализует входящие события и сам отрисовывает исходящие сообщения.
 */
export abstract class ChatTransport {
  abstract readonly kind: TransportKind;
  abstract readonly limits: TransportLimits;

  protected handler: UpdateHandler | null = null;

  /** Ядро подписывается на входящие события до старта транспорта. */
  onUpdate(handler: UpdateHandler): void {
    this.handler = handler;
  }

  /** Подключиться к платформе и начать получать события. */
  abstract start(setup: TransportSetup): Promise<void>;

  abstract stop(): Promise<void>;

  /**
   * Сообщение вне диалога (уведомление). Бросает ChatUnavailableError,
   * если пользователь заблокировал бота.
   */
  abstract send(chatId: string, message: OutgoingMessage): Promise<void>;
}
