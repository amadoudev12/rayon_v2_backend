import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { Errors } from "@/lib/api/errors";
import { CancellationKind, PaymentMethod, RefundStatus, SaleStatus, StockMovementType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";
import { sumDecimals } from "@/lib/money";
import { runTransaction, type Tx } from "@/lib/transactions";
import { addDateKeyDays, dateKeyAt, startOfDateKey } from "@/lib/timezone";
import { recordAuditLog } from "@/lib/api/audit";
import type { AuthContext } from "@/lib/auth/session";
import type { SaleFormData } from "@/lib/validations/sale";
import { customerBalance, uncoveredOverpayment } from "@/services/sale-balance";

/**
 * Détail complet d'une vente. Les coûts figés (`coutUnitaire`, `coutTotal`)
 * y figurent : les réponses HTTP passent TOUJOURS par `serializeSale`, qui
 * les retire pour les rôles non autorisés.
 */
export const saleInclude = {
  lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } }, orderBy: { id: "asc" } },
  client: { select: { id: true, nom: true, telephone: true } },
  vendeur: { select: { id: true, prenom: true, nom: true } },
  boutique: { select: { id: true, nom: true, adresse: true, telephone: true, organisation: { select: { nom: true } } } },
  paiements: {
    orderBy: { date: "asc" },
    include: {
      utilisateur: { select: { id: true, prenom: true, nom: true } },
      annulePar: { select: { id: true, prenom: true, nom: true } },
    },
  },
  remboursements: {
    orderBy: { creeLe: "asc" },
    include: {
      demandePar: { select: { id: true, prenom: true, nom: true } },
      versements: { orderBy: { date: "asc" }, include: { utilisateur: { select: { id: true, prenom: true, nom: true } } } },
    },
  },
  retours: {
    orderBy: { creeLe: "asc" },
    include: {
      creePar: { select: { id: true, prenom: true, nom: true } },
      lignes: { include: { produit: { select: { id: true, nom: true, unite: true } } }, orderBy: { id: "asc" } },
    },
  },
  annulePar: { select: { id: true, prenom: true, nom: true } },
} satisfies Prisma.VenteInclude;

export type SaleWithDetails = Prisma.VenteGetPayload<{ include: typeof saleInclude }>;

/** Filtre « vente accessible » : organisation, et boutique imposée au membre. */
export function saleScope(context: AuthContext) {
  return {
    organisationId: context.organizationId,
    ...(context.membershipStoreId ? { boutiqueId: context.membershipStoreId } : {}),
  };
}

export function loadSale(tx: Tx | typeof prisma, saleId: number) {
  return tx.vente.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
}

/**
 * Verrouille la ligne de la vente (FOR UPDATE) jusqu'à la fin de la
 * transaction : paiements, retours, annulations et remboursements d'une même
 * vente sont ainsi strictement sérialisés. Lève 404 hors du périmètre.
 */
export async function lockSale(tx: Tx, context: AuthContext, saleId: number) {
  const rows = context.membershipStoreId
    ? await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Vente" WHERE "id" = ${saleId} AND "organisationId" = ${context.organizationId} AND "boutiqueId" = ${context.membershipStoreId} FOR UPDATE`
    : await tx.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Vente" WHERE "id" = ${saleId} AND "organisationId" = ${context.organizationId} FOR UPDATE`;
  if (rows.length !== 1) throw Errors.notFound("Vente introuvable");
  return tx.vente.findUniqueOrThrow({ where: { id: saleId }, include: { lignes: true } });
}

export function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Regroupe les lignes d'un même produit (quantités additionnées) et garde le
 * prix négocié éventuel. Deux prix différents pour un même produit sont refusés.
 */
export function groupLines(lignes: SaleFormData["lignes"]) {
  const byProduct = new Map<number, { produitId: number; quantite: number; prixUnitaire?: number }>();
  for (const line of lignes) {
    const existing = byProduct.get(line.produitId);
    if (!existing) {
      byProduct.set(line.produitId, { ...line });
      continue;
    }
    if (line.prixUnitaire !== undefined && existing.prixUnitaire !== undefined && line.prixUnitaire !== existing.prixUnitaire) {
      throw Errors.conflict("Un même produit ne peut pas avoir deux prix différents dans le panier.");
    }
    existing.quantite += line.quantite;
    existing.prixUnitaire ??= line.prixUnitaire;
  }
  return [...byProduct.values()];
}

