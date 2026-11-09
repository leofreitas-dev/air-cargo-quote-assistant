// The fixed format the AI must fill when it reads a quote request.
// The AI only copies what the email says: it does not convert units, look up
// airports or compute anything. Code does that afterwards, with tests.

import { z } from 'zod';

const Confidence = z.number().min(0).max(1);

export const PieceSchema = z.object({
  count: z.number().int().positive(),
  length: z.number().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  unit: z.enum(['cm', 'in']),
});

export const ExtractionSchema = z.object({
  /** False for emails that are not asking for a quote (invoices, newsletters...). */
  isQuoteRequest: z.boolean(),
  /** Airports exactly as written: "GRU", "Sao Paulo Guarulhos", "Miami". */
  origin: z.string().min(1).nullable(),
  destination: z.string().min(1).nullable(),
  /** Groups of identical pieces. Null when the dimensions are not given. */
  pieces: z.array(PieceSchema).min(1).nullable(),
  /** Weight as written. "per" says whether it is the total or the weight of each piece. */
  weight: z
    .object({
      value: z.number().positive(),
      unit: z.enum(['kg', 'lb']),
      per: z.enum(['total', 'piece']),
    })
    .nullable(),
  /** Null when the email does not say. */
  cargoType: z.enum(['general', 'perishable', 'dangerous']).nullable(),
  /** Free text such as "lithium ion batteries UN3480". */
  cargoDescription: z.string().nullable(),
  /** YYYY-MM-DD, resolved from phrases like "ready Friday" using the email date. */
  readyDate: z.iso.date().nullable(),
  urgent: z.boolean(),
  sender: z.object({
    name: z.string().nullable(),
    company: z.string().nullable(),
  }),
  /** How sure the AI is about each field, from 0 to 1. */
  confidence: z.object({
    origin: Confidence,
    destination: Confidence,
    pieces: Confidence,
    weight: Confidence,
    cargoType: Confidence,
    readyDate: Confidence,
  }),
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ConfidenceField = keyof Extraction['confidence'];
