import type { Request, Response } from "express";
import * as legalService from "@/services/legal";
import { getSession } from "@/lib/auth/session";
import { jsonData, searchParams } from "@/lib/api/response";
import { parseLegalConsent } from "@/lib/validations/legal";

export function getLegalCatalog(_req: Request, res: Response) {
  return jsonData(res, legalService.getCatalog());
}

export function getLegalDocument(req: Request, res: Response) {
  return jsonData(res, legalService.getDocument(String(req.params.slug), searchParams(req).get("version")));
}

export async function getMyLegalStatus(req: Request, res: Response) {
  return jsonData(res, await legalService.getLegalStatus(req.userId));
}

export async function acceptLegalDocuments(req: Request, res: Response) {
  const versions = parseLegalConsent(req.body);
  // Le compte et le canal viennent de la session, jamais du corps de la requête.
  const session = await getSession();
  await legalService.recordAcceptance(req.userId, versions, session?.audience === "mobile" ? "MOBILE" : "WEB");
  return jsonData(res, await legalService.getLegalStatus(req.userId));
}