/** Prix appliqué à une ligne : le prix négocié s'il est fourni, sinon le prix de vente du produit. */
export function unitPriceOf(line: { prixUnitaire?: number }, produit: { prixVente: Prisma.Decimal }): Prisma.Decimal {
  return line.prixUnitaire !== undefined ? new Prisma.Decimal(line.prixUnitaire).toDecimalPlaces(2) : produit.prixVente;
}

/**
 * Montant encaissé à la création de la vente :
 * - vente à crédit : le premier versement (0 par défaut), au plus le total ;
 * - autres modes : la vente est payée en totalité (un montant remis supérieur
 *   au total est de la monnaie rendue, pas un encaissement).
 */
function initialPayment(data: SaleFormData, total: Prisma.Decimal): Prisma.Decimal {
  if (data.modePaiement === PaymentMethod.CREDIT) {
    const paid = new Prisma.Decimal(data.montantPaye ?? 0).toDecimalPlaces(2);
    if (paid.greaterThan(total)) {
      throw Errors.conflict("Le premier versement ne peut pas dépasser le total de la vente.");
    }
    return paid;
  }
  if (data.montantPaye !== undefined && new Prisma.Decimal(data.montantPaye).lessThan(total)) {
    throw Errors.conflict("Paiement partiel : choisissez le mode « Crédit client ».");
  }
  return total;
}

/** Contrôle des prix et remises, appelé avant l'écriture (voir services/pricing-policy). */
export type PriceCheck = (input: {
  lines: { produitId: number; nom: string; prixCatalogue: Prisma.Decimal; prixUnitaire: Prisma.Decimal; cout: Prisma.Decimal; quantite: number }[];
  sousTotal: Prisma.Decimal;
  remise: Prisma.Decimal;
}) => Promise<void> | void;

/**
 * Enregistre une vente de bout en bout : vérifie que chaque produit appartient
 * à l'organisation, décrémente le stock de façon atomique (la vente entière est
 * refusée si une ligne manque de stock), fige le prix et le coût sur chaque
 * ligne et journalise un mouvement de stock par ligne, le tout dans une seule
 * transaction pour ne jamais laisser une vente à moitié appliquée.
 */
