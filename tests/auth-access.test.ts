import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Session } from "@/lib/auth/token";

// La session portée par la requête est simulée : c'est précisément ce que les
// règles d'accès ne doivent plus croire sur parole (le jeton peut être périmé).
const sessionMock = vi.hoisted(() => ({ current: null as Session | null }));
vi.mock("@/lib/auth/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/token")>()),
  getRequestSession: vi.fn(async () => sessionMock.current),
}));

import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import {
  requireAuthContext,
  requirePageAuthContext,
  requireUserId,
  SESSION_EXPIRED_PATH,
} from "@/lib/auth/session";
import { createApp } from "@/app";
import { createSale } from "@/lib/services/sale";
import { contextFor, createMember, createProduit, createShop, resetDatabase } from "./helpers/factories";

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});

/** Simule la session telle que le JWT la décrit (photo prise à la connexion). */
function signIn(userId: number, tenant: { organizationId: number; role: Role; storeId: number | null } | null) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: {
      id: userId,
      name: "Test",
      tenant: tenant ? { ...tenant, organizationName: "Org" } : null,
    },
  };
}

describe("règles d'accès — la base fait foi, pas le jeton", () => {
  it("refuse une requête sans session", async () => {
    await expect(requireAuthContext()).rejects.toMatchObject({ status: 401 });
    await expect(requirePageAuthContext()).rejects.toMatchObject({ redirect: "/login" });
  });

  it("lit le rôle et la boutique en base, même si le jeton dit autre chose", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER, shop.boutique.id);
    // Jeton périmé : il prétend que la personne est propriétaire, sans boutique imposée.
    signIn(seller.utilisateur.id, { organizationId: shop.organisation.id, role: Role.OWNER, storeId: null });

    const context = await requireAuthContext();

    expect(context).toEqual({
      userId: seller.utilisateur.id,
      organizationId: shop.organisation.id,
      role: Role.SELLER,
      membershipStoreId: shop.boutique.id,
    });
  });

  it("coupe l'accès d'un membre retiré dès la requête suivante", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    signIn(seller.utilisateur.id, { organizationId: shop.organisation.id, role: Role.SELLER, storeId: null });
    await expect(requireAuthContext()).resolves.toMatchObject({ role: Role.SELLER });

    await prisma.membre.delete({ where: { id: seller.membre.id } });

    await expect(requireAuthContext()).rejects.toMatchObject({
      status: 401,
      message: "Votre accès à cette organisation a été retiré. Reconnectez-vous.",
    });
    // Côté pages : redirection vers la route qui efface le cookie (pas de boucle).
    await expect(requirePageAuthContext()).rejects.toMatchObject({ redirect: SESSION_EXPIRED_PATH });
  });

  it("refuse une session dont le compte a été supprimé", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    signIn(seller.utilisateur.id, { organizationId: shop.organisation.id, role: Role.SELLER, storeId: null });

    await prisma.utilisateur.delete({ where: { id: seller.utilisateur.id } });

    await expect(requireAuthContext()).rejects.toMatchObject({ status: 401 });
    await expect(requireUserId()).rejects.toMatchObject({ status: 401 });
  });

  it("envoie vers l'onboarding un compte qui n'a pas encore d'organisation", async () => {
    const user = await prisma.utilisateur.create({
      data: { prenom: "Nouveau", nom: "Compte", email: "nouveau@test.local", motDePasseHash: "x" },
    });
    signIn(user.id, null);

    await expect(requireAuthContext()).rejects.toMatchObject({ status: 409 });
    await expect(requirePageAuthContext()).rejects.toMatchObject({ redirect: "/onboarding" });
    await expect(requireUserId()).resolves.toBe(user.id);
  });
});

describe("DELETE /api/members/:id — retrait d'un membre", () => {
  const app = createApp();
  const removeMember = (id: number) => request(app).delete(`/api/members/${id}`);

  it("retire un vendeur qui a déjà vendu : accès coupé, historique conservé", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const produit = await createProduit(shop.organisation.id, shop.boutique.id);
    const sale = await createSale(contextFor(seller.membre), shop.boutique.id, {
      lignes: [{ produitId: produit.id, quantite: 1 }],
      modePaiement: "CASH",
      remise: 0,
    });

    signIn(shop.context.userId, { organizationId: shop.organisation.id, role: Role.OWNER, storeId: null });
    const response = await removeMember(seller.membre.id);

    expect(response.status).toBe(200);
    expect(await prisma.membre.findUnique({ where: { id: seller.membre.id } })).toBeNull();
    // Le compte et ses ventes restent : l'historique garde le nom du vendeur.
    expect(await prisma.utilisateur.findUnique({ where: { id: seller.utilisateur.id } })).not.toBeNull();
    expect((await prisma.vente.findUniqueOrThrow({ where: { id: sale.id } })).vendeurId).toBe(seller.utilisateur.id);
    // Et le retrait est journalisé.
    expect(await prisma.journalAudit.count({ where: { action: "member.removed" } })).toBe(1);

    // La session encore ouverte du vendeur ne donne plus accès à rien.
    signIn(seller.utilisateur.id, { organizationId: shop.organisation.id, role: Role.SELLER, storeId: null });
    await expect(requireAuthContext()).rejects.toMatchObject({ status: 401 });
  });

  it("interdit le retrait à un rôle sans permission", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const other = await createMember(shop.organisation.id, Role.SELLER);

    signIn(seller.utilisateur.id, { organizationId: shop.organisation.id, role: Role.SELLER, storeId: null });
    const response = await removeMember(other.membre.id);

    expect(response.status).toBe(403);
    expect(await prisma.membre.count({ where: { id: other.membre.id } })).toBe(1);
  });

  it("empêche de retirer le propriétaire, soi-même ou un membre d'une autre organisation", async () => {
    const shop = await createShop();
    const admin = await createMember(shop.organisation.id, Role.ADMIN);
    const other = await createShop("Concurrent");
    const otherSeller = await createMember(other.organisation.id, Role.SELLER);

    signIn(admin.utilisateur.id, { organizationId: shop.organisation.id, role: Role.ADMIN, storeId: null });

    expect((await removeMember(shop.owner.membre.id)).status).toBe(409); // propriétaire
    expect((await removeMember(admin.membre.id)).status).toBe(409); // soi-même
    expect((await removeMember(otherSeller.membre.id)).status).toBe(404); // autre organisation
    expect(await prisma.membre.count()).toBe(4);
  });
});
