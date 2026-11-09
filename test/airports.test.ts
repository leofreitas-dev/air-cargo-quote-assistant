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

  it('assumes the main cargo airport for Sao Paulo and names the alternative', () => {
    const m = resolveAirport('Sao Paulo');
    expect(m.ok && m.airport.iata).toBe('GRU');
    expect(m.ok && m.method === 'assumed' && m.alternatives.map((a) => a.iata)).toEqual(['VCP']);
    expect(code('São Paulo')).toBe('GRU/assumed');
  });

  it('asks between the cargo airports of New York (JFK or EWR, not LGA)', () => {
    const m = resolveAirport('New York');
    expect(!m.ok && m.reason === 'ambiguous' && m.candidates.map((a) => a.iata)).toEqual(['JFK', 'EWR']);
    expect(code('LaGuardia')).toBe('LGA/name'); // still known when named explicitly
  });

  it('does not guess when another city has several airports', () => {
    expect(code('London')).toBe('ambiguous');
  });

  it('flags unknown codes and names', () => {
    expect(code('XXX')).toBe('unknown');
    expect(code('Narnia')).toBe('unknown');
    expect(code('   ')).toBe('unknown');
  });
});
