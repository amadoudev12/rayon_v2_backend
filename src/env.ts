/**
 * Configuration lue dans les variables d'environnement (voir `.env.example`).
 * Lue à l'appel et non à l'import : les tests et les scripts peuvent ainsi
 * fixer leurs propres valeurs avant de s'en servir.
 */

const trimSlash = (url: string) => url.trim().replace(/\/+$/, "");

/** Adresse du site web (frontend) : origine autorisée et cible des redirections. */
export function frontendUrl(): string {
  return trimSlash(process.env.FRONTEND_URL ?? "http://localhost:5173");
}

/**
 * Origines autorisées à appeler l'API depuis un navigateur : le site web,
 * plus celles de `CORS_ORIGINS` (ex : l'aperçu web de l'application mobile).
 * L'application mobile native n'est pas concernée : elle n'envoie pas d'origine.
 */
export function allowedOrigins(): string[] {
  const extra = (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map(trimSlash)
    .filter(Boolean);
  return [...new Set([frontendUrl(), ...extra])];
}

export function port(): number {
  return Number(process.env.PORT) || 4000;
}
