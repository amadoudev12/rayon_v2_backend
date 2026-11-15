import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { recordSecurityEvent } from "@/lib/auth/security-log";
import { revokeUserSessions } from "@/lib/auth/token";
import type { AuthContext } from "@/lib/auth/session";

/**
 * Changement de mot de passe par son titulaire : l'ancien mot de passe est
 * exigé, le nouveau est haché (bcrypt), l'éventuelle obligation de changement
 * est levée et toutes les AUTRES sessions du compte sont fermées (un appareil
 * volé ou un mot de passe divulgué cessent d'être utilisables).
 */
export async function changeOwnPassword(userId: number, currentSessionId: string | undefined, currentPassword: string, newPassword: string) {
  const user = await prisma.utilisateur.findUniqueOrThrow({ where: { id: userId }, select: { motDePasseHash: true } });
  if (!(await verifyPassword(currentPassword, user.motDePasseHash))) {
    await recordSecurityEvent({ evenement: "password.change_failed", utilisateurId: userId });
    throw Errors.forbidden("Mot de passe actuel incorrect.");
  }
  if (await verifyPassword(newPassword, user.motDePasseHash)) {
    throw Errors.conflict("Le nouveau mot de passe doit être différent de l'actuel.");
  }

  await prisma.utilisateur.update({
    where: { id: userId },
    data: { motDePasseHash: await hashPassword(newPassword), motDePasseModifieLe: new Date(), doitChangerMotDePasse: false },
  });
  const revoked = await revokeUserSessions(userId, "Changement de mot de passe", currentSessionId);
  await recordSecurityEvent({ evenement: "password.changed", utilisateurId: userId, metadonnees: { autresSessionsFermees: revoked } });
}

/** Rôles dont un responsable peut réinitialiser le mot de passe. */
const RESETTABLE_BY: Record<Role, Role[]> = {
  [Role.OWNER]: [Role.ADMIN, Role.MANAGER, Role.SELLER, Role.STOCK_MANAGER],
  [Role.ADMIN]: [Role.MANAGER, Role.SELLER, Role.STOCK_MANAGER],
  [Role.MANAGER]: [],
  [Role.SELLER]: [],
  [Role.STOCK_MANAGER]: [],
};

/**
 * Réinitialisation par un responsable (employé ayant oublié son mot de passe) :
 * le mot de passe temporaire, communiqué de vive voix, devra être changé à la
 * prochaine connexion ; toutes les sessions de l'employé sont fermées.
 * Le propriétaire ne peut être réinitialisé que par l'administration de la
 * plateforme, et un administrateur ne peut pas réinitialiser un autre
 * administrateur.
 */
export async function resetMemberPassword(context: AuthContext, membershipId: number, temporaryPassword: string) {
  const membership = await prisma.membre.findFirst({
    where: { id: membershipId, organisationId: context.organizationId },
    select: { id: true, role: true, utilisateurId: true },
  });
  if (!membership) throw Errors.notFound("Membre introuvable");
  if (membership.utilisateurId === context.userId) {
    throw Errors.conflict("Utilisez « Changer mon mot de passe » pour votre propre compte.");
  }
  if (!RESETTABLE_BY[context.role].includes(membership.role)) {
    throw Errors.forbidden("Votre rôle ne permet pas de réinitialiser le mot de passe de ce membre.");
  }

  await prisma.utilisateur.update({
    where: { id: membership.utilisateurId },
    data: { motDePasseHash: await hashPassword(temporaryPassword), motDePasseModifieLe: new Date(), doitChangerMotDePasse: true },
  });
  const revoked = await revokeUserSessions(membership.utilisateurId, "Mot de passe réinitialisé par un responsable");

  await recordSecurityEvent({
    evenement: "password.reset_by_manager",
    utilisateurId: membership.utilisateurId,
    metadonnees: { parUtilisateurId: context.userId, sessionsFermees: revoked },
  });
  await recordAuditLog({
    organisationId: context.organizationId,
    utilisateurId: context.userId,
    action: "member.password_reset",
    entite: "Membre",
    entiteId: membership.id,
    metadonnees: { utilisateurId: membership.utilisateurId },
  });
}

/** Sessions ouvertes du compte (appareils connectés). */
export function listActiveSessions(userId: number) {
  return prisma.sessionUtilisateur.findMany({
    where: { utilisateurId: userId, revoqueLe: null, expireLe: { gt: new Date() } },
    select: { id: true, audience: true, creeLe: true, derniereUtilisation: true, adresseIp: true, agentUtilisateur: true, expireLe: true },
    orderBy: { derniereUtilisation: "desc" },
  });
}
