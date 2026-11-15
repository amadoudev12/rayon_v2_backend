import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { recordAuditLog } from "@/lib/api/audit";
import { PaymentMethod, PurchaseStatus, StockMovementType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { sumDecimals } from "@/lib/money";
import { runTransaction, type Tx } from "@/lib/transactions";
import type { AuthContext } from "@/lib/auth/session";
import type { PurchaseFormData } from "@/lib/validations/purchase";
import { fingerprintOf } from "@/services/sale";

export const purchaseInclude = {
  lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } }, orderBy: { id: "asc" } },
  fournisseur: { select: { id: true, nom: true, telephone: true } },
  creePar: { select: { id: true, prenom: true, nom: true } },
  annulePar: { select: { id: true, prenom: true, nom: true } },
  boutique: { select: { id: true, nom: true, adresse: true, telephone: true, organisation: { select: { nom: true } } } },
  paiements: { orderBy: { date: "asc" }, include: { utilisateur: { select: { id: true, prenom: true, nom: true } } } },
} satisfies Prisma.AchatInclude;

export type PurchaseWithDetails = Prisma.AchatGetPayload<{ include: typeof purchaseInclude }>;

type Tender = Exclude<PaymentMethod, "CREDIT">;

function purchaseScope(context: AuthContext) {
  return { organisationId: context.organizationId, ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}) };
}

/** Verrouille l'achat (FOR UPDATE) : paiements et annulation d'un même achat sont sérialisés. */
async function lockPurchase(tx: Tx, context: AuthContext, purchaseId: number) {
  const rows = context.membershipStoreId
    ? await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Achat" WHERE "id" = ${purchaseId} AND "organisationId" = ${context.organizationId} AND "boutiqueId" = ${context.membershipStoreId} FOR UPDATE`
    : await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Achat" WHERE "id" = ${purchaseId} AND "organisationId" = ${context.organizationId} FOR UPDATE`;
  if (rows.length !== 1) throw Errors.notFound("Achat introuvable");
  return tx.achat.findUniqueOrThrow({ where: { id: purchaseId }, include: { lignes: true } });
}

const loadPurchase = (tx: Tx | typeof prisma, id: number) => tx.achat.findUniqueOrThrow({ where: { id }, include: purchaseInclude });

/**
 * Enregistre une livraison fournisseur : le stock est augmenté immédiatement
 * et un mouvement de stock est journalisé par ligne. Le montant versé ouvre
 * l'historique des paiements fournisseur ; le reste est dû au fournisseur.
 *
 * Idempotent : rejouer la même requête (même clé) après une coupure réseau
 * renvoie l'achat déjà enregistré, sans doubler ni le stock ni la dette.
 *
 * Valorisation au dernier prix d'achat : le coût de chaque produit reçu
 * devient son prix d'achat ; les ventes passées gardent leur coût figé.
 */
