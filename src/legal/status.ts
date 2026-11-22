import { LEGAL_DOCUMENTS, currentRelease, type LegalDocument } from "@/legal/registry";

/** Ce que la base enregistre de chaque accord, pour le calcul du statut. */
export type AcceptedVersions = { termsVersion: string; privacyVersion: string };

export type DocumentStatus =
  /** La version en vigueur est acceptée. */
  | "accepted"
  /** L'accord reste valable ; une version plus récente est portée à connaissance. */
  | "updated"
  /** Un accord est exigé avant d'utiliser les fonctionnalités protégées. */
  | "acceptance_required";

export function documentStatus(document: LegalDocument, acceptances: readonly AcceptedVersions[]) {
  const field = document.kind === "terms" ? "termsVersion" : "privacyVersion";
  const accepted = new Set(acceptances.map((row) => row[field]));
  const { releases } = document;

  // Version inconnue du registre ou aucun accord : -1, l'accord est demandé.
  const acceptedIndex = releases.findLastIndex((release) => accepted.has(release.version));
  // La première version exige toujours un accord.
  const requiredIndex = Math.max(0, releases.findLastIndex((release) => release.requiresAcceptance));

  const status: DocumentStatus =
    acceptedIndex < requiredIndex ? "acceptance_required" : acceptedIndex < releases.length - 1 ? "updated" : "accepted";

  return {
    status,
    acceptedVersion: releases[acceptedIndex]?.version ?? null,
    /** Résumés des versions publiées depuis le dernier accord. */
    changes: releases.slice(acceptedIndex + 1).map(({ version, summary }) => ({ version, summary })),
  };
}

export function needsAcceptance(acceptances: readonly AcceptedVersions[]): boolean {
  return Object.values(LEGAL_DOCUMENTS).some(
    (document) => documentStatus(document, acceptances).status === "acceptance_required",
  );
}

export function currentVersions(): AcceptedVersions {
  return { termsVersion: currentRelease("terms").version, privacyVersion: currentRelease("privacy").version };
}
