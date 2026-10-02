export interface Coordinates {
  lat: number;
  lon: number;
  /** Точность в метрах, если указана на фото (например, штамп NoteCam) */
  accuracyM?: number;
}

const MINUS = '[-−–]';
// Число с дробной частью; OCR иногда вставляет пробел вокруг разделителя: «54. 155977»
const DECIMAL = String.raw`${MINUS}?\d{1,3}\s?[.,]\s?\d+`;
const NOT_LETTER_BEFORE = '(?<![a-zа-яё])';

const LAT_LABEL = new RegExp(
  String.raw`${NOT_LETTER_BEFORE}(?:широта|шир\.|latitude|lat)\s*[:=]?\s*(${DECIMAL})\s*°?\s*([NSСЮ])?(?![a-zа-яё])`,
  'iu',
);
const LON_LABEL = new RegExp(
  String.raw`${NOT_LETTER_BEFORE}(?:долгота|долг\.|longitude|long|lon|lng)\s*[:=]?\s*(${DECIMAL})\s*°?\s*([EWВЗ])?(?![a-zа-яё])`,
  'iu',
);
const ACCURACY = /(?:точность|accuracy|погрешность)\s*[:=]?\s*±?\s*(\d+(?:[.,]\d+)?)\s*(?:м|m)(?![a-zа-яё])/iu;

// 54°09'21.5"N, N 54°09.358' и т.п.: градусы, минуты (могут быть дробными), необязательные секунды
const DMS = new RegExp(
  String.raw`([NSEWСЮВЗ])?\s*(\d{1,3})\s*°\s*(\d{1,2}(?:[.,]\d+)?)\s*['′’]?\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*(?:["″”]|''))?\s*([NSEWСЮВЗ])?`,
  'giu',
);

// Пара десятичных чисел: «54.155977, 37.619617», «N54.155977 E37.619617»
const PAIR = new RegExp(
  String.raw`([NSСЮ])?\s*(${MINUS}?\d{1,2}[.,]\d{3,})\s*°?\s*([NSСЮ])?\s*[,;\s]\s*([EWВЗ])?\s*(${MINUS}?\d{1,3}[.,]\d{3,})\s*°?\s*([EWВЗ])?`,
  'iu',
);

function toNumber(raw: string): number {
  return Number(raw.replace(/\s/g, '').replace(',', '.').replace(/^[−–]/, '-'));
}

function applyHemisphere(value: number, hemisphere: string | undefined): number {
  return hemisphere && /[SWЮЗ]/iu.test(hemisphere) ? -Math.abs(value) : value;
}

function isValid(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

function fromLabels(text: string): Coordinates | null {
  const lat = LAT_LABEL.exec(text);
  const lon = LON_LABEL.exec(text);
  if (!lat || !lon) return null;
  return { lat: applyHemisphere(toNumber(lat[1]), lat[2]), lon: applyHemisphere(toNumber(lon[1]), lon[2]) };
}

function fromDms(text: string): Coordinates | null {
  const parts = [...text.matchAll(DMS)].map((m) => {
    const value = Number(m[2]) + toNumber(m[3]) / 60 + (m[4] ? toNumber(m[4]) / 3600 : 0);
    const hemisphere = m[5] ?? m[1];
    return { value: applyHemisphere(value, hemisphere), hemisphere: hemisphere?.toUpperCase() };
  });
  if (parts.length < 2) return null;
  const isLat = (h?: string) => h !== undefined && 'NSСЮ'.includes(h);
  const isLon = (h?: string) => h !== undefined && 'EWВЗ'.includes(h);
  const lat = parts.find((p) => isLat(p.hemisphere));
  const lon = parts.find((p) => isLon(p.hemisphere));
  // Без букв полушарий считаем, что первой идёт широта
  return lat && lon ? { lat: lat.value, lon: lon.value } : { lat: parts[0].value, lon: parts[1].value };
}

function fromPair(text: string): Coordinates | null {
  const m = PAIR.exec(text);
  if (!m) return null;
  return { lat: applyHemisphere(toNumber(m[2]), m[3] ?? m[1]), lon: applyHemisphere(toNumber(m[5]), m[6] ?? m[4]) };
}

/** Ищет GPS-координаты в произвольном тексте (например, распознанном с фото). */
export function parseCoordinates(text: string): Coordinates | null {
  for (const strategy of [fromLabels, fromDms, fromPair]) {
    const found = strategy(text);
    if (found && isValid(found.lat, found.lon)) {
      const accuracy = ACCURACY.exec(text);
      return accuracy ? { ...found, accuracyM: toNumber(accuracy[1]) } : found;
    }
  }
  return null;
}

export function formatCoordinates({ lat, lon }: Coordinates): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** Ссылка на Яндекс Карты с меткой. В параметрах Яндекса сначала долгота, потом широта. */
export function yandexMapsUrl({ lat, lon }: Coordinates, zoom = 17): string {
  const point = `${lon.toFixed(6)},${lat.toFixed(6)}`;
  return `https://yandex.ru/maps/?ll=${point}&pt=${point}&z=${zoom}&l=map`;
}