export async function createPurchase(
  context: AuthContext,
  storeId: number,
  data: Omit<PurchaseFormData, "modePaiement"> & { modePaiement?: Tender },
  idempotencyKey?: string,
): Promise<PurchaseWithDetails> {
  const { organizationId, userId } = context;
  const fingerprint = idempotencyKey ? fingerprintOf({ storeId, data }) : null;
  if (idempotencyKey) {
    const existing = await prisma.achat.findFirst({ where: { organisationId: organizationId, cleIdempotence: idempotencyKey }, include: purchaseInclude });
    if (existing) {
      if (existing.empreinteIdempotence !== fingerprint) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre achat.");
      return existing;
    }
  }

  const products = await prisma.produit.findMany({
    where: { id: { in: data.lignes.map((line) => line.produitId) }, organisationId: organizationId },
    select: { id: true, nom: true },
  });
  const productsById = new Map(products.map((product) => [product.id, product]));
  if (productsById.size !== new Set(data.lignes.map((line) => line.produitId)).size) {
    throw Errors.notFound("Un ou plusieurs produits sont introuvables");
  }

  if (data.fournisseurId) {
    const supplier = await prisma.fournisseur.findFirst({
      where: { id: data.fournisseurId, organisationId: organizationId, archive: false },
      select: { id: true },
    });
    if (!supplier) throw Errors.notFound("Fournisseur introuvable ou archivé");
  }

  const lines = data.lignes.map((line) => ({
    ...line,
    produit: productsById.get(line.produitId)!,
    coutUnitaire: new Prisma.Decimal(line.coutUnitaire).toDecimalPlaces(2),
    sousTotal: new Prisma.Decimal(line.coutUnitaire).toDecimalPlaces(2).times(line.quantite),
  }));
  const total = sumDecimals(lines.map((line) => line.sousTotal));
  const montantPaye = data.montantPaye !== undefined ? new Prisma.Decimal(data.montantPaye).toDecimalPlaces(2) : total;
  if (montantPaye.greaterThan(total)) {
    throw Errors.conflict("Le montant payé ne peut pas dépasser le total de l'achat.");
  }

  try {
    return await runTransaction(async (tx) => {
      const purchase = await tx.achat.create({
        data: {
          organisationId: organizationId,
          boutiqueId: storeId,
          fournisseurId: data.fournisseurId ?? null,
          creeParId: userId,
          total,
          montantPaye,
          resteAPayer: total.minus(montantPaye),
          note: data.note || null,
          cleIdempotence: idempotencyKey,
          empreinteIdempotence: fingerprint,
          lignes: {
            create: lines.map((line) => ({ produitId: line.produitId, quantite: line.quantite, coutUnitaire: line.coutUnitaire, sousTotal: line.sousTotal })),
          },
          paiements: montantPaye.isZero() ? undefined : { create: { montant: montantPaye, modePaiement: data.modePaiement ?? PaymentMethod.CASH, utilisateurId: userId } },
        },
      });

      const quantitiesAfter = new Map<number, number>();
      for (const line of [...lines].sort((a, b) => a.produitId - b.produitId)) {
        await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe") VALUES (${storeId}, ${line.produitId}, 0, NOW()) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
        const updated = await tx.$queryRaw<{ quantite: number }[]>`UPDATE "Stock" SET "quantite" = "quantite" + ${line.quantite}, "modifieLe" = NOW() WHERE "boutiqueId" = ${storeId} AND "produitId" = ${line.produitId} RETURNING "quantite"`;
        quantitiesAfter.set(line.produitId, updated[0]!.quantite);
        await tx.produit.update({ where: { id: line.produitId }, data: { prixAchat: line.coutUnitaire } });
      }

      await tx.mouvementStock.createMany({
        data: lines.map((line) => ({
          boutiqueId: storeId,
          produitId: line.produitId,
          utilisateurId: userId,
          type: StockMovementType.PURCHASE,
          variationQuantite: line.quantite,
          quantiteAvant: quantitiesAfter.get(line.produitId)! - line.quantite,
          quantiteApres: quantitiesAfter.get(line.produitId)!,
          coutUnitaire: line.coutUnitaire,
          creeLe: new Date(),
          sourceReference: `Achat #${purchase.id}`,
          achatId: purchase.id,
        })),
      });

      await recordAuditLog(
        { organisationId: organizationId, utilisateurId: userId, action: "purchase.created", entite: "Achat", entiteId: purchase.id, metadonnees: { total: total.toString(), montantPaye: montantPaye.toString() } },
        tx,
      );
      return loadPurchase(tx, purchase.id);
    });
  } catch (error) {
    if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.achat.findFirst({ where: { organisationId: organizationId, cleIdempotence: idempotencyKey }, include: purchaseInclude });
      if (existing?.empreinteIdempotence === fingerprint) return existing;
      if (existing) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre achat.");
    }
    throw error;
  }
}

/** Règlement (total ou partiel) d'une dette fournisseur, idempotent. */
export async function addSupplierPayment(context: AuthContext, purchaseId: number, amount: number, modePaiement: Tender, idempotencyKey: string) {
  const montant = new Prisma.Decimal(amount).toDecimalPlaces(2);
  if (!montant.greaterThan(0)) throw Errors.conflict("Le montant doit être supérieur à 0.");

  return runTransaction(async (tx) => {
    const purchase = await lockPurchase(tx, context, purchaseId);
    const prior = await tx.paiementFournisseur.findUnique({ where: { achatId_cleIdempotence: { achatId: purchase.id, cleIdempotence: idempotencyKey } } });
    if (prior) {
      if (!prior.montant.equals(montant) || prior.modePaiement !== modePaiement) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre paiement.");
      return loadPurchase(tx, purchase.id);
    }
    if (purchase.statut !== PurchaseStatus.RECEIVED) throw Errors.conflict("Cet achat est annulé : aucun paiement ne peut être enregistré.");
    if (purchase.resteAPayer.isZero()) throw Errors.conflict("Cet achat est déjà réglé.");
    if (montant.greaterThan(purchase.resteAPayer)) {
      throw Errors.conflict(`Le montant dépasse le reste dû au fournisseur (${purchase.resteAPayer.toNumber().toLocaleString("fr-FR")}).`);
    }

    await tx.paiementFournisseur.create({ data: { achatId: purchase.id, montant, modePaiement, cleIdempotence: idempotencyKey, utilisateurId: context.userId } });
    await tx.achat.update({
      where: { id: purchase.id },
      data: { montantPaye: purchase.montantPaye.plus(montant), resteAPayer: purchase.resteAPayer.minus(montant) },
    });
    await recordAuditLog(
      { organisationId: purchase.organisationId, utilisateurId: context.userId, action: "purchase.payment_added", entite: "Achat", entiteId: purchase.id, metadonnees: { montant: montant.toString(), modePaiement } },
      tx,
    );
    return loadPurchase(tx, purchase.id);
  });
}

