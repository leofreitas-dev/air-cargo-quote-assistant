import { describe, expect, it } from 'vitest';
import { checkTariffTable, findRoute, loadDefaultTariffs, type TariffTable } from '../src/pricing/tariffs.ts';

const route = {
  origin: 'GRU',
  destination: 'MIA',
  minimumCharge: 75,
  breaks: [
    { label: 'N', minKg: 0, ratePerKg: 4.8 },
    { label: '+45', minKg: 45, ratePerKg: 4.1 },
  ],
};
const table = (overrides: Partial<TariffTable> = {}): TariffTable => ({
  name: 'test',
  currency: 'USD',
  surcharges: [{ code: 'FSC', name: 'Fuel', ratePerKg: 0.85 }],
  routes: [route],
  ...overrides,
});

describe('tariff table', () => {
  it('the shipped data/tariffs.json is valid', () => {
    expect(checkTariffTable(loadDefaultTariffs())).toEqual([]);
  });

  it('finds a route regardless of case and spaces', () => {
    expect(findRoute(table(), ' gru ', 'mia')?.minimumCharge).toBe(75);
    expect(findRoute(table(), 'MIA', 'GRU')).toBeUndefined();
  });

  it('catches broken tables', () => {
    const problems = (t: TariffTable) => checkTariffTable(t).join('\n');
    expect(problems(table({ routes: [route, route] }))).toMatch(/listed twice/);
    expect(problems(table({ routes: [{ ...route, origin: 'GR' }] }))).toMatch(/3 capital letters/);
    expect(problems(table({ routes: [{ ...route, breaks: [...route.breaks].reverse() }] }))).toMatch(
      /start at 0 kg|ascending/,
    );
    expect(problems(table({ routes: [{ ...route, breaks: [{ label: 'N', minKg: 0, ratePerKg: 0 }] }] }))).toMatch(
      /positive/,
    );
    expect(problems(table({ routes: [{ ...route, breaks: [{ label: 'N', minKg: 0, ratePerKg: 4.805 }] }] }))).toMatch(
      /2 decimals/,
    );
    expect(problems(table({ surcharges: [{ code: 'X', name: 'X', ratePerKg: -1 }] }))).toMatch(/negative/);
  });
});
