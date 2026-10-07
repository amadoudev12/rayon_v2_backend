/**
 * Filtre Prisma « contient » insensible à la casse.
 *
 * PostgreSQL compare les textes en respectant la casse par défaut : sans
 * `mode`, chercher « riz » ne trouverait pas « Riz parfumé ».
 */
export function containsText(search: string) {
  return { contains: search, mode: "insensitive" as const };
}
