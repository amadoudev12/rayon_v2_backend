/**
 * Pays déduit de l'indicatif d'un numéro au format international normalisé
 * (ex : +2250707057565 → CI). Sert de valeur par défaut quand le pays n'est
 * pas saisi ; null si l'indicatif n'est pas reconnu.
 */
const PREFIXES: [prefix: string, country: string][] = [
  ["+225", "CI"],
  ["+221", "SN"],
  ["+224", "GN"],
  ["+223", "ML"],
  ["+226", "BF"],
  ["+227", "NE"],
  ["+228", "TG"],
  ["+229", "BJ"],
  ["+237", "CM"],
  ["+241", "GA"],
  ["+242", "CG"],
  ["+243", "CD"],
  ["+212", "MA"],
  ["+33", "FR"],
];

export function countryFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return PREFIXES.find(([prefix]) => phone.startsWith(prefix))?.[1] ?? null;
}