export async function createSale(
  context: AuthContext,
  storeId: number,
  data: SaleFormData,
  idempotencyKey?: string,
  checkPrices?: PriceCheck,
): Promise<SaleWithDetails> {
  const { organizationId, userId } = context;
  const fingerprint = idempotencyKey ? fingerprintOf({ storeId, data }) : null;
  if (idempotencyKey) {
    const existing = await prisma.vente.findFirst({ where: { organisationId: organizationId, cleIdempotence: idempotencyKey }, include: saleInclude });
    if (existing) {
      if (existing.empreinteIdempotence !== fingerprint) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour une autre vente.");
      return existing;
    }
  }

  const lines = groupLines(data.lignes);

  // Une créance doit pouvoir être réclamée : le client est obligatoire.
  if (data.modePaiement === PaymentMethod.CREDIT && !data.clientId) {
    throw Errors.conflict("Sélectionnez le client pour une vente à crédit.");
  }

  if (data.dateEcheance && data.modePaiement !== PaymentMethod.CREDIT) {
    throw Errors.conflict("Une échéance ne concerne qu'une vente à crédit.");
  }
  // Échéance = fin de la journée indiquée, dans le fuseau de l'organisation.
  let dueDate: Date | null = null;
  if (data.dateEcheance) {
    const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: organizationId }, select: { fuseauHoraire: true } });
    const today = dateKeyAt(new Date(), organization.fuseauHoraire);
    if (data.dateEcheance < today) throw Errors.conflict("L'échéance ne peut pas être dans le passé.");
    dueDate = new Date(startOfDateKey(addDateKeyDays(data.dateEcheance, 1), organization.fuseauHoraire).getTime() - 1);
  }

  if (data.clientId) {
    const customer = await prisma.client.findFirst({
      where: { id: data.clientId, organisationId: organizationId, archive: false },
      select: { id: true },
    });
    if (!customer) throw Errors.notFound("Client introuvable ou archivé");
  }

  try {
    return await runTransaction(async (tx) => {
      const products = await tx.produit.findMany({
        where: { id: { in: lines.map((line) => line.produitId) }, organisationId: organizationId, actif: true },
        select: { id: true, nom: true, prixVente: true, prixAchat: true },
      });
      const productsById = new Map(products.map((product) => [product.id, product]));

      if (productsById.size !== lines.length) {
        throw Errors.notFound("Un ou plusieurs produits sont introuvables ou inactifs");
      }

      const saleLines = lines.map((line) => {
        const produit = productsById.get(line.produitId)!;
        const prixUnitaire = unitPriceOf(line, produit);
        return { ...line, produit, prixUnitaire, sousTotal: prixUnitaire.times(line.quantite) };
      });

      const sousTotal = sumDecimals(saleLines.map((line) => line.sousTotal));
      const remise = new Prisma.Decimal(data.remise ?? 0).toDecimalPlaces(2);
      if (remise.greaterThan(sousTotal)) throw Errors.conflict("La remise ne peut pas dépasser le sous-total.");

      await checkPrices?.({
        lines: saleLines.map((line) => ({
          produitId: line.produitId,
          nom: line.produit.nom,
          prixCatalogue: line.produit.prixVente,
          prixUnitaire: line.prixUnitaire,
          cout: line.produit.prixAchat,
          quantite: line.quantite,
        })),
        sousTotal,
        remise,
      });

      const quantitiesAfter = new Map<number, number>();
      for (const line of [...saleLines].sort((a, b) => a.produitId - b.produitId)) {
        const updated = await tx.$queryRaw<Array<{ quantite: number }>>`
          UPDATE "Stock"
          SET "quantite" = "quantite" - ${line.quantite}, "modifieLe" = NOW()
          WHERE "boutiqueId" = ${storeId} AND "produitId" = ${line.produitId} AND "quantite" >= ${line.quantite}
          RETURNING "quantite"`;
        if (updated.length !== 1) {
          throw Errors.conflict(`Stock insuffisant pour "${line.produit.nom}"`);
        }
        quantitiesAfter.set(line.produitId, updated[0]!.quantite);
      }

      const total = sousTotal.minus(remise).toDecimalPlaces(2);
      const montantPaye = initialPayment(data, total);
      const tender = data.modePaiement === PaymentMethod.CREDIT ? (data.modePaiementAcompte ?? PaymentMethod.CASH) : data.modePaiement;

      const sale = await tx.vente.create({
        data: {
          organisationId: organizationId,
          boutiqueId: storeId,
          vendeurId: userId,
          clientId: data.clientId ?? null,
          modePaiement: data.modePaiement,
          sousTotal,
          remise,
          total,
          montantPaye,
          resteAPayer: total.minus(montantPaye),
          note: data.note || null,
          dateEcheance: dueDate,
          cleIdempotence: idempotencyKey,
          empreinteIdempotence: fingerprint,
          lignes: {
            create: saleLines.map((line) => ({
              produitId: line.produitId,
              quantite: line.quantite,
              prixUnitaire: line.prixUnitaire,
              coutUnitaire: line.produit.prixAchat,
              sousTotal: line.sousTotal,
            })),
          },
          // Le paiement initial ouvre l'historique des paiements de la vente.
          paiements: montantPaye.isZero() ? undefined : { create: { montant: montantPaye, modePaiement: tender, utilisateurId: userId } },
        },
      });

      await tx.mouvementStock.createMany({
        data: saleLines.map((line) => ({
          boutiqueId: storeId,
          produitId: line.produitId,
          utilisateurId: userId,
          type: StockMovementType.SALE,
          variationQuantite: -line.quantite,
          quantiteAvant: quantitiesAfter.get(line.produitId)! + line.quantite,
          quantiteApres: quantitiesAfter.get(line.produitId)!,
          coutUnitaire: line.produit.prixAchat,
          creeLe: new Date(),
          sourceReference: `Vente #${sale.id}`,
          venteId: sale.id,
        })),
      });

      // Toute dérogation au prix catalogue (prix négocié, remise) est tracée.
      const overrides = saleLines.filter((line) => !line.prixUnitaire.equals(line.produit.prixVente));
      if (overrides.length > 0 || remise.greaterThan(0)) {
        await recordAuditLog(
          {
            organisationId: organizationId,
            utilisateurId: userId,
            action: "sale.price_override",
            entite: "Sale",
            entiteId: sale.id,
            metadonnees: {
              remise: remise.toString(),
              sousTotal: sousTotal.toString(),
              total: total.toString(),
              lignes: overrides.map((line) => ({
                produitId: line.produitId,
                prixCatalogue: line.produit.prixVente.toString(),
                prixApplique: line.prixUnitaire.toString(),
                quantite: line.quantite,
              })),
            },
          },
          tx,
        );
      }

      // Devis transformé : il est relié à la vente, une seule fois. Sinon toute
      // la vente est annulée (stock compris) par l'échec de la transaction.
      if (data.devisId) {
        const linked = await tx.devis.updateMany({
          where: { id: data.devisId, organisationId: organizationId, boutiqueId: storeId, venteId: null },
          data: { venteId: sale.id },
        });
        if (linked.count !== 1) {
          throw Errors.conflict("Ce devis est introuvable ou a déjà été transformé en vente.");
        }
      }

      return loadSale(tx, sale.id);
    });
  } catch (error) {
    if (idempotencyKey && error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.vente.findFirst({ where: { organisationId: organizationId, cleIdempotence: idempotencyKey }, include: saleInclude });
      if (existing?.empreinteIdempotence === fingerprint) return existing;
      if (existing) throw Errors.conflict("Cette clé d’idempotence a déjà servi pour une autre vente.");
    }
    throw error;
  }
}

