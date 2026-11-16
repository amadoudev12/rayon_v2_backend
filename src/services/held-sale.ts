import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { PaymentMethod } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { runTransaction } from "@/lib/transactions";
import { saleItemSchema, tenderSchema } from "@/lib/validations/sale";
import type { AuthContext } from "@/lib/auth/session";

/**
 * Ventes en attente : un panier mis de côté au comptoir pour servir un autre
 * client, puis repris (par n'importe quel membre de la boutique).
 *
 * - Rien n'est encaissé, rien ne sort du stock : à la reprise, la vente suit
 *   le parcours normal et le serveur revérifie stock, prix et remises.
 * - Reprise ATOMIQUE : la vente en attente est retirée au moment où elle est
 *   reprise ; deux caissiers ne peuvent pas reprendre la même.
 * - Expiration après 24 h (nettoyage automatique), 30 au plus par boutique.
 */
export const HELD_SALE_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_HELD_SALES_PER_STORE = 30;

export const heldCartSchema = z.object({
  lignes: z.array(saleItemSchema).min(1, "Le panier est vide.").max(500),
  clientId: z.coerce.number().int().positive().optional().nullable(),
  modePaiement: z.enum(PaymentMethod).default("CASH"),
  remise: z.coerce.number().nonnegative().default(0),
  montantPaye: z.coerce.number().nonnegative().optional().nullable(),
  modePaiementAcompte: tenderSchema.optional().nullable(),
  dateEcheance: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  note: z.string().trim().max(1000).optional().nullable(),
  devisId: z.coerce.number().int().positive().optional().nullable(),
});

export const holdSaleSchema = z.object({
  libelle: z.string().trim().max(80).optional().or(z.literal("")),
  panier: heldCartSchema,
});

export type HeldCart = z.infer<typeof heldCartSchema>;

const scope = (context: AuthContext, storeId: number) => ({
  organisationId: context.organizationId,
  boutiqueId: storeId,
});

export async function holdSale(context: AuthContext, storeId: number, input: z.infer<typeof holdSaleSchema>) {
  const { panier } = input;
  const productIds = [...new Set(panier.lignes.map((line) => line.produitId))];
  const [products, customer] = await Promise.all([
    prisma.produit.findMany({ where: { id: { in: productIds }, organisationId: context.organizationId }, select: { id: true, prixVente: true } }),
    panier.clientId
      ? prisma.client.findFirst({ where: { id: panier.clientId, organisationId: context.organizationId, archive: false }, select: { id: true, nom: true } })
      : Promise.resolve(null),
  ]);
  if (products.length !== productIds.length) throw Errors.notFound("Un ou plusieurs produits du panier sont introuvables.");
  if (panier.clientId && !customer) throw Errors.notFound("Client introuvable ou archivé.");

  const priceById = new Map(products.map((product) => [product.id, product.prixVente]));
  const subtotal = panier.lignes.reduce(
    (sum, line) => sum.plus(new Prisma.Decimal(line.prixUnitaire ?? priceById.get(line.produitId)!).times(line.quantite)),
    new Prisma.Decimal(0),
  );
  const estimate = Prisma.Decimal.max(subtotal.minus(panier.remise ?? 0), 0).toDecimalPlaces(2);
  const articles = panier.lignes.reduce((sum, line) => sum + line.quantite, 0);

  return runTransaction(async (tx) => {
    await tx.venteEnAttente.deleteMany({ where: { ...scope(context, storeId), expireLe: { lt: new Date() } } });
    const active = await tx.venteEnAttente.count({ where: scope(context, storeId) });
    if (active >= MAX_HELD_SALES_PER_STORE) {
      throw Errors.conflict(`${MAX_HELD_SALES_PER_STORE} ventes sont déjà en attente dans cette boutique : reprenez-en ou supprimez-en une.`);
    }
    const libelle = input.libelle?.trim() || customer?.nom || `Client ${active + 1}`;
    return tx.venteEnAttente.create({
      data: {
        ...scope(context, storeId),
        libelle,
        panier: panier as Prisma.InputJsonValue,
        nombreArticles: articles,
        totalEstime: estimate,
        expireLe: new Date(Date.now() + HELD_SALE_TTL_MS),
        clientId: customer?.id ?? null,
        creeParId: context.userId,
      },
      select: heldSaleSelect,
    });
  });
}

const heldSaleSelect = {
  id: true,
  libelle: true,
  nombreArticles: true,
  totalEstime: true,
  creeLe: true,
  expireLe: true,
  client: { select: { id: true, nom: true } },
  creePar: { select: { id: true, prenom: true, nom: true } },
} satisfies Prisma.VenteEnAttenteSelect;

export function listHeldSales(context: AuthContext, storeId: number) {
  return prisma.venteEnAttente.findMany({
    where: { ...scope(context, storeId), expireLe: { gt: new Date() } },
    orderBy: { creeLe: "asc" },
    select: heldSaleSelect,
  });
}

/** Reprend une vente en attente : elle est retirée de la liste et son panier renvoyé. */
export async function resumeHeldSale(context: AuthContext, storeId: number, heldSaleId: number) {
  return runTransaction(async (tx) => {
    const held = await tx.venteEnAttente.findFirst({
      where: { id: heldSaleId, ...scope(context, storeId), expireLe: { gt: new Date() } },
      select: { id: true, libelle: true, panier: true },
    });
    if (!held) throw Errors.notFound("Cette vente en attente a déjà été reprise, supprimée ou a expiré.");
    const removed = await tx.venteEnAttente.deleteMany({ where: { id: held.id } });
    if (removed.count !== 1) throw Errors.notFound("Cette vente en attente vient d'être reprise par quelqu'un d'autre.");
    return { libelle: held.libelle, panier: heldCartSchema.parse(held.panier) };
  });
}

export async function deleteHeldSale(context: AuthContext, storeId: number, heldSaleId: number) {
  const removed = await prisma.venteEnAttente.deleteMany({ where: { id: heldSaleId, ...scope(context, storeId) } });
  if (removed.count === 0) throw Errors.notFound("Vente en attente introuvable.");
}
