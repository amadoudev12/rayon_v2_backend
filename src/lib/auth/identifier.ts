/**
 * Identifiant de connexion : une adresse email OU un numéro de téléphone.
 *
 * Module sans dépendance serveur : il est partagé par les schémas de
 * validation (navigateur) et par les routes API, pour que la même saisie soit
 * toujours comprise — et stockée — de la même façon.
 */

export type LoginIdentifier = { kind: "email"; email: string } | { kind: "telephone"; telephone: string };

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Format international E.164 : « + », indicatif du pays, 8 à 15 chiffres au total. */
const PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;

export const IDENTIFIER_FORMAT_MESSAGE =
  "Saisissez une adresse email ou un numéro de téléphone avec l'indicatif du pays (ex : +221 77 123 45 67).";

/**
 * Ramène un numéro à sa forme canonique (`+221771234567`) : espaces, points,
 * tirets et parenthèses retirés, préfixe `00` converti en `+`. L'indicatif du
 * pays est exigé — l'application est utilisée dans plusieurs pays, on ne peut
 * donc pas le deviner. Retourne null si la saisie n'est pas un numéro valide.
 */
export function normalizePhone(value: string): string | null {
  let phone = value.trim().replace(/[\s.\-()]/g, "");
  if (phone.startsWith("00")) phone = `+${phone.slice(2)}`;
  return PHONE_PATTERN.test(phone) ? phone : null;
}

/** Reconnaît et normalise un identifiant ; null s'il n'est ni un email ni un numéro valide. */
export function parseIdentifier(value: string): LoginIdentifier | null {
  const text = value.trim();
  if (text.includes("@")) {
    return EMAIL_PATTERN.test(text) ? { kind: "email", email: text.toLowerCase() } : null;
  }
  const telephone = normalizePhone(text);
  return telephone ? { kind: "telephone", telephone } : null;
}

/** Critère de recherche unique du compte correspondant à l'identifiant. */
export function identifierWhere(identifier: LoginIdentifier) {
  return identifier.kind === "email" ? { email: identifier.email } : { telephone: identifier.telephone };
}

/** Message d'erreur quand l'identifiant appartient déjà à un compte. */
export function identifierTakenMessage(identifier: LoginIdentifier) {
  return identifier.kind === "email"
    ? "Un compte existe déjà avec cet email."
    : "Un compte existe déjà avec ce numéro de téléphone.";
}

/** Coordonnée affichée pour un compte : son email, sinon son numéro de téléphone. */
export function userContact(user: { email: string | null; telephone: string | null }): string {
  return user.email ?? user.telephone ?? "";
}