/**
 * Annule un achat saisi par erreur ou retourné en totalité au fournisseur :
 * contre-mouvement de stock par ligne (PURCHASE_CANCELLATION), dette ramenée
 * à 0. Refusé si une partie des articles a déjà été vendue (le stock
 * deviendrait négatif). Les paiements déjà versés restent dans l'historique :
 * ils sont à récupérer auprès du fournisseur. Idempotent.
 */
export async function cancelPurchase(context: AuthContext, purchaseId: number, motif: string, idempotencyKey: string) {
  return runTransaction(async (tx) => {
    const purchase = await lockPurchase(tx, context, purchaseId);
    if (purchase.statut === PurchaseStatus.CANCELLED) {
      if (purchase.cleAnnulation === idempotencyKey) return loadPurchase(tx, purchase.id);
      throw Errors.conflict("Cet achat est déjà annulé.");
    }

    const products = await tx.produit.findMany({ where: { id: { in: purchase.lignes.map((line) => line.produitId) } }, select: { id: true, nom: true } });
    const names = new Map(products.map((product) => [product.id, product.nom]));
    const after = new Map<number, number>();
    for (const line of [...purchase.lignes].sort((a, b) => a.produitId - b.produitId)) {
      const rows = await tx.$queryRaw<{ quantite: number }[]>`UPDATE "Stock" SET "quantite" = "quantite" - ${line.quantite}, "modifieLe" = NOW()
        WHERE "boutiqueId" = ${purchase.boutiqueId} AND "produitId" = ${line.produitId} AND "quantite" >= ${line.quantite} RETURNING "quantite"`;
      if (rows.length !== 1) {
        throw Errors.conflict(
          `Impossible d'annuler : une partie de « ${names.get(line.produitId) ?? "produit"} » a déjà été vendue ou sortie du stock. Déclarez plutôt une perte ou un retour partiel.`,
        );
      }
      after.set(line.produitId, rows[0]!.quantite);
    }
    await tx.mouvementStock.createMany({
      data: purchase.lignes.map((line) => ({
        boutiqueId: purchase.boutiqueId,
        produitId: line.produitId,
        utilisateurId: context.userId,
        type: StockMovementType.PURCHASE_CANCELLATION,
        variationQuantite: -line.quantite,
        quantiteAvant: after.get(line.produitId)! + line.quantite,
        quantiteApres: after.get(line.produitId)!,
        coutUnitaire: line.coutUnitaire,
        creeLe: new Date(),
        sourceReference: `Annulation achat #${purchase.id}`,
        note: motif,
        achatId: purchase.id,
      })),
    });

    await tx.achat.update({
      where: { id: purchase.id },
      data: { statut: PurchaseStatus.CANCELLED, resteAPayer: 0, annuleLe: new Date(), annuleParId: context.userId, motifAnnulation: motif, cleAnnulation: idempotencyKey },
    });
    await recordAuditLog(
      {
        organisationId: purchase.organisationId,
        utilisateurId: context.userId,
        action: "purchase.cancelled",
        entite: "Achat",
        entiteId: purchase.id,
        metadonnees: { motif, aRecupererAupresDuFournisseur: purchase.montantPaye.toString() },
      },
      tx,
    );
    return loadPurchase(tx, purchase.id);
  });
}

export function getPurchase(context: AuthContext, purchaseId: number) {
  return prisma.achat.findFirst({ where: { id: purchaseId, ...purchaseScope(context) }, include: purchaseInclude });
}