export type CancelInput = {
  motif: string;
  /** REFUND : l'argent reçu est dû au client. ENTRY_ERROR : rien n'a été réellement encaissé. */
  type: "REFUND" | "ENTRY_ERROR";
  /** Remboursement versé immédiatement au client, avec son mode. */
  remboursementImmediat?: { modePaiement: Exclude<PaymentMethod, "CREDIT"> };
};

/**
 * Annule une vente terminée.
 *
 * - Les articles non encore retournés sont remis en stock (mouvement inverse).
 * - Les paiements restent dans l'historique.
 * - REFUND : l'argent reçu (net des remboursements déjà dus) devient une
 *   obligation de remboursement, versée tout de suite ou plus tard. La vente
 *   n'est « soldée » qu'une fois ce remboursement versé.
 * - ENTRY_ERROR : l'encaissement n'a jamais eu lieu (erreur de caisse) ; les
 *   paiements du jour même sont marqués annulés, sans faux remboursement.
 *
 * Rejouer la même requête (même clé d'idempotence) renvoie le résultat
 * initial sans rien modifier.
 */
export async function cancelSale(context: AuthContext, saleId: number, input: CancelInput, idempotencyKey: string): Promise<SaleWithDetails> {
  const { userId } = context;

  return runTransaction(async (tx) => {
    const sale = await lockSale(tx, context, saleId);

    if (sale.statut === SaleStatus.CANCELLED) {
      if (sale.cleAnnulation === idempotencyKey) return loadSale(tx, sale.id);
      throw Errors.conflict("Cette vente est déjà annulée.");
    }

    const activePayments = await tx.paiementVente.findMany({ where: { venteId: sale.id, annuleLe: null } });

    if (input.type === CancellationKind.ENTRY_ERROR) {
      if (sale.montantRetourne.greaterThan(0) || sale.montantARembourser.greaterThan(0)) {
        throw Errors.conflict("Cette vente a déjà fait l'objet d'un retour ou d'un remboursement : annulez-la avec remboursement.");
      }
      const organization = await tx.organisation.findUniqueOrThrow({ where: { id: sale.organisationId }, select: { fuseauHoraire: true } });
      const today = dateKeyAt(new Date(), organization.fuseauHoraire);
      if (activePayments.some((payment) => dateKeyAt(payment.date, organization.fuseauHoraire) !== today)) {
        throw Errors.conflict(
          "Un paiement de cette vente date d'un jour précédent : il ne peut plus être considéré comme une erreur de saisie. Annulez avec remboursement.",
        );
      }
    }

    // Articles encore chez le client : quantité vendue moins quantité déjà retournée.
    const toRestock = sale.lignes
      .map((line) => ({ line, quantite: line.quantite - line.quantiteRetournee }))
      .filter((entry) => entry.quantite > 0)
      .sort((a, b) => a.line.produitId - b.line.produitId);
    const quantitiesAfter = new Map<number, number>();
    for (const { line, quantite } of toRestock) {
      await tx.$executeRaw`INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe") VALUES (${sale.boutiqueId}, ${line.produitId}, 0, NOW()) ON CONFLICT ("boutiqueId", "produitId") DO NOTHING`;
      const updated = await tx.$queryRaw<Array<{ quantite: number }>>`
        UPDATE "Stock"
        SET "quantite" = "quantite" + ${quantite}, "modifieLe" = NOW()
        WHERE "boutiqueId" = ${sale.boutiqueId} AND "produitId" = ${line.produitId}
        RETURNING "quantite"`;
      quantitiesAfter.set(line.produitId, updated[0]!.quantite);
    }
    if (toRestock.length > 0) {
      await tx.mouvementStock.createMany({
        data: toRestock.map(({ line, quantite }) => ({
          boutiqueId: sale.boutiqueId,
          produitId: line.produitId,
          utilisateurId: userId,
          type: StockMovementType.SALE_CANCELLATION,
          variationQuantite: quantite,
          quantiteAvant: quantitiesAfter.get(line.produitId)! - quantite,
          quantiteApres: quantitiesAfter.get(line.produitId)!,
          coutUnitaire: line.coutUnitaire,
          creeLe: new Date(),
          sourceReference: `Annulation vente #${sale.id}`,
          venteId: sale.id,
          note: "Annulation de vente",
        })),
      });
    }

    let montantPaye = sale.montantPaye;
    let montantARembourser = sale.montantARembourser;

    if (input.type === CancellationKind.ENTRY_ERROR) {
      if (activePayments.length > 0) {
        await tx.paiementVente.updateMany({
          where: { venteId: sale.id, annuleLe: null },
          data: { annuleLe: new Date(), annuleParId: userId, motifAnnulation: `Erreur de saisie : ${input.motif}` },
        });
      }
      montantPaye = new Prisma.Decimal(0);
    } else {
      // Tout l'argent net encore détenu est dû au client.
      const due = uncoveredOverpayment({ ...sale, statut: SaleStatus.CANCELLED });
      if (due.greaterThan(0)) {
        const refund = await tx.remboursementVente.create({
          data: {
            montant: due,
            motif: `Annulation de vente : ${input.motif}`,
            cleIdempotence: `annulation:${idempotencyKey}`,
            venteId: sale.id,
            demandeParId: userId,
          },
        });
        montantARembourser = montantARembourser.plus(due);
        if (input.remboursementImmediat) {
          await tx.versementRemboursement.create({
            data: {
              remboursementVenteId: refund.id,
              montant: due,
              modePaiement: input.remboursementImmediat.modePaiement,
              cleIdempotence: `annulation:${idempotencyKey}`,
              utilisateurId: userId,
            },
          });
          await tx.remboursementVente.update({ where: { id: refund.id }, data: { statut: RefundStatus.COMPLETED } });
        }
      }
    }

    await tx.vente.update({
      where: { id: sale.id },
      data: {
        statut: SaleStatus.CANCELLED,
        annuleLe: new Date(),
        annuleParId: userId,
        motifAnnulation: input.motif,
        typeAnnulation: input.type,
        cleAnnulation: idempotencyKey,
        montantPaye,
        montantARembourser,
        resteAPayer: 0,
      },
    });

    // Le devis dont provenait la vente redevient transformable.
    await tx.devis.updateMany({ where: { venteId: sale.id }, data: { venteId: null } });

    await recordAuditLog(
      {
        organisationId: sale.organisationId,
        utilisateurId: userId,
        action: input.type === CancellationKind.ENTRY_ERROR ? "sale.cancelled_entry_error" : "sale.cancelled",
        entite: "Sale",
        entiteId: sale.id,
        metadonnees: { motif: input.motif, montantPaye: sale.montantPaye.toString(), remboursementImmediat: Boolean(input.remboursementImmediat) },
      },
      tx,
    );

    return loadSale(tx, sale.id);
  });
}

