import { z } from "zod";
import { Errors } from "@/lib/api/errors";
import { currentVersions, type AcceptedVersions } from "@/legal/status";

const consentSchema = z.object({
  // Strictement `true` : ni "true", ni 1, ni "on".
  accepteDocuments: z.literal(true),
  termsVersion: z.string().min(1).max(32),
  privacyVersion: z.string().min(1).max(32),
});

/**
 * Accord explicite sur les versions EN VIGUEUR, exigé à l'inscription comme
 * lors d'une nouvelle acceptation. Le client renvoie les versions qu'il a
 * affichées : on n'enregistre jamais un accord sur un texte qui n'a pas été
 * présenté.
 */
export function parseLegalConsent(body: unknown): AcceptedVersions {
  const parsed = consentSchema.safeParse(body);
  if (!parsed.success) throw Errors.legalConsentMissing();

  const current = currentVersions();
  if (parsed.data.termsVersion !== current.termsVersion || parsed.data.privacyVersion !== current.privacyVersion) {
    throw Errors.legalVersionOutdated();
  }
  return current;
}
