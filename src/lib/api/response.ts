import type { Request, Response } from "express";
import { Errors } from "./errors";
import { parseIntId } from "./pagination";

export function jsonData<T>(res: Response, data: T, init?: { status?: number }) {
  return res.status(init?.status ?? 200).json({ data });
}

export function jsonPage<T>(
  res: Response,
  data: T[],
  pagination: { page: number; limit: number; total: number; totalPages: number },
) {
  return res.json({ data, pagination });
}

export function jsonMessage(res: Response, message: string, init?: { status?: number }) {
  return res.status(init?.status ?? 200).json({ message });
}

/** Paramètres de l'URL (`?page=2&search=riz`), lus de la même façon par toutes les routes. */
export function searchParams(req: Request): URLSearchParams {
  const queryIndex = req.originalUrl.indexOf("?");
  return new URLSearchParams(queryIndex === -1 ? "" : req.originalUrl.slice(queryIndex + 1));
}

/** Identifiant numérique de la route (`/:id`) ; lève une erreur 400 s'il est invalide. */
export function routeId(req: Request): number {
  const id = parseIntId(String(req.params.id));
  if (!id) throw Errors.invalidId();
  return id;
}