/**
 * Enregistre un versement d'un client sur une vente (règlement d'une
 * créance). Le paiement est historisé et le solde de la vente diminue dans la
 * même transaction. Le chiffre d'affaires n'est pas touché, seul l'encaissé
 * augmente.
 */
export async function addSalePayment(
  context: AuthContext,
  saleId: number,
  amount: number,
  modePaiement: Exclude<PaymentMethod, "CREDIT">,
  idempotencyKey: string,
): Promise<SaleWithDetails> {
  const { userId } = context;
  const montant = new Prisma.Decimal(amount).toDecimalPlaces(2);
  if (!montant.greaterThan(0)) throw Errors.conflict("Le montant doit être supérieur à 0.");

  return runTransaction(async (tx) => {
    const sale = await lockSale(tx, context, saleId);

    const prior = await tx.paiementVente.findUnique({ where: { venteId_cleIdempotence: { venteId: sale.id, cleIdempotence: idempotencyKey } } });
    if (prior) {
      if (!prior.montant.equals(montant) || prior.modePaiement !== modePaiement) {
        throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre paiement.");
      }
      return loadSale(tx, sale.id);
    }

    if (sale.statut === SaleStatus.CANCELLED) {
      throw Errors.conflict("Cette vente est annulée : aucun paiement ne peut être enregistré.");
    }
    if (sale.resteAPayer.isZero()) throw Errors.conflict("Cette vente est déjà réglée.");
    if (montant.greaterThan(sale.resteAPayer)) {
      throw Errors.conflict(`Le montant dépasse le reste à payer (${sale.resteAPayer.toNumber().toLocaleString("fr-FR")}).`);
    }

    await tx.paiementVente.create({ data: { venteId: sale.id, montant, modePaiement, cleIdempotence: idempotencyKey, utilisateurId: userId } });
    const montantPaye = sale.montantPaye.plus(montant);
    await tx.vente.update({
      where: { id: sale.id },
      data: { montantPaye, resteAPayer: customerBalance({ ...sale, montantPaye }) },
    });

    await recordAuditLog(
      {
        organisationId: sale.organisationId,
        utilisateurId: userId,
        action: "sale.payment_added",
        entite: "Sale",
        entiteId: sale.id,
        metadonnees: { montant: montant.toString(), modePaiement },
      },
      tx,
    );

    return loadSale(tx, sale.id);
  });
}

