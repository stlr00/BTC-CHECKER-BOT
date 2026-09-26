import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { StorageService } from '../storage/storage.service.js';

const MAX_REFS = 5000;

/**
 * Короткие идентификаторы для callback_data: лимит Telegram — 64 байта,
 * а taproot-адрес и txid сами по себе занимают 62–64 символа.
 */
@Injectable()
export class RefsService {
  private readonly map = new Map<string, string>();

  constructor(private readonly storage: StorageService) {}

  static idOf(value: string): string {
    return createHash('sha256').update(value).digest('base64url').slice(0, 12);
  }

  ref(value: string): string {
    const id = RefsService.idOf(value);
    this.map.delete(id);
    this.map.set(id, value);
    if (this.map.size > MAX_REFS) this.map.delete(this.map.keys().next().value!);
    return id;
  }

  /** После рестарта кеш пуст, но подписанные адреса можно найти в хранилище. */
  resolve(id: string): string | null {
    return this.map.get(id) ?? this.storage.addresses.find((a) => RefsService.idOf(a) === id) ?? null;
  }
}
