import { describe, expect, it } from 'vitest';
import { checkDuplicate, fingerprint, type FingerprintInput } from '../src/validation/duplicates.ts';

const base: FingerprintInput = {
  from: 'ops@example-forwarder.test',
  origin: 'GRU',
  destination: 'MIA',
  pieces: [{ count: 3, length: 120, width: 100, height: 110, unit: 'cm' }],
  weight: { value: 420, unit: 'kg' },
  readyDate: '2026-11-13',
};

describe('fingerprint', () => {
  it('is the same for the same shipment written differently', () => {
    const same = fingerprint({
      ...base,
      from: ' OPS@Example-Forwarder.test ',
      pieces: [{ count: 3, length: 100, width: 110, height: 120, unit: 'cm' }], // other order
    });
    expect(same).toBe(fingerprint(base));

    const inInches = fingerprint({
      ...base,
      pieces: [{ count: 1, length: 48, width: 40, height: 40, unit: 'in' }],
      weight: { value: 500, unit: 'lb' },
    });
    const inCm = fingerprint({
      ...base,
      pieces: [{ count: 1, length: 121.92, width: 101.6, height: 101.6, unit: 'cm' }],
      weight: { value: 226.8, unit: 'kg' },
    });
    expect(inInches).toBe(inCm);
  });

  it('changes when the shipment changes', () => {
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, destination: 'JFK' })).not.toBe(fp);
    expect(fingerprint({ ...base, weight: { value: 520, unit: 'kg' } })).not.toBe(fp);
    expect(fingerprint({ ...base, readyDate: '2026-11-20' })).not.toBe(fp);
    expect(fingerprint({ ...base, from: 'someone-else@example.test' })).not.toBe(fp);
  });
});

describe('checkDuplicate', () => {
  const history = [{ id: 'REQ-1', messageId: '<a1@mail.test>', fingerprint: 'abc', receivedAt: '2026-11-09T10:00:00Z' }];

  it('catches the same email delivered twice', () => {
    const r = checkDuplicate({ messageId: '<a1@mail.test>', fingerprint: 'zzz', receivedAt: '2026-11-09T10:01:00Z' }, history);
    expect(r).toMatchObject({ duplicate: true, kind: 'same_email', original: { id: 'REQ-1' } });
  });

  it('catches the same shipment in a new email within 7 days', () => {
    const r = checkDuplicate({ messageId: '<b2@mail.test>', fingerprint: 'abc', receivedAt: '2026-11-12T09:00:00Z' }, history);
    expect(r).toMatchObject({ duplicate: true, kind: 'same_shipment' });
  });

  it('treats the same shipment weeks later as a new request', () => {
    const r = checkDuplicate({ messageId: '<c3@mail.test>', fingerprint: 'abc', receivedAt: '2026-11-30T09:00:00Z' }, history);
    expect(r).toEqual({ duplicate: false });
  });
});
