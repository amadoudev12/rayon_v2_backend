import { createHash } from "node:crypto";
import { privacyV1_0 } from "@/legal/documents/privacy-1.0";
import { termsV1_0 } from "@/legal/documents/terms-1.0";
import type { LegalRelease } from "@/legal/types";

export type LegalKind = "terms" | "privacy";

export type LegalDocument = {
  kind: LegalKind;
  slug: string;
  title: string;
  /** Versions publiées, de la plus ancienne à la plus récente. Ajout en fin de liste uniquement. */
  releases: LegalRelease[];
};

/**
 * SEULE source des textes juridiques et de leurs versions : le site et le
 * mobile les lisent par l'API. Publier une version : docs/DOCUMENTS-JURIDIQUES.md.
 */
export const LEGAL_DOCUMENTS: Record<LegalKind, LegalDocument> = {
  terms: {
    kind: "terms",
    slug: "conditions-utilisation",
    title: "Conditions Générales d'Utilisation",
    releases: [termsV1_0],
  },
  privacy: {
    kind: "privacy",
    slug: "politique-confidentialite",
    title: "Politique de confidentialité",
    releases: [privacyV1_0],
  },
};

export function currentRelease(kind: LegalKind): LegalRelease {
  return LEGAL_DOCUMENTS[kind].releases.at(-1)!;
}

/** Empreinte SHA-256 d'une version : atteste que le texte accepté n'a pas changé. */
export function releaseHash(release: LegalRelease): string {
  return createHash("sha256").update(JSON.stringify(release)).digest("hex");
}
