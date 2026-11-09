import { describe, expect, it } from 'vitest';
import { normalizeName, resolveAirport } from '../src/validation/airports.ts';

const code = (input: string) => {
  const m = resolveAirport(input);
  return m.ok ? `${m.airport.iata}/${m.method}` : m.reason;
};

describe('normalizeName', () => {
  it('removes accents, punctuation and filler words', () => {
    expect(normalizeName("São Paulo/Guarulhos Int'l Airport")).toBe('sao paulo guarulhos');
  });
});

describe('resolveAirport', () => {
  it('accepts codes in any case', () => {
    expect(code('GRU')).toBe('GRU/code');
    expect(code(' mia ')).toBe('MIA/code');
    expect(code('JFK airport')).toBe('JFK/code');
  });

  it('finds a code written inside the text', () => {
    expect(code('Sao Paulo (GRU)')).toBe('GRU/code');
  });

  it('reads airports written out in full (brief case)', () => {
    expect(code('Sao Paulo Guarulhos')).toBe('GRU/name');
    expect(code("São Paulo/Guarulhos Int'l Airport")).toBe('GRU/name');
    expect(code('Heathrow')).toBe('LHR/name');
    expect(code('Lisboa')).toBe('LIS/name');
    expect(code('Miami, FL')).toBe('MIA/name');
  });

  it('accepts a city with a single airport', () => {
    expect(code('Campinas')).toBe('VCP/city');
  });

  it('does not guess when a city has several airports', () => {
    const m = resolveAirport('Sao Paulo');
    expect(m.ok).toBe(false);
    expect(!m.ok && m.reason === 'ambiguous' && m.candidates.map((a) => a.iata)).toEqual(['GRU', 'CGH']);
    expect(code('London')).toBe('ambiguous');
  });

  it('flags unknown codes and names', () => {
    expect(code('XXX')).toBe('unknown');
    expect(code('Narnia')).toBe('unknown');
    expect(code('   ')).toBe('unknown');
  });
});
