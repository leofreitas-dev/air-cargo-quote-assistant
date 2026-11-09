// Prices a shipment from the command line, showing every step.
// Usage: npm run price -- GRU MIA 3x120x100x110cm 420kg
//        npm run price -- GRU JFK 2x48x40x40in 1x30x20x20in 900lb

import type { Piece, Weight } from '../pricing/chargeable-weight.ts';
import { formatQuote } from '../pricing/format.ts';
import { priceShipment } from '../pricing/quote.ts';

const USAGE = `Usage: npm run price -- <ORIGIN> <DESTINATION> <pieces...> <weight>
  pieces: COUNTxLENGTHxWIDTHxHEIGHT followed by cm or in, e.g. 3x120x100x110cm
  weight: total weight followed by kg or lb, e.g. 420kg
Example: npm run price -- GRU MIA 3x120x100x110cm 420kg`;

const PIECE = /^(\d+)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(cm|in)$/i;
const WEIGHT = /^(\d+(?:\.\d+)?)(kg|lb)$/i;

function fail(message: string, showUsage = true): never {
  console.error(showUsage ? `${message}\n\n${USAGE}` : message);
  process.exit(1);
}

const [origin, destination, ...rest] = process.argv.slice(2);
if (!origin || !destination || rest.length < 2) fail('Missing arguments.');

const pieces: Piece[] = [];
let weight: Weight | undefined;
for (const arg of rest) {
  const p = PIECE.exec(arg);
  const w = WEIGHT.exec(arg);
  if (p) {
    pieces.push({
      count: Number(p[1]),
      length: Number(p[2]),
      width: Number(p[3]),
      height: Number(p[4]),
      unit: p[5]!.toLowerCase() as Piece['unit'],
    });
  } else if (w) {
    if (weight) fail('Give the total weight only once.');
    weight = { value: Number(w[1]), unit: w[2]!.toLowerCase() as Weight['unit'] };
  } else {
    fail(`Could not read "${arg}".`);
  }
}
if (pieces.length === 0) fail('At least one piece is required.');
if (!weight) fail('The total weight is required.');

try {
  const result = priceShipment({ origin, destination, pieces, weight });
  if (!result.ok) fail(result.message, false);
  console.log(formatQuote(result));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), false);
}
