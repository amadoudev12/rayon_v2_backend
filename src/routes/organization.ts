import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuthContext, requirePermission } from "@/lib/auth/session";
import { createMemberSchema, storeSchema } from "@/lib/validations/member";
import { hashPassword } from "@/lib/auth/password";
import { identifierTakenMessage, identifierWhere, parseIdentifier } from "@/lib/auth/identifier";
import { Role } from "@/generated/prisma/enums";
import { recordAuditLog } from "@/lib/api/audit";
import { apiRoute, jsonData, jsonMessage, routeId } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";

export const organizationRouter = Router();

// ---------------------------------------------------------------------------
// Organisation
// ---------------------------------------------------------------------------

const updateSchema = z.object({
  nom: z.string().trim().min(2, "Le nom est requis."),
  devise: z.string().trim().length(3, "Code devise invalide (3 lettres)."),
});

organizationRouter.get(
  "/organization",
  apiRoute(async (_req, res) => {
    const context = await requireAuthContext();
    const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId } });
    return jsonData(res, organization);
  }),
);

organizationRouter.put(
  "/organization",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "org:manage");

    const parsed = updateSchema.parse(req.body);
    const organization = await prisma.organisation.update({
      where: { id: context.organizationId },
      data: { nom: parsed.nom, devise: parsed.devise.toUpperCase() },
    });

    return jsonData(res, organization);
  }),
);

// ---------------------------------------------------------------------------
// Boutiques
// ---------------------------------------------------------------------------

organizationRouter.get(
  "/stores",
  apiRoute(async (_req, res) => {
    const context = await requireAuthContext();

    const stores = await prisma.boutique.findMany({
      where: { organisationId: context.organizationId },
      orderBy: [{ parDefaut: "desc" }, { nom: "asc" }],
    });

    return jsonData(res, stores);
  }),
);

organizationRouter.post(
  "/stores",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "store:manage");

    const parsed = storeSchema.parse(req.body);

    const store = await prisma.$transaction(async (tx) => {
      const createdStore = await tx.boutique.create({
        data: {
          organisationId: context.organizationId,
          nom: parsed.nom,
          adresse: parsed.adresse || null,
          telephone: parsed.telephone || null,
        },
      });

      // Chaque produit du catalogue a besoin d'une ligne de stock (à zéro) dans
      // la nouvelle boutique, pour que l'inventaire n'ait jamais à traiter une
      // ligne manquante comme un cas particulier.
      const products = await tx.produit.findMany({
        where: { organisationId: context.organizationId },
        select: { id: true },
      });
      if (products.length > 0) {
        await tx.stock.createMany({
          data: products.map((product) => ({ boutiqueId: createdStore.id, produitId: product.id, quantite: 0 })),
        });
      }

      return createdStore;
    });

    return jsonData(res, store, { status: 201 });
  }),
);

// ---------------------------------------------------------------------------
// Membres
// ---------------------------------------------------------------------------

organizationRouter.get(
  "/members",
  apiRoute(async (_req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "members:manage");

    const members = await prisma.membre.findMany({
      where: { organisationId: context.organizationId },
      include: {
        utilisateur: { select: { id: true, prenom: true, nom: true, email: true, telephone: true } },
        boutique: { select: { id: true, nom: true } },
      },
      orderBy: { creeLe: "asc" },
    });

    return jsonData(res, members);
  }),
);

/**
 * Crée un compte employé directement dans l'organisation de l'appelant. Il
 * n'existe pas encore d'invitation par email ou SMS (aucun fournisseur
 * configuré) : un OWNER/ADMIN définit un mot de passe temporaire et le
 * communique lui-même à l'employé.
 */
organizationRouter.post(
  "/members",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "members:manage");

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
  }),
);

organizationRouter.delete(
  "/members/:id",
  apiRoute(async (req, res) => {
    const context = await requireAuthContext();
    requirePermission(context, "members:manage");

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
  }),
);
