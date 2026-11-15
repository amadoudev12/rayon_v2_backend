import { createHash, randomUUID } from "node:crypto";
import { LossStatus, StockMovementType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import type { AuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";

export async function createLoss(context: AuthContext, data: { boutiqueId: number; produitId: number; quantite: number; motif: string; description?: string }, key: string) {
  if (context.membershipStoreId && context.membershipStoreId !== data.boutiqueId) throw Errors.forbidden("Cette boutique ne vous est pas accessible.");
  const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  try {
    return await prisma.$transaction(async (tx) => {
    const existing = await tx.perteStock.findUnique({ where: { organisationId_cleIdempotence: { organisationId: context.organizationId, cleIdempotence: key } } });
    if (existing) {
      if (existing.empreinteIdempotence !== fingerprint) throw Errors.conflict("Cette clé d'idempotence a déjà été utilisée avec d'autres données.");
      return existing;
    }
    const product = await tx.produit.findFirst({ where: { id: data.produitId, organisationId: context.organizationId, actif: true }, select: { id: true, prixAchat: true } });
    if (!product) throw Errors.notFound("Produit introuvable");
    const store = await tx.boutique.findFirst({ where: { id: data.boutiqueId, organisationId: context.organizationId }, select: { id: true } });
    if (!store) throw Errors.forbidden("Boutique invalide");
    await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe") VALUES (${data.boutiqueId}, ${data.produitId}, 0, NOW()) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
    const changed = await tx.$queryRaw<Array<{ quantite: number }>>`UPDATE "Stock" SET "quantite" = "quantite" - ${data.quantite}, "modifieLe" = NOW() WHERE "boutiqueId" = ${data.boutiqueId} AND "produitId" = ${data.produitId} AND "quantite" >= ${data.quantite} RETURNING "quantite"`;
    if (!changed.length) throw Errors.conflict("La quantité demandée dépasse le stock disponible.");
    const after = changed[0]!.quantite;
    const loss = await tx.perteStock.create({ data: { reference: `PER-${randomUUID().slice(0, 8).toUpperCase()}`, organisationId: context.organizationId, boutiqueId: data.boutiqueId, produitId: data.produitId, quantite: data.quantite, motif: data.motif, description: data.description || null, coutUnitaire: product.prixAchat, cleIdempotence: key, empreinteIdempotence: fingerprint, declareParId: context.userId } });
    await tx.mouvementStock.create({ data: { boutiqueId: data.boutiqueId, produitId: data.produitId, utilisateurId: context.userId, type: StockMovementType.LOSS, variationQuantite: -data.quantite, quantiteAvant: after + data.quantite, quantiteApres: after, coutUnitaire: product.prixAchat, creeLe: new Date(), note: data.motif, sourceReference: loss.reference, perteStockId: loss.id } });
    return loss;
    }, { isolationLevel: "Serializable" });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
      const existing = await prisma.perteStock.findUnique({ where: { organisationId_cleIdempotence: { organisationId: context.organizationId, cleIdempotence: key } } });
      if (existing) {
        if (existing.empreinteIdempotence !== fingerprint) throw Errors.conflict("Cette clé d'idempotence a déjà été utilisée avec d'autres données.");
        return existing;
      }
    }
    throw error;
  }
}

export async function cancelLoss(context: AuthContext, id: number, motif: string) {
  return prisma.$transaction(async (tx) => {
    const loss = await tx.perteStock.findFirst({ where: { id, organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) } });
    if (!loss) throw Errors.notFound("Déclaration de perte introuvable");
    if (loss.statut !== LossStatus.ACTIVE) throw Errors.conflict("Cette déclaration est déjà annulée.");
    await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe") VALUES (${loss.boutiqueId}, ${loss.produitId}, 0, NOW()) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
    const changed = await tx.$queryRaw<Array<{ quantite: number }>>`UPDATE "Stock" SET "quantite" = "quantite" + ${loss.quantite}, "modifieLe" = NOW() WHERE "boutiqueId" = ${loss.boutiqueId} AND "produitId" = ${loss.produitId} RETURNING "quantite"`;
    const after = changed[0]!.quantite;
    const updated = await tx.perteStock.updateMany({ where: { id, statut: LossStatus.ACTIVE }, data: { statut: LossStatus.CANCELLED, annuleLe: new Date(), motifAnnulation: motif, annuleParId: context.userId } });
    if (!updated.count) throw Errors.conflict("Cette déclaration a été annulée par un autre utilisateur.");
    await tx.mouvementStock.create({ data: { boutiqueId: loss.boutiqueId, produitId: loss.produitId, utilisateurId: context.userId, type: StockMovementType.LOSS_CANCELLATION, variationQuantite: loss.quantite, quantiteAvant: after - loss.quantite, quantiteApres: after, coutUnitaire: loss.coutUnitaire, creeLe: new Date(), note: motif, sourceReference: loss.reference, perteStockId: loss.id } });
    return tx.perteStock.findUniqueOrThrow({ where: { id } });
  }, { isolationLevel: "Serializable" });
}

export function listLosses(context: AuthContext, boutiqueId?: number) {
  return prisma.perteStock.findMany({ where: { organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : boutiqueId ? { boutiqueId } : {}) }, include: { produit: { select: { id: true, nom: true, unite: true } }, boutique: { select: { nom: true } }, declarePar: { select: { prenom: true, nom: true } } }, orderBy: { creeLe: "desc" } }).then((losses) => losses.map((loss) => ({ ...loss, canCancel: can(context.role, "loss:cancel") })));
}

export async function getLossReport(context: AuthContext, options: { boutiqueId?: number; from?: Date; to?: Date } = {}) {
  const losses = await prisma.perteStock.findMany({ where: { organisationId: context.organizationId, statut: LossStatus.ACTIVE, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : options.boutiqueId ? { boutiqueId: options.boutiqueId } : {}), ...(options.from || options.to ? { creeLe: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) } } : {}) }, include: { produit: { select: { id: true, nom: true } }, boutique: { select: { id: true, nom: true } } }, orderBy: { creeLe: "desc" } });
  const groupes = new Map<string, { motif: string; boutique: string; produit: string; quantite: number; valeur: number }>();
  for (const loss of losses) {
    const key = `${loss.boutiqueId}:${loss.produitId}:${loss.motif}`;
    const group = groupes.get(key) ?? { motif: loss.motif, boutique: loss.boutique.nom, produit: loss.produit.nom, quantite: 0, valeur: 0 };
    group.quantite += loss.quantite;
    group.valeur += loss.quantite * Number(loss.coutUnitaire);
    groupes.set(key, group);
  }
  return { lignes: losses, groupes: [...groupes.values()], quantiteTotale: losses.reduce((sum, loss) => sum + loss.quantite, 0), valeurTotale: losses.reduce((sum, loss) => sum + loss.quantite * Number(loss.coutUnitaire), 0) };
}
