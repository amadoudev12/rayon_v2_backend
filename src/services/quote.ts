import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { Prisma } from "@/generated/prisma/client";
import { sumDecimals } from "@/lib/money";
import type { AuthContext } from "@/lib/auth/session";
import type { QuoteFormData } from "@/lib/validations/quote";

export const quoteInclude = {
  lignes: { include: { produit: { select: { id: true, unite: true } } }, orderBy: { id: "asc" } },
  client: { select: { id: true, nom: true, telephone: true, email: true, adresse: true } },
  creePar: { select: { id: true, prenom: true, nom: true } },
  boutique: { select: { id: true, nom: true, adresse: true, telephone: true, organisation: { select: { nom: true } } } },
} satisfies Prisma.DevisInclude;

export type QuoteWithDetails = Prisma.DevisGetPayload<{ include: typeof quoteInclude }>;

/**
 * Enregistre un devis : les prix de vente actuels des produits sont repris et
 * figés sur chaque ligne, la remise est déduite comme pour une vente. Un devis
 * ne réserve ni ne décrémente aucun stock et ne crée ni vente ni créance.
 */
export async function createQuote(context: AuthContext, storeId: number, data: QuoteFormData): Promise<QuoteWithDetails> {
  const { organizationId, userId } = context;

  const quantitiesByProduct = new Map<number, number>();
  for (const line of data.lignes) {
    quantitiesByProduct.set(line.produitId, (quantitiesByProduct.get(line.produitId) ?? 0) + line.quantite);
  }

  const products = await prisma.produit.findMany({
    where: { id: { in: [...quantitiesByProduct.keys()] }, organisationId: organizationId, actif: true },
    select: { id: true, nom: true, prixVente: true },
  });
  if (products.length !== quantitiesByProduct.size) {
    throw Errors.notFound("Un ou plusieurs produits sont introuvables ou inactifs");
  }

  if (data.clientId) {
    const customer = await prisma.client.findFirst({
      where: { id: data.clientId, organisationId: organizationId },
      select: { id: true },
    });
    if (!customer) throw Errors.notFound("Client introuvable");
  }

  const lines = products.map((product) => {
    const quantite = quantitiesByProduct.get(product.id)!;
    return {
      produitId: product.id,
      designation: product.nom,
      quantite,
      prixUnitaire: product.prixVente,
      sousTotal: product.prixVente.times(quantite),
    };
  });
  const sousTotal = sumDecimals(lines.map((line) => line.sousTotal));
  const remise = new Prisma.Decimal(data.remise ?? 0);
  const totalBeforeFloor = sousTotal.minus(remise);

  return prisma.devis.create({
    data: {
      organisationId: organizationId,
      boutiqueId: storeId,
      creeParId: userId,
      clientId: data.clientId ?? null,
      nomClient: data.clientId ? null : data.nomClient || null,
      sousTotal,
      remise,
      total: totalBeforeFloor.isNegative() ? new Prisma.Decimal(0) : totalBeforeFloor,
      valableJusquAu: data.valableJusquAu ?? null,
      note: data.note || null,
      lignes: { create: lines },
    },
    include: quoteInclude,
  });
}

export async function deleteQuote(context: AuthContext, quoteId: number) {
  const deleted = await prisma.devis.deleteMany({
    where: {
      id: quoteId,
      organisationId: context.organizationId,
      ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
    },
  });
  if (deleted.count === 0) throw Errors.notFound("Devis introuvable");
}
