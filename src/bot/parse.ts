export type Target = { kind: 'address'; value: string } | { kind: 'txid'; value: string };

const BECH32 = /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{8,87}$/;
const BASE58 = /^[123mn][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const TXID = /^[0-9a-f]{64}$/;

/**
 * Грубая проверка формата адреса / txid. Окончательно адрес валидирует mempool API
 * (на невалидный адрес он отвечает 400).
 */
export function parseTarget(input: string): Target | null {
  const raw = input.trim();
  if (TXID.test(raw.toLowerCase())) return { kind: 'txid', value: raw.toLowerCase() };
  // bech32 допускает верхний регистр целиком (так удобнее для QR), но API ждёт нижний
  const lower = raw.toLowerCase();
  if (BECH32.test(lower) && (raw === lower || raw === raw.toUpperCase())) return { kind: 'address', value: lower };
  if (BASE58.test(raw)) return { kind: 'address', value: raw };
  return null;
}
