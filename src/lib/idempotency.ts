import { z } from "zod";
import type { Request } from "express";

const keySchema = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);

export function requireIdempotencyKey(req: Request): string {
  return keySchema.parse(req.get("idempotency-key"));
}
