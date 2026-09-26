/** Подмножество полей Esplora/mempool.space API, которые использует бот. */

export interface TxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

export interface TxOutput {
  scriptpubkey_address?: string;
  value: number;
}

export interface TxInput {
  txid: string;
  vout: number;
  sequence: number;
  prevout: TxOutput | null;
}

export interface Tx {
  txid: string;
  vin: TxInput[];
  vout: TxOutput[];
  weight: number;
  size: number;
  fee: number;
  status: TxStatus;
}

export interface AddressStats {
  funded_txo_count: number;
  funded_txo_sum: number;
  spent_txo_count: number;
  spent_txo_sum: number;
  tx_count: number;
}

export interface AddressInfo {
  address: string;
  chain_stats: AddressStats;
  mempool_stats: AddressStats;
}

export interface Block {
  id: string;
  height: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  extras?: {
    medianFee?: number;
    pool?: { name: string; slug?: string };
  };
}

export interface RecommendedFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

export const MempoolEvents = {
  Block: 'mempool.block',
  AddressActivity: 'mempool.address-activity',
  Connected: 'mempool.connected',
} as const;
