// Shows how the pipeline reads an airport written in an email.
// Usage: npm run airport -- "Sao Paulo Guarulhos" GRU "New York" XXX

import { resolveAirport } from '../validation/airports.ts';

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error('Usage: npm run airport -- "Sao Paulo Guarulhos" GRU "New York"');
  process.exit(1);
}

for (const input of inputs) {
  const m = resolveAirport(input);
  const label = `"${input}"`.padEnd(30);
  if (m.ok) console.log(`${label} -> ${m.airport.iata}  ${m.airport.name}  (matched by ${m.method})`);
  else if (m.reason === 'ambiguous') {
    console.log(`${label} -> AMBIGUOUS: ${m.candidates.map((a) => `${a.iata} ${a.name}`).join(' | ')}`);
  } else console.log(`${label} -> UNKNOWN: not a known airport`);
}
