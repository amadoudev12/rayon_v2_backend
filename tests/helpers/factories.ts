import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import type { AuthContext } from "@/lib/auth/session";

/** Vide toutes les tables de la base de test (hors historique des migrations). */
export async function resetDatabase() {
  const tables = await prisma.$queryRawUnsafe<{ name: string }[]>(
    "SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'",
  );
  if (tables.length === 0) return;
  // Une seule instruction pour toutes les tables : `CASCADE` règle les clés
  // étrangères et `RESTART IDENTITY` remet les compteurs d'identifiants à 1.
  const names = tables.map(({ name }) => `"${name}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

let sequence = 0;
const next = () => ++sequence;

/** Contexte d'authentification tel que le produit lib/auth/session pour un membre. */
export function contextFor(
  member: { utilisateurId: number; organisationId: number; role: Role; boutiqueId: number | null },
): AuthContext {
  return {
    userId: member.utilisateurId,
    organizationId: member.organisationId,
    role: member.role,
    membershipStoreId: member.boutiqueId,
  };
}

/** Crée une organisation avec une boutique principale et son propriétaire. */
export async function createShop(name = "Boutique test") {
  const n = next();
  const organisation = await prisma.organisation.create({
    data: { nom: name, slug: `boutique-test-${n}`, devise: "XOF" },
  });
  const boutique = await prisma.boutique.create({
    data: { organisationId: organisation.id, nom: `${name} — principale`, parDefaut: true },
  });
  const owner = await createMember(organisation.id, Role.OWNER);
  return { organisation, boutique, owner, context: contextFor(owner.membre) };
}

/** Crée un utilisateur membre d'une organisation, avec le rôle donné. */
export async function createMember(organisationId: number, role: Role, boutiqueId: number | null = null) {
  const n = next();
  const utilisateur = await prisma.utilisateur.create({
    data: { prenom: `Prénom${n}`, nom: `Nom${n}`, email: `membre${n}@test.local`, motDePasseHash: "non-utilisé" },
  });
  const membre = await prisma.membre.create({
    data: { utilisateurId: utilisateur.id, organisationId, role, boutiqueId },
  });
  return { utilisateur, membre };
}

/** Crée un produit et sa ligne de stock dans la boutique indiquée. */
export async function createProduit(
  organisationId: number,
  boutiqueId: number,
  {
    nom = `Produit ${next()}`,
    prixAchat = 600,
    prixVente = 1000,
    stock = 10,
    seuilAlerte = 5,
    actif = true,
  }: { nom?: string; prixAchat?: number; prixVente?: number; stock?: number; seuilAlerte?: number; actif?: boolean } = {},
) {
  const produit = await prisma.produit.create({
    data: { organisationId, nom, prixAchat, prixVente, seuilAlerte, actif },
  });
  await prisma.stock.create({ data: { boutiqueId, produitId: produit.id, quantite: stock } });
  return produit;
}

/** Quantité en stock d'un produit dans une boutique (0 si aucune ligne). */
export async function stockOf(boutiqueId: number, produitId: number) {
  const stock = await prisma.stock.findUnique({
    where: { boutiqueId_produitId: { boutiqueId, produitId } },
  });
  return stock?.quantite ?? 0;
}
