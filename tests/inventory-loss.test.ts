import { beforeEach, describe, expect, it } from "vitest";
import { InventorySelectionType, Role, StockMovementType } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { createInventory, countInventoryLine, validateInventory } from "@/services/inventory";
import { cancelLoss, createLoss } from "@/services/loss";
import { createMember, createProduit, createShop, resetDatabase, stockOf } from "./helpers/factories";

beforeEach(resetDatabase);

describe("inventaire physique", () => {
  it("fige les quantités, exige le comptage complet et applique un mouvement post-comptage sans l'écraser", async () => {
    const shop = await createShop();
    const product = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 10 });
    const inventory = await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Comptage", selectionType: InventorySelectionType.ALL });
    const line = inventory.lignes[0]!;
    expect(line.quantiteTheorique).toBe(10);
    await expect(validateInventory(shop.context, inventory.id)).rejects.toMatchObject({ status: 409 });
    const counted = await countInventoryLine(shop.context, inventory.id, line.id, { quantiteComptee: 10, version: 0 });
    await prisma.stock.update({ where: { boutiqueId_produitId: { boutiqueId: shop.boutique.id, produitId: product.id } }, data: { quantite: 8 } });
    await prisma.mouvementStock.create({ data: { boutiqueId: shop.boutique.id, produitId: product.id, utilisateurId: shop.context.userId, type: StockMovementType.SALE, variationQuantite: -2, quantiteAvant: 10, quantiteApres: 8, creeLe: new Date(Date.now() + 1000) } });
    await validateInventory(shop.context, inventory.id);
    expect(await stockOf(shop.boutique.id, product.id)).toBe(8);
    expect(counted.version).toBe(1);
    await expect(validateInventory(shop.context, inventory.id)).rejects.toMatchObject({ status: 409 });
  });

  it("refuse le comptage par un membre limité à une autre boutique", async () => {
    const shop = await createShop();
    const product = await createProduit(shop.organisation.id, shop.boutique.id);
    const inventory = await createInventory(shop.context, { boutiqueId: shop.boutique.id, libelle: "Comptage", selectionType: InventorySelectionType.MANUAL, produitIds: [product.id] });
    const otherStore = await prisma.boutique.create({ data: { organisationId: shop.organisation.id, nom: "Autre" } });
    const limited = await createMember(shop.organisation.id, Role.STOCK_MANAGER, otherStore.id);
    await expect(countInventoryLine({ ...shop.context, userId: limited.utilisateur.id, membershipStoreId: otherStore.id }, inventory.id, inventory.lignes[0]!.id, { quantiteComptee: 1, version: 0 })).rejects.toMatchObject({ status: 404 });
  });
});

describe("pertes de stock", () => {
  it("retire le stock une fois, réutilise une clé idempotente et restitue au moyen d'un mouvement", async () => {
    const shop = await createShop();
    const product = await createProduit(shop.organisation.id, shop.boutique.id, { stock: 5, prixAchat: 250 });
    const input = { boutiqueId: shop.boutique.id, produitId: product.id, quantite: 2, motif: "CASSE" };
    const first = await createLoss(shop.context, input, "test-loss-key-01");
    const retry = await createLoss(shop.context, input, "test-loss-key-01");
    expect(retry.id).toBe(first.id);
    expect(await stockOf(shop.boutique.id, product.id)).toBe(3);
    await expect(createLoss(shop.context, { ...input, quantite: 6 }, "test-loss-key-02")).rejects.toMatchObject({ status: 409 });
    await cancelLoss(shop.context, first.id, "Erreur de saisie");
    expect(await stockOf(shop.boutique.id, product.id)).toBe(5);
    const movements = await prisma.mouvementStock.findMany({ where: { perteStockId: first.id }, orderBy: { creeLe: "asc" } });
    expect(movements.map((movement) => [movement.type, movement.quantiteAvant, movement.quantiteApres])).toEqual([
      [StockMovementType.LOSS, 5, 3], [StockMovementType.LOSS_CANCELLATION, 3, 5],
    ]);
  });
});
