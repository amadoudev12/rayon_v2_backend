import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { identifierWhere, parseIdentifier } from "@/lib/auth/identifier";

/**
 * Vérifie un couple identifiant / mot de passe. Point d'entrée unique de la
 * connexion : utilisé par la connexion du site web et par celle de
 * l'application mobile, pour que les deux appliquent exactement les mêmes règles.
 *
 * Retourne null quel que soit le motif du refus (identifiant inconnu, compte
 * désactivé, mot de passe faux) : l'appelant ne doit pas pouvoir les distinguer.
 */
export async function verifyCredentials(identifiant: string, motDePasse: string) {
  if (!identifiant || !motDePasse) return null;

  // Email ou numéro de téléphone : même normalisation qu'à l'inscription.
  const identifier = parseIdentifier(identifiant);
  if (!identifier) return null;

  const user = await prisma.utilisateur.findUnique({ where: identifierWhere(identifier) });
  // Un compte désactivé par le super administrateur ne peut plus se connecter.
  if (!user || !user.actif) return null;

  const isValid = await verifyPassword(motDePasse, user.motDePasseHash);
  if (!isValid) return null;

  return user;
}
