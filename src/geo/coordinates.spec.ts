import { describe, expect, it } from 'vitest';
import { formatCoordinates, parseCoordinates, yandexMapsUrl } from './coordinates.js';

describe('parseCoordinates', () => {
  it('читает штамп NoteCam с подписями «Широта / Долгота»', () => {
    const text = 'Широта: 54.155977\nДолгота: 37.619617\nТочность: 4.66 м\nNoteCam @ iOS';
    expect(parseCoordinates(text)).toEqual({ lat: 54.155977, lon: 37.619617, accuracyM: 4.66 });
  });

  it('переживает типичные артефакты OCR: запятую и пробел в дроби', () => {
    expect(parseCoordinates('Широта 54, 155977 Долгота: 37.619617')).toEqual({ lat: 54.155977, lon: 37.619617 });
  });

  it('понимает английские подписи и полушария', () => {
    expect(parseCoordinates('Lat: 33.8688 S  Long: 151.2093 E')).toEqual({ lat: -33.8688, lon: 151.2093 });
    expect(parseCoordinates('Latitude 40.7128, Longitude -74.0060')).toEqual({ lat: 40.7128, lon: -74.006 });
  });

  it('понимает градусы, минуты, секунды', () => {
    const result = parseCoordinates(`54°09'21.5"N 37°37'10.6"E`)!;
    expect(result.lat).toBeCloseTo(54.155972, 5);
    expect(result.lon).toBeCloseTo(37.619611, 5);
  });

  it('понимает градусы с дробными минутами и полушарие впереди', () => {
    const result = parseCoordinates(`N 54°09.358' E 37°37.177'`)!;
    expect(result.lat).toBeCloseTo(54.155967, 5);
    expect(result.lon).toBeCloseTo(37.619617, 5);
  });

  it('понимает западное и южное полушарие в DMS', () => {
    const result = parseCoordinates(`40°42'46"N 74°00'22"W`)!;
    expect(result.lat).toBeCloseTo(40.712778, 5);
    expect(result.lon).toBeCloseTo(-74.006111, 5);
  });

  it('понимает пару чисел без подписей', () => {
    expect(parseCoordinates('Точка встречи: 54.155977, 37.619617')).toEqual({ lat: 54.155977, lon: 37.619617 });
    expect(parseCoordinates('54,155977 37,619617')).toEqual({ lat: 54.155977, lon: 37.619617 });
  });

  it('не принимает случайные числа и значения вне диапазона', () => {
    expect(parseCoordinates('Цена 12.5, скидка 3.2')).toBeNull();
    expect(parseCoordinates('Широта: 154.155977 Долгота: 37.619617')).toBeNull();
    expect(parseCoordinates('Просто текст без координат')).toBeNull();
  });
});

describe('yandexMapsUrl', () => {
  it('ставит долготу первой, как требует Яндекс', () => {
    const coords = { lat: 54.155977, lon: 37.619617 };
    expect(yandexMapsUrl(coords)).toBe(
      'https://yandex.ru/maps/?ll=37.619617,54.155977&pt=37.619617,54.155977&z=17&l=map',
    );
    expect(formatCoordinates(coords)).toBe('54.155977, 37.619617');
  });
});
