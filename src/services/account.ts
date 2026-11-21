import { prisma } from "@/lib/prisma";
import { PERMISSIONS, ROLE_LABELS, can, type Permission } from "@/lib/auth/permissions";
import { resolveActiveStoreId, type AuthContext } from "@/lib/auth/session";
import { getSubscriptionAccess } from "@/services/subscription";
import { describeEntitlements } from "@/services/billing/entitlements";
import { countUnreadNotifications } from "@/services/notifications";

export type AccountProfile = Awaited<ReturnType<typeof getAccountProfile>>;

/**
 * Tout ce qu'un client (application mobile) doit connaître du compte connecté
 * pour construire son interface : identité, organisation, rôle, boutiques
 * accessibles et permissions.
 *
 * Les permissions sont calculées ici à partir de la matrice du serveur : le
 * client s'en sert pour afficher ou masquer des actions, mais chaque route API
 * revérifie toujours la permission elle-même.
 */
export async function getAccountProfile(context: AuthContext) {
  const [user, organization, stores, defaultStoreId] = await Promise.all([
    prisma.utilisateur.findUniqueOrThrow({
      where: { id: context.userId },
      select: { id: true, prenom: true, nom: true, email: true, telephone: true, doitChangerMotDePasse: true },
    }),
    prisma.organisation.findUniqueOrThrow({
      where: { id: context.organizationId },
      select: { id: true, nom: true, devise: true },
    }),
    prisma.boutique.findMany({
      where: {
        organisationId: context.organizationId,
        // Un membre limité à une boutique ne voit que la sienne.
        ...(context.membershipStoreId ? { id: context.membershipStoreId } : {}),
      },
      select: { id: true, nom: true, parDefaut: true },
      orderBy: [{ parDefaut: "desc" }, { nom: "asc" }],
    }),
    resolveActiveStoreId(context),
  ]);

  return {
    user,
    /** Vrai : le mot de passe temporaire doit être changé avant toute autre opération. */
    doitChangerMotDePasse: user.doitChangerMotDePasse,
    organization,
    role: context.role,
    roleLabel: ROLE_LABELS[context.role],
    stores,
    /** Boutique utilisée tant que l'utilisateur n'en a pas choisi une autre. */
    defaultStoreId,
    /** Vrai quand le membre est rattaché à une seule boutique et ne peut pas en changer. */
    restrictedToStore: context.membershipStoreId !== null,
    permissions: (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => can(context.role, permission)),
    /** État de l'abonnement (UNMANAGED tant que la facturation ne concerne pas l'organisation). */
    subscription: await getSubscriptionAccess(context.organizationId),
    /** Forfait en vigueur et fonctionnalités non incluses (information ; le serveur contrôle). */
    entitlements: await describeEntitlements(context.organizationId),
    unreadNotifications: await countUnreadNotifications(context.userId, context.organizationId),
  };
}
