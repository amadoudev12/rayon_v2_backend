/** Bloc de texte d'un document juridique. */
export type LegalBlock =
  | string
  | { list: readonly string[] }
  /** Couples libellé / valeur (identité, durées, cookies…). */
  | { facts: readonly (readonly [label: string, value: string])[] };

export type LegalSection = { id: string; title: string; blocks: readonly LegalBlock[] };

/**
 * Une version publiée d'un document. IMMUABLE : des utilisateurs l'ont
 * acceptée. Toute modification, même d'une virgule, est une nouvelle version
 * (voir docs/DOCUMENTS-JURIDIQUES.md).
 */
export type LegalRelease = {
  version: string;
  /** Date de publication, AAAA-MM-JJ. */
  publishedAt: string;
  /**
   * `true` : un nouvel accord est exigé de tous ceux qui ne l'ont pas donné
   * pour cette version ou une suivante. `false` : simple information.
   */
  requiresAcceptance: boolean;
  /** Ce qui change, montré aux utilisateurs. */
  summary: string;
  intro: readonly string[];
  sections: readonly LegalSection[];
};