/**
 * Verse (tout ou partie) d'un remboursement dû au client. Chaque versement
 * garde son montant, son mode, sa date, son auteur et sa clé d'idempotence.
 * Seuls les versements sont des sorties d'argent : une demande en attente
 * n'en est pas une.
 */
export async function payRefund(
  context: AuthContext,
  refundId: number,
  amount: number,
  modePaiement: Exclude<PaymentMethod, "CREDIT">,
  idempotencyKey: string,
) {
  const montant = new Prisma.Decimal(amount).toDecimalPlaces(2);

  return runTransaction(async (tx) => {
    const initial = await tx.remboursementVente.findFirst({
      where: { id: refundId, vente: saleScope(context) },
      select: { venteId: true },
    });
    if (!initial) throw Errors.notFound("Remboursement introuvable");
    const sale = await lockSale(tx, context, initial.venteId);

    const refund = await tx.remboursementVente.findUniqueOrThrow({ where: { id: refundId }, include: { versements: true } });
    const duplicate = refund.versements.find((item) => item.cleIdempotence === idempotencyKey);
    if (duplicate) {
      if (!duplicate.montant.equals(montant) || duplicate.modePaiement !== modePaiement) {
        throw Errors.conflict("Cette clé d’idempotence a déjà servi pour un autre versement.");
      }
      return loadSale(tx, sale.id);
    }

    const paid = sumDecimals(refund.versements.map((item) => item.montant));
    const remaining = refund.montant.minus(paid);
    if (!montant.greaterThan(0)) throw Errors.conflict("Le montant doit être supérieur à 0.");
    if (montant.greaterThan(remaining)) throw Errors.conflict("Le versement dépasse le solde du remboursement.");

    await tx.versementRemboursement.create({
      data: { remboursementVenteId: refundId, montant, modePaiement, cleIdempotence: idempotencyKey, utilisateurId: context.userId },
    });
    await tx.remboursementVente.update({
      where: { id: refundId },
      data: { statut: montant.equals(remaining) ? RefundStatus.COMPLETED : RefundStatus.PARTIALLY_REFUNDED },
    });

    await recordAuditLog(
      {
        organisationId: sale.organisationId,
        utilisateurId: context.userId,
        action: "refund.payout",
        entite: "RemboursementVente",
        entiteId: refundId,
        metadonnees: { venteId: sale.id, montant: montant.toString(), modePaiement },
      },
      tx,
    );

    return loadSale(tx, sale.id);
  });
}
