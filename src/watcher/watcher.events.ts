import type { Tx } from '../mempool/mempool.types.js';

export const WATCHER_TX_EVENT = 'watcher.tx';

export type WatcherTxEvent =
  /** Новая транзакция — в мемпуле или сразу в блоке */
  | { type: 'new'; address: string; tx: Tx; net: number }
  /** Первое подтверждение */
  | { type: 'confirmed'; address: string; tx: Tx; net: number }
  /** Пропала из мемпула (RBF / вытеснение) */
  | { type: 'removed'; address: string; txid: string; net: number };
