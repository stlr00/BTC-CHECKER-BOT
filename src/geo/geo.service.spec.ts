import { describe, expect, it, vi } from 'vitest';
import type { AliceLlmService } from './alice-llm.service.js';
import { GeoService } from './geo.service.js';

function setup(llmResult: { lat: number; lon: number } | null) {
  const llm = { extractCoordinates: vi.fn(async () => llmResult) };
  return { llm, geo: new GeoService(llm as unknown as AliceLlmService) };
}

describe('GeoService', () => {
  it('использует парсер и не тратит вызов LLM, если он справился', async () => {
    const { llm, geo } = setup(null);
    expect(await geo.locateInText('Широта: 54.155977 Долгота: 37.619617')).toEqual({
      coords: { lat: 54.155977, lon: 37.619617 },
      source: 'parser',
    });
    expect(llm.extractCoordinates).not.toHaveBeenCalled();
  });

  it('обращается к LLM, если парсер не нашёл координат', async () => {
    const { llm, geo } = setup({ lat: 54.155977, lon: 37.619617 });
    expect(await geo.locateInText('Шир0та 54155977 Д0лг0та 37619617')).toEqual({
      coords: { lat: 54.155977, lon: 37.619617 },
      source: 'llm',
    });
    expect(llm.extractCoordinates).toHaveBeenCalledOnce();
  });

  it('возвращает null, если не помогло ни то, ни другое', async () => {
    const { geo } = setup(null);
    expect(await geo.locateInText('Просто подпись на фото')).toBeNull();
  });
});
