import type { Tx } from '../mempool/mempool.types.js';

/** Сколько адрес получил, отправил и итоговое изменение баланса в транзакции (сатоши). */
export function netForAddress(tx: Tx, address: string): { received: number; sent: number; net: number } {
  let received = 0;
  let sent = 0;
  for (const out of tx.vout) if (out.scriptpubkey_address === address) received += out.value;
  for (const input of tx.vin) if (input.prevout?.scriptpubkey_address === address) sent += input.prevout.value;
  return { received, sent, net: received - sent };
}
