import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { appConfig, type AppConfig } from '../config/app.config.js';
import { MempoolEvents } from './mempool.types.js';

/**
 * WebSocket mempool.space: новые блоки и мгновенные события по отслеживаемым адресам.
 * Публикует события MempoolEvents.*. Источником истины не является — только триггер
 * для проверки через REST, поэтому потеря соединения не приводит к потере уведомлений.
 */
@Injectable()
export class MempoolSocketService implements OnModuleDestroy {
  private readonly logger = new Logger(MempoolSocketService.name);
  private ws: WebSocket | null = null;
  private addresses: string[] = [];
  private retry = 0;
  private pingTimer?: NodeJS.Timeout;
  private lastMessageAt = 0;
  private stopped = true;

  constructor(
    @Inject(appConfig.KEY) private readonly config: AppConfig,
    private readonly events: EventEmitter2,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearInterval(this.pingTimer);
    this.ws?.close();
  }

  setAddresses(addresses: string[]): void {
    this.addresses = [...addresses];
    this.send({ 'track-addresses': this.addresses });
  }

  private send(payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private connect(): void {
    const ws = new WebSocket(this.config.mempoolWs);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.logger.log(`Подключён к ${this.config.mempoolWs}`);
      this.retry = 0;
      this.lastMessageAt = Date.now();
      this.send({ action: 'want', data: ['blocks'] });
      this.send({ 'track-addresses': this.addresses });
      this.events.emit(MempoolEvents.Connected);

      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (Date.now() - this.lastMessageAt > 90_000) {
          this.logger.warn('Соединение молчит 90 с, переподключаюсь');
          ws.close();
          return;
        }
        this.send({ action: 'ping' });
      }, 30_000);
    });

    ws.addEventListener('message', (event) => {
      this.lastMessageAt = Date.now();
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (data.block) this.events.emit(MempoolEvents.Block, data.block);

      const multi = data['multi-address-transactions'];
      if (multi && typeof multi === 'object') {
        this.events.emit(MempoolEvents.AddressActivity, Object.keys(multi));
      }

      for (const key of Object.keys(data)) {
        if (key.endsWith('error')) this.logger.warn(`${key}: ${JSON.stringify(data[key])}`);
      }
    });

    ws.addEventListener('close', () => {
      clearInterval(this.pingTimer);
      if (this.stopped) return;
      const delay = Math.min(60_000, 1000 * 2 ** this.retry++);
      this.logger.warn(`Соединение закрыто, переподключение через ${delay / 1000} с`);
      setTimeout(() => this.connect(), delay);
    });

    ws.addEventListener('error', () => this.logger.warn('Ошибка WebSocket'));
  }
}
