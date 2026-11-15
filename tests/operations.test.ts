/**
 * Phase 4 : périodes bornées, stock paginé en SQL, journaux et santé du service.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Session } from "@/lib/auth/token";

const sessionMock = vi.hoisted(() => ({ current: null as Session | null }));
vi.mock("@/lib/auth/token", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/token")>()),
  getRequestSession: vi.fn(async () => sessionMock.current),
}));

import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { parsePeriod } from "@/lib/period";
import { createProduit, createShop, resetDatabase } from "./helpers/factories";

const app = createApp();

beforeEach(async () => {
  await resetDatabase();
  sessionMock.current = null;
});

function signIn(userId: number, organizationId: number, role: Role) {
  sessionMock.current = {
    expires: new Date(Date.now() + 3600_000).toISOString(),
    user: { id: userId, name: "Test", tenant: { organizationId, role, storeId: null, organizationName: "Org" } },
  };
}

describe("périodes de statistiques bornées", () => {
  it("accepte 366 jours, refuse au-delà (requêtes coûteuses évitées)", () => {
    expect(() => parsePeriod(new URLSearchParams({ periode: "custom", du: "2025-01-01", au: "2026-01-01" }))).not.toThrow();
    expect(() => parsePeriod(new URLSearchParams({ periode: "custom", du: "2020-01-01", au: "2026-01-01" }))).toThrow(/limitée/);
  });

  it("l'API répond 400 pour une période trop longue", async () => {
    const shop = await createShop();
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);
    const response = await request(app).get("/api/sales/stats?periode=custom&du=2015-01-01&au=2026-01-01");
    expect(response.status).toBe(400);
  });
});

describe("stock paginé et filtré en SQL", () => {
  it("le filtre « stock bas » applique le seuil de la boutique, la pagination et le total sont justes", async () => {
    const shop = await createShop();
    for (let index = 0; index < 25; index += 1) {
      await createProduit(shop.organisation.id, shop.boutique.id, { nom: `Article ${String(index).padStart(2, "0")}`, stock: index, seuilAlerte: 5 });
    }
    const special = await prisma.produit.findFirstOrThrow({ where: { nom: "Article 20" } });
    // Seuil propre à la boutique : 20 en stock ≤ 22 → ce produit devient « bas ».
    await prisma.seuilStockBoutique.create({ data: { organisationId: shop.organisation.id, boutiqueId: shop.boutique.id, produitId: special.id, seuilAlerte: 22 } });
    signIn(shop.owner.utilisateur.id, shop.organisation.id, Role.OWNER);

    const low = await request(app).get("/api/stock?lowStock=true&limit=4&page=1");
    expect(low.body.pagination.total).toBe(7); // stocks 0 à 5, plus l'article à seuil spécifique
    expect(low.body.data).toHaveLength(4);
    expect(low.body.data[0]).toMatchObject({ quantite: 0, niveau: "OUT" });
    const page2 = await request(app).get("/api/stock?lowStock=true&limit=4&page=2");
    expect(page2.body.data.map((row: { produit: { nom: string } }) => row.produit.nom)).toContain("Article 20");

    const search = await request(app).get("/api/stock?search=article%201");
    expect(search.body.pagination.total).toBe(10); // « Article 10 » à « Article 19 » (noms sur deux chiffres)
    const injection = await request(app).get("/api/stock?search=%25");
    expect(injection.body.pagination.total).toBe(0); // « % » est cherché littéralement

    const alerts = await request(app).get("/api/stock/alerts");
    expect(alerts.body.data.filter((row: { type: string }) => row.type === "STOCK")).toHaveLength(7);
  });
});

describe("exploitation : santé et traçabilité des requêtes", () => {
  it("/health/ready vérifie la base de données", async () => {
    const response = await request(app).get("/health/ready");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", database: "ok" });
  });

  it("chaque réponse porte un identifiant de requête, repris s'il est fourni et sûr", async () => {
    const generated = await request(app).get("/health");
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const forwarded = await request(app).get("/health").set("X-Request-Id", "proxy-abc-12345");
    expect(forwarded.headers["x-request-id"]).toBe("proxy-abc-12345");
    const unsafe = await request(app).get("/health").set("X-Request-Id", "<script>");
    expect(unsafe.headers["x-request-id"]).not.toBe("<script>");
  });
});
