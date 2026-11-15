import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createSale, payRefund } from "@/services/sale";
import { SaleStatus, StockMovementType } from "@/generated/prisma/enums";
import { cancel, createProduit, createShop, resetDatabase, stockOf, testKey } from "./helpers/factories";

beforeEach(resetDatabase);

describe("createSale — enregistrement d'une vente", () => {
  it("décrémente le stock, fige prix et coûts, calcule les totaux et trace les mouvements", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 600, prixVente: 1000, stock: 10 });
    const savon = await createProduit(shop.organisation.id, shop.boutique.id, { prixAchat: 300, prixVente: 500, stock: 5 });

    const sale = await createSale(shop.context, shop.boutique.id, {
      lignes: [
        { produitId: riz.id, quantite: 3 },
        { produitId: savon.id, quantite: 2 },
      ],
      modePaiement: "CASH",
      remise: 500,
    });

    // 3 × 1000 + 2 × 500 = 4000 ; total = 4000 − 500 de remise
    expect(Number(sale.sousTotal)).toBe(4000);
    expect(Number(sale.remise)).toBe(500);
    expect(Number(sale.total)).toBe(3500);
    expect(Number(sale.montantPaye)).toBe(3500); // payé intégralement par défaut
    expect(sale.statut).toBe(SaleStatus.COMPLETED);
    expect(sale.vendeurId).toBe(shop.context.userId);

    expect(await stockOf(shop.boutique.id, riz.id)).toBe(7);
    expect(await stockOf(shop.boutique.id, savon.id)).toBe(3);

    const ligneRiz = sale.lignes.find((ligne) => ligne.produitId === riz.id)!;
    expect(Number(ligneRiz.prixUnitaire)).toBe(1000);
    expect(Number(ligneRiz.coutUnitaire)).toBe(600);
    expect(Number(ligneRiz.sousTotal)).toBe(3000);

    const mouvements = await prisma.mouvementStock.findMany({ where: { venteId: sale.id }, orderBy: { produitId: "asc" } });
    expect(mouvements.map((m) => [m.type, m.variationQuantite])).toEqual([
      [StockMovementType.SALE, -3],
      [StockMovementType.SALE, -2],
    ]);
  });

  it("conserve le prix de la vente même si le prix du produit change ensuite", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000 });
    const sale = await createSale(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 1 }],
      modePaiement: "CASH",
      remise: 0,
    });

    await prisma.produit.update({ where: { id: produit.id }, data: { prixVente: 2500 } });

    const ligne = await prisma.ligneVente.findFirstOrThrow({ where: { venteId: sale.id } });
    expect(Number(ligne.prixUnitaire)).toBe(1000);
  });

  it("regroupe les lignes d'un même produit", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });

    const sale = await createSale(shop.context, shop.boutique.id, {
      lignes: [
        { produitId: produit.id, quantite: 1 },
        { produitId: produit.id, quantite: 2 },
      ],
      modePaiement: "CASH",
      remise: 0,
    });

    expect(sale.lignes).toHaveLength(1);
    expect(sale.lignes[0].quantite).toBe(3);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(7);
  });

  it("refuse une remise supérieure au sous-total et restaure le stock par rollback", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000 });

    await expect(createSale(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 1 }],
      modePaiement: "CASH",
      remise: 5000,
    })).rejects.toMatchObject({ status: 409 });
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(10);
  });

  it("rend une création rejouée idempotente et refuse la même clé pour un autre panier", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 5 });
    const input = { lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CASH" as const, remise: 0 };
    const first = await createSale(shop.context, shop.boutique.id, input, "sale-test-0001");
    const retry = await createSale(shop.context, shop.boutique.id, input, "sale-test-0001");
    expect(retry.id).toBe(first.id);
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(4);
    await expect(createSale(shop.context, shop.boutique.id, { ...input, lignes: [{ produitId: produit.id, quantite: 2 }] }, "sale-test-0001"))
      .rejects.toMatchObject({ status: 409 });
  });

  it("enregistre un paiement partiel quand le montant payé est fourni", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000 });
    const client = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Awa" } });

    const sale = await createSale(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 2 }],
      clientId: client.id,
      modePaiement: "CREDIT",
      remise: 0,
      montantPaye: 500,
    });

    expect(Number(sale.total)).toBe(2000);
    expect(Number(sale.montantPaye)).toBe(500);
  });

  it("refuse toute la vente si un seul produit manque de stock, sans rien modifier", async () => {
    const shop = await createShop();
    const riz = await createProduit(shop.organisation.id, shop.boutique.id, { nom: "Riz", stock: 10 });
    const savon = await createProduit(shop.organisation.id, shop.boutique.id, { nom: "Savon", stock: 5 });

    await expect(
      createSale(shop.context, shop.boutique.id, {
        lignes: [
          { produitId: riz.id, quantite: 3 },
          { produitId: savon.id, quantite: 6 },
        ],
        modePaiement: "CASH",
        remise: 0,
      }),
    ).rejects.toMatchObject({ status: 409, message: 'Stock insuffisant pour "Savon"' });

    // La transaction a été annulée : le riz n'a pas été décrémenté.
    expect(await stockOf(shop.boutique.id, riz.id)).toBe(10);
    expect(await stockOf(shop.boutique.id, savon.id)).toBe(5);
    expect(await prisma.vente.count()).toBe(0);
    expect(await prisma.mouvementStock.count()).toBe(0);
  });

  it("refuse un produit archivé", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { actif: false });

    await expect(
      createSale(shop.context, shop.boutique.id, {
        lignes: [{ produitId: produit.id, quantite: 1 }],
        modePaiement: "CASH",
        remise: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuse un produit d'une autre organisation et ne touche pas à son stock", async () => {
    const shop = await createShop("Boutique A");
    const other = await createShop("Boutique B");
    const produitAutre = await createProduit(other.organisation.id, other.boutique.id, { stock: 10 });

    await expect(
      createSale(shop.context, shop.boutique.id, {
        lignes: [{ produitId: produitAutre.id, quantite: 1 }],
        modePaiement: "CASH",
        remise: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await stockOf(other.boutique.id, produitAutre.id)).toBe(10);
  });

  it("refuse un client d'une autre organisation", async () => {
    const shop = await createShop("Boutique A");
    const other = await createShop("Boutique B");
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const clientAutre = await prisma.client.create({ data: { organisationId: other.organisation.id, nom: "Client B" } });

    await expect(
      createSale(shop.context, shop.boutique.id, {
        lignes: [{ produitId: produit.id, quantite: 1 }],
        clientId: clientAutre.id,
        modePaiement: "CASH",
        remise: 0,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("cancelSale — annulation d'une vente", () => {
  async function shopWithSale() {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const sale = await createSale(shop.context, shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 4 }],
      modePaiement: "CASH",
      remise: 0,
    });
    return { shop, produit, sale };
  }

  it("recrédite le stock, passe la vente en annulée et trace l'annulation", async () => {
    const { shop, produit, sale } = await shopWithSale();
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(6);

    const cancelled = await cancel(shop.context, sale.id);

    expect(cancelled.statut).toBe(SaleStatus.CANCELLED);
    expect(cancelled.annuleLe).toBeInstanceOf(Date);
    expect(cancelled.remboursements).toHaveLength(1);
    expect(cancelled.remboursements[0].statut).toBe("PENDING");
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(10);

    const annulation = await prisma.mouvementStock.findFirstOrThrow({
      where: { venteId: sale.id, type: StockMovementType.SALE_CANCELLATION },
    });
    expect(annulation.variationQuantite).toBe(4);
  });

  it("refuse d'annuler deux fois la même vente (le stock n'est recrédité qu'une fois)", async () => {
    const { shop, produit, sale } = await shopWithSale();
    await cancel(shop.context, sale.id);

    await expect(cancel(shop.context, sale.id)).rejects.toMatchObject({ status: 409 });
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(10);
  });

  it("empêche une autre organisation d'annuler la vente", async () => {
    const { shop, produit, sale } = await shopWithSale();
    const other = await createShop("Concurrent");

    await expect(cancel(other.context, sale.id)).rejects.toMatchObject({ status: 404 });
    expect(await stockOf(shop.boutique.id, produit.id)).toBe(6);
  });
});

describe("remboursements", () => {
  it("crée une obligation de remboursement pour l'acompte d'une vente à crédit annulée", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000, stock: 4 });
    const client = await prisma.client.create({ data: { organisationId: shop.organisation.id, nom: "Client" } });
    const sale = await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CREDIT", clientId: client.id, montantPaye: 250, remise: 0 });
    const cancelled = await cancel(shop.context, sale.id, { motif: "Commande annulée" });
    expect(Number(cancelled.remboursements[0].montant)).toBe(250);
    expect(cancelled.remboursements[0].statut).toBe("PENDING");
  });

  it("garde la demande en attente puis trace les versements partiels jusqu'au solde", async () => {
    const shop = await createShop();
    const produit = await createProduit(shop.organisation.id, shop.boutique.id, { prixVente: 1000, stock: 4 });
    const sale = await createSale(shop.context, shop.boutique.id, { lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CASH", remise: 0 });
    const cancelled = await cancel(shop.context, sale.id, { motif: "Client parti" });
    const request = cancelled.remboursements[0]!;
    expect(request.statut).toBe("PENDING");
    expect(Number(request.montant)).toBe(1000);

    const first = await payRefund(shop.context, request.id, 200, "CASH", testKey());
    expect(first.remboursements[0]!.statut).toBe("PARTIALLY_REFUNDED");
    const completed = await payRefund(shop.context, request.id, 800, "MOBILE_MONEY", testKey());
    expect(completed.remboursements[0]!.statut).toBe("COMPLETED");
    expect(completed.remboursements[0]!.versements).toHaveLength(2);
    await expect(payRefund(shop.context, request.id, 1, "CASH", testKey())).rejects.toMatchObject({ status: 409 });
  });

});
