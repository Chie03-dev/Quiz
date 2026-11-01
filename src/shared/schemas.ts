import { z } from 'zod'

/**
 * Zod schemas for WebSocket and IPC boundary validation.
 * All schemas are strict where feasible to reject malformed payloads at the
 * trust boundary.
 */

// --- WebSocket message payload schemas (phone -> server) ---

export const joinPayloadSchema = z.object({
  pin: z.string().optional(),
  name: z.string().optional(),
  deviceToken: z.string().optional(),
  photo: z.unknown().optional()
})

export const answerPayloadSchema = z.object({
  qid: z.unknown(),
  value: z.unknown(),
  seq: z.unknown()
})

export const focusLostPayloadSchema = z.object({
  reason: z.enum(['background', 'window', 'unpinned']).optional()
})

export const heartbeatPayloadSchema = z.object({}).passthrough()

export const focusGainedPayloadSchema = z.object({}).passthrough()

export const resumeRequestPayloadSchema = z.object({}).passthrough()

export const finishPayloadSchema = z.object({}).passthrough()

// --- IPC payload schemas ---

export const studentIdSchema = z.string().min(1)

export const ipSchema = z.string().min(1)

export const lockSchema = z.boolean()

export const deltaMsSchema = z.number().finite()

export const quizIdSchema = z.string().min(1)

export const memeIdSchema = z.string().min(1)

export const memePopTargetsSchema = z.array(z.string().min(1)).optional()

export const resultAnswerUpdateSchema = z.object({
  answerId: z.string().min(1),
  pointsAwarded: z.number().finite(),
  correct: z.boolean().nullable().optional(),
  notes: z.string().nullable().optional()
})

export const storedQuizSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  timeLimitSec: z.number(),
  questions: z.array(z.any())
}).passthrough()

export const modelIdSchema = z.string().nullable().optional()

export const enginePathSchema = z.string().nullable().optional()

export const aiGenerateOptsSchema = z.object({
  sourceText: z.string().optional(),
  filePath: z.string().optional(),
  topic: z.string().optional(),
  questionTypes: z.array(z.string()).optional(),
  count: z.number().optional(),
  points: z.number().optional()
}).passthrough()

export const aiAutoKeyInputSchema = z.object({
  questions: z.array(z.any()),
  sourceText: z.string().optional()
}).passthrough()

export const memeSavePayloadSchema = z.object({
  name: z.string().min(1),
  mime: z.enum(['image/jpeg', 'image/png']),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.unknown(),
  thumb: z.string()
}).passthrough()

/**
 * Validates and returns parsed data, or null on failure.
 * Used at IPC and WebSocket boundaries for structured rejection.
 */
export function safeParse<T>(schema: z.ZodSchema<T>, data: unknown): T | null {
  const result = schema.safeParse(data)
  return result.success ? result.data : null
}
