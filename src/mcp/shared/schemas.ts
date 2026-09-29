// Tool input schemas (§6). Field limits mirror Voc's app/types/records.ts
// exactly — the same constraints Voc's DB and UI enforce — so the MCP surface
// is never more lenient than Voc itself.

import { z } from 'zod'

export const MAX_CONTENT = 500
export const MAX_MEANING = 2000
export const MAX_SOURCE = 500
export const MAX_NOTES = 4000

export const RecordTypeSchema = z.enum(['word', 'phrase', 'sentence'])
export const RecordSortSchema = z.enum(['newest', 'oldest', 'alphabetical'])
export const RecordIdSchema = z.uuid()

export const CreateRecordSchema = z.object({
  type: RecordTypeSchema,
  content: z
    .string()
    .trim()
    .min(1, 'Content is required')
    .max(MAX_CONTENT, `Content must be at most ${MAX_CONTENT} characters`),
  meaning: z
    .string()
    .trim()
    .min(1, 'Meaning is required')
    .max(MAX_MEANING, `Meaning must be at most ${MAX_MEANING} characters`),
  source: z.string().trim().max(MAX_SOURCE).optional(),
  notes: z.string().trim().max(MAX_NOTES).optional(),
  // Tag names, not UUIDs (§6.7) — resolved via resolveTagNames.
  tags: z.array(z.string().trim().min(1)).default([]),
})

export const UpdateRecordSchema = z.object({
  id: RecordIdSchema,
  type: RecordTypeSchema.optional(),
  content: z.string().trim().min(1).max(MAX_CONTENT).optional(),
  meaning: z.string().trim().min(1).max(MAX_MEANING).optional(),
  // Explicit null clears the field (§6.4); omitted = unchanged.
  source: z.string().trim().max(MAX_SOURCE).nullable().optional(),
  notes: z.string().trim().max(MAX_NOTES).nullable().optional(),
  // Omitted = leave associations alone; [] = remove all (§6.4).
  tags: z.array(z.string().trim().min(1)).optional(),
})

export const SearchRecordsSchema = z.object({
  query: z.string().optional(),
  type: z.enum(['word', 'phrase', 'sentence', 'all']).default('all'),
  tags: z.array(z.string().trim().min(1)).default([]),
  sort: RecordSortSchema.default('newest'),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
})

export const RecordIdInputSchema = z.object({ id: RecordIdSchema })
