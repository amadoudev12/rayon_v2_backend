import type { Request, Response } from "express";
import { prisma } from "@/lib/prisma";
import { createMemberSchema } from "@/lib/validations/member";
import { hashPassword } from "@/lib/auth/password";
import { identifierTakenMessage, identifierWhere, parseIdentifier } from "@/lib/auth/identifier";
import { Role } from "@/generated/prisma/enums";
import { recordAuditLog } from "@/lib/api/audit";
import { jsonData, jsonMessage, routeId } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

export async function getAllMembers(req: Request, res: Response) {
  const context = req.user;

  const members = await prisma.membre.findMany({
    where: { organisationId: context.organizationId },
    include: {
      utilisateur: { select: { id: true, prenom: true, nom: true, email: true, telephone: true } },
      boutique: { select: { id: true, nom: true } },
    },
    orderBy: { creeLe: "asc" },
  });

  return jsonData(res, members);
}

/**
 * Crée un compte employé directement dans l'organisation de l'appelant. Il
 * n'existe pas encore d'invitation par email ou SMS (aucun fournisseur
 * configuré) : un OWNER/ADMIN définit un mot de passe temporaire et le
 * communique lui-même à l'employé.
 */
export async function createMember(req: Request, res: Response) {
  const context = req.user;

  const parsed = createMemberSchema.parse(req.body);
  // Le schéma a déjà validé le format : l'identifiant est forcément reconnu.
  const identifier = parseIdentifier(parsed.identifiant)!;

  const existing = await prisma.utilisateur.findUnique({ where: identifierWhere(identifier) });
  if (existing) throw Errors.conflict(identifierTakenMessage(identifier));

  if (parsed.boutiqueId) {
    const store = await prisma.boutique.findFirst({
      where: { id: parsed.boutiqueId, organisationId: context.organizationId },
      select: { id: true },
    });
    if (!store) throw Errors.notFound("Boutique introuvable");
  }

  const motDePasseHash = await hashPassword(parsed.motDePasse);

  const membership = await prisma.$transaction(async (tx) => {
    const user = await tx.utilisateur.create({
      data: { prenom: parsed.prenom, nom: parsed.nom, ...identifierWhere(identifier), motDePasseHash },
    });

    return tx.membre.create({
      data: {
        utilisateurId: user.id,
        organisationId: context.organizationId,
        role: parsed.role,
        boutiqueId: parsed.boutiqueId ?? null,
      },
      include: {
        utilisateur: { select: { id: true, prenom: true, nom: true, email: true, telephone: true } },
        boutique: { select: { id: true, nom: true } },
      },
    });
  });

  return jsonData(res, membership, { status: 201 });
}

export async function deleteMember(req: Request, res: Response) {
  const context = req.user;

  const membershipId = routeId(req);

  const membership = await prisma.membre.findFirst({
    where: { id: membershipId, organisationId: context.organizationId },
  });
  if (!membership) throw Errors.notFound("Membre introuvable");
  if (membership.utilisateurId === context.userId) {
    throw Errors.conflict("Vous ne pouvez pas retirer votre propre accès.");
  }
  if (membership.role === Role.OWNER) {
    throw Errors.conflict("Le propriétaire de l'organisation ne peut pas être retiré.");
  }

  // On supprime l'adhésion, pas le compte : les ventes, achats, dépenses et
  // mouvements de stock restent rattachés à leur auteur (et la suppression du
  // compte échouait dès qu'il avait une activité). Sans adhésion, l'accès à
  // l'organisation est coupé dès la requête suivante (voir lib/auth/session).
  await prisma.membre.delete({ where: { id: membership.id } });

  await recordAuditLog({
    organisationId: context.organizationId,
    utilisateurId: context.userId,
    action: "member.removed",
    entite: "Membre",
    entiteId: membership.id,
    metadonnees: { utilisateurId: membership.utilisateurId, role: membership.role },
  });

  return jsonMessage(res, "Membre retiré");
}
