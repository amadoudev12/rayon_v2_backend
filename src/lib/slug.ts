import { randomBytes } from "crypto";

/** Turns "Boutique Fatou & Co" into "boutique-fatou-co-a1b2c3", unique enough
 * to skip a pre-check round-trip while staying readable. */
export function slugify(value: string): string {
  const base = value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const suffix = randomBytes(3).toString("hex");
  return `${base || "boutique"}-${suffix}`;
}
