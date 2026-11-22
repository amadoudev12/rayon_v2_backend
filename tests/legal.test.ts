import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";

process.env.AUTH_SECRET ??= "secret-de-test-uniquement-0123456789-abcdefghij";
process.env.FRONTEND_URL = "http://localhost:5173";

import { createApp } from "@/app";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { hashPassword } from "@/lib/auth/password";
import { issueSessionToken, SESSION_COOKIE, type Audience } from "@/lib/auth/token";
import { LEGAL_DOCUMENTS, releaseHash, type LegalKind } from "@/legal/registry";
import { currentVersions } from "@/legal/status";
import { consent, createMember, createProduit, createShop, resetDatabase } from "./helpers/factories";

const app = createApp();
const ORIGIN = "http://localhost:5173";
const PASSWORD = "Secret123";

beforeEach(resetDatabase);

// Les tests qui publient une version la retirent toujours.
const initialReleases = { terms: [...LEGAL_DOCUMENTS.terms.releases], privacy: [...LEGAL_DOCUMENTS.privacy.releases] };
afterEach(() => {
  LEGAL_DOCUMENTS.terms.releases = [...initialReleases.terms];
  LEGAL_DOCUMENTS.privacy.releases = [...initialReleases.privacy];
});

function publish(kind: LegalKind, version: string, requiresAcceptance: boolean) {
  const { releases } = LEGAL_DOCUMENTS[kind];
  releases.push({ ...releases.at(-1)!, version, requiresAcceptance, summary: `Changement ${version}` });
}

type User = { id: number; prenom: string; nom: string };

/** Client authentifié par un vrai jeton (aucune session simulée). */
async function clientOf(user: User, audience: Audience = "web") {
  const { token } = await issueSessionToken(user, audience);
  const send = (method: "get" | "post" | "put" | "patch" | "delete", path: string) => {
    const req = request(app)[method](path);
    return audience === "web"
      ? req.set("Cookie", `${SESSION_COOKIE}=${token}`).set("Origin", ORIGIN)
      : req.set("Authorization", `Bearer ${token}`);
  };
  return {
    send,
    get: (path: string) => send("get", path),
    post: (path: string, body: object = {}) => send("post", path).send(body),
    accept: (body: object = consent()) => send("post", "/api/legal/acceptance").send(body),
  };
}

/** Compte existant, antérieur aux documents : aucune preuve d'acceptation. */
async function existingUser(data: { superAdmin?: boolean; doitChangerMotDePasse?: boolean; actif?: boolean } = {}) {
  return prisma.utilisateur.create({
    data: { prenom: "Compte", nom: "Existant", email: "existant@test.local", motDePasseHash: await hashPassword(PASSWORD), ...data },
  });
}

async function existingMember(data: Parameters<typeof existingUser>[0] = {}, role: Role = Role.SELLER) {
  const shop = await createShop();
  const user = await existingUser(data);
  await prisma.membre.create({ data: { utilisateurId: user.id, organisationId: shop.organisation.id, role } });
  return { shop, user };
}

const registration = (extra: object = {}) => ({
  prenom: "Awa",
  nom: "Koné",
  identifiant: "awa@test.local",
  motDePasse: PASSWORD,
  ...extra,
});

describe("inscription", () => {
  it.each([
    ["champ absent", {}],
    ["false", { accepteDocuments: false, ...currentVersions() }],
    ["null", { accepteDocuments: null, ...currentVersions() }],
    ["chaîne « true »", { accepteDocuments: "true", ...currentVersions() }],
    ["chaîne « on »", { accepteDocuments: "on", ...currentVersions() }],
    ["nombre 1", { accepteDocuments: 1, ...currentVersions() }],
    ["tableau", { accepteDocuments: [true], ...currentVersions() }],
    ["objet", { accepteDocuments: { value: true }, ...currentVersions() }],
    ["sans version des CGU", { accepteDocuments: true, privacyVersion: "1.0" }],
    ["sans version de la politique", { accepteDocuments: true, termsVersion: "1.0" }],
  ])("refuse sans accord explicite : %s", async (_label, extra) => {
    const response = await request(app).post("/api/register").send(registration(extra));

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("LEGAL_CONSENT_MISSING");
    expect(response.body.message).toMatch(/accepter les Conditions/);
    expect(await prisma.utilisateur.count()).toBe(0);
  });

  it("refuse un contournement par formulaire encodé", async () => {
    const response = await request(app).post("/api/register").type("form").send({ ...registration(), accepteDocuments: "true" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.utilisateur.count()).toBe(0);
  });

  it.each([
    ["inventée", { termsVersion: "99.0" }],
    ["inconnue de la politique", { privacyVersion: "0.1" }],
  ])("refuse une version %s", async (_label, versions) => {
    const response = await request(app).post("/api/register").send(registration({ ...consent(), ...versions }));

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("LEGAL_VERSION_OUTDATED");
    expect(await prisma.utilisateur.count()).toBe(0);
  });

  it("refuse une version qui n'est plus en vigueur", async () => {
    const displayed = consent();
    publish("terms", "2.0", true);

    expect((await request(app).post("/api/register").send(registration(displayed))).status).toBe(409);
  });

  it("crée le compte et sa preuve, datée par le serveur ; les champs forgés sont ignorés", async () => {
    const before = Date.now();
    const forged = { acceptedAt: "2001-01-01T00:00:00.000Z", userId: 999, source: "MOBILE" };
    const response = await request(app).post("/api/register").send(registration({ ...consent(), ...forged }));

    expect(response.status).toBe(201);
    const [proof, ...others] = await prisma.acceptationJuridique.findMany();
    expect(others).toHaveLength(0);
    expect(proof).toMatchObject({ userId: response.body.data.id, ...currentVersions(), source: "REGISTRATION" });
    expect(proof!.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(proof!.acceptedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("un identifiant déjà pris ne laisse ni second compte ni preuve", async () => {
    await request(app).post("/api/register").send(registration(consent())).expect(201);
    await request(app).post("/api/register").send(registration(consent())).expect(409);

    expect(await prisma.acceptationJuridique.count()).toBe(1);
  });

  it("parcours complet : inscription, connexion, boutique, produit, vente, abonnement, paiement, déconnexion", async () => {
    await request(app).post("/api/register").send(registration(consent())).expect(201);
    const agent = request.agent(app);
    const post = (path: string, body: object = {}) => agent.post(path).set("Origin", ORIGIN).send(body);

    await post("/api/auth/login", { identifiant: "awa@test.local", motDePasse: PASSWORD }).expect(200);
    expect((await agent.get("/api/auth/session")).body.data.status).toBe("onboarding");

    const onboarded = await post("/api/onboarding", {
      nomOrganisation: "Chez Awa",
      nomBoutique: "Marché",
      telephoneBoutique: "+2250700000001",
      devise: "XOF",
    });
    expect(onboarded.status).toBe(201);
    await post("/api/auth/session/refresh").expect(200);

    const produit = await createProduit(onboarded.body.data.organization.id, onboarded.body.data.store.id);
    await agent.get("/api/products").expect(200);
    const sale = await agent
      .post("/api/sales")
      .set("Origin", ORIGIN)
      .set("Idempotency-Key", "legal-test-sale-000001")
      .send({ lignes: [{ produitId: produit.id, quantite: 1 }], modePaiement: "CASH", remise: 0 });
    expect(sale.status).toBe(201);

    await agent.get("/api/subscription").expect(200);
    await post("/api/subscription/payments", { type: "PERIOD", plan: "STARTER", months: 1 }).expect((response) => {
      expect(response.status).toBeLessThan(300);
    });
    expect(await prisma.paiementAbonnement.count()).toBe(1);

    await post("/api/auth/logout").expect(200);
    await agent.get("/api/products").expect(401);
  });
});

describe("comptes existants", () => {
  it("avec une preuve valide : aucune nouvelle demande, même après plusieurs connexions", async () => {
    const { owner } = await createShop();
    for (let i = 0; i < 3; i++) {
      const client = await clientOf(owner.utilisateur);
      expect((await client.get("/api/auth/session")).body.data.home).toBe("/dashboard");
      expect((await client.get("/api/legal/status")).body.data.required).toBe(false);
      await client.get("/api/pages/shell").expect(200);
    }
    expect(await prisma.acceptationJuridique.count()).toBe(1);
  });

  it("sans preuve : la connexion reste possible, l'écran d'acceptation est imposé", async () => {
    const { user } = await existingMember();
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ identifiant: "existant@test.local", motDePasse: PASSWORD }).expect(200);

    expect((await agent.get("/api/auth/session")).body.data).toEqual({ status: "legal_required", home: "/acceptation-conditions" });
    const shell = await agent.get("/api/pages/shell");
    expect(shell.status).toBe(403);
    expect(shell.body).toEqual({ message: "Redirection", redirect: "/acceptation-conditions" });
    // Se connecter ne vaut pas accord.
    expect(await prisma.acceptationJuridique.count({ where: { userId: user.id } })).toBe(0);
  });

  it("une session déjà ouverte est bloquée dès que l'accord devient nécessaire", async () => {
    const { owner } = await createShop();
    const client = await clientOf(owner.utilisateur);
    await client.get("/api/products").expect(200);

    publish("terms", "2.0", true);

    const blocked = await client.get("/api/products");
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
  });

  it("accepter enregistre la date réelle et le canal, sans modifier le compte ni les données de la boutique", async () => {
    const { shop, user } = await existingMember();
    await createProduit(shop.organisation.id, shop.boutique.id);
    const snapshot = async () =>
      JSON.stringify([
        await prisma.organisation.findMany(),
        await prisma.boutique.findMany(),
        await prisma.produit.findMany(),
        await prisma.stock.findMany(),
        await prisma.membre.findMany({ orderBy: { id: "asc" } }),
        await prisma.utilisateur.findMany({ omit: { derniereActiviteLe: true, modifieLe: true }, orderBy: { id: "asc" } }),
        await prisma.abonnement.findMany(),
        await prisma.paiementAbonnement.findMany(),
      ]);
    const before = await snapshot();
    const client = await clientOf(user);
    const start = Date.now();

    const response = await client.accept();

    expect(response.status).toBe(200);
    expect(response.body.data.required).toBe(false);
    const proof = await prisma.acceptationJuridique.findFirstOrThrow({ where: { userId: user.id } });
    expect(proof.source).toBe("WEB");
    expect(proof.acceptedAt.getTime()).toBeGreaterThanOrEqual(start - 1000);
    expect(await snapshot()).toBe(before);
    await client.get("/api/products").expect(200);
  });

  it("application mobile : refus explicite, puis acceptation enregistrée avec son canal", async () => {
    const { user } = await existingMember();
    const client = await clientOf(user, "mobile");

    const refused = await client.get("/api/me");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    expect(refused.body.message).toMatch(/site web de Rayon/);

    await client.accept().expect(200);
    await client.get("/api/me").expect(200);
    expect((await prisma.acceptationJuridique.findFirstOrThrow({ where: { userId: user.id } })).source).toBe("MOBILE");
  });

  it("super administrateur : même obligation, puis accès à l'administration", async () => {
    const admin = await existingUser({ superAdmin: true });
    const client = await clientOf(admin);

    expect((await client.get("/api/admin/overview")).body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    expect((await client.get("/api/pages/admin/shell")).body.redirect).toBe("/acceptation-conditions");
    await client.accept().expect(200);
    await client.get("/api/admin/overview").expect(200);
  });

  it("inscription inachevée : l'accord précède la création de la boutique", async () => {
    const client = await clientOf(await existingUser());

    expect((await client.get("/api/pages/onboarding")).body.redirect).toBe("/acceptation-conditions");
    expect((await client.post("/api/onboarding")).body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    await client.accept().expect(200);
    await client.get("/api/pages/onboarding").expect(200);
  });

  it("mot de passe temporaire : l'accord d'abord, puis le changement de mot de passe", async () => {
    const { user } = await existingMember({ doitChangerMotDePasse: true });
    const client = await clientOf(user);

    expect((await client.get("/api/pages/shell")).body.redirect).toBe("/acceptation-conditions");
    await client.accept().expect(200);
    expect((await client.get("/api/pages/shell")).body.redirect).toBe("/changer-mot-de-passe");
  });

  it("organisation suspendue : l'écran de suspension prime", async () => {
    const { shop, user } = await existingMember();
    await prisma.organisation.update({ where: { id: shop.organisation.id }, data: { actif: false } });

    expect((await (await clientOf(user)).get("/api/auth/session")).body.data.home).toBe("/suspendu");
  });

  it("collaborateur créé par le propriétaire : l'accord du propriétaire ne vaut pas pour lui", async () => {
    const { owner } = await createShop();
    const created = await (await clientOf(owner.utilisateur)).post("/api/members", {
      prenom: "Moussa",
      nom: "Traoré",
      identifiant: "moussa@test.local",
      motDePasse: PASSWORD,
      role: "SELLER",
    });
    expect(created.status).toBe(201);

    const member = await prisma.utilisateur.findUniqueOrThrow({ where: { email: "moussa@test.local" } });
    expect((await (await clientOf(member)).get("/api/auth/session")).body.data.status).toBe("legal_required");
  });

  it("peut lire les documents et se déconnecter sans accepter", async () => {
    const { user } = await existingMember();
    const client = await clientOf(user);

    await client.get("/api/legal/documents/conditions-utilisation").expect(200);
    await client.get("/api/legal/documents/politique-confidentialite").expect(200);
    await client.post("/api/auth/logout").expect(200);
    await client.get("/api/legal/status").expect(401);
  });
});

describe("versions", () => {
  it.each(["terms", "privacy"] as const)("%s : nouvelle version avec accord — demandée une fois, historique conservé", async (kind) => {
    const { owner } = await createShop();
    const [original] = await prisma.acceptationJuridique.findMany();
    publish(kind, "2.0", true);

    const client = await clientOf(owner.utilisateur);
    expect((await client.get("/api/auth/session")).body.data.home).toBe("/acceptation-conditions");
    const { documents } = (await client.get("/api/legal/status")).body.data;
    expect(documents.find((item: { kind: string }) => item.kind === kind)).toMatchObject({
      status: "acceptance_required",
      acceptedVersion: "1.0",
      changes: [{ version: "2.0", summary: "Changement 2.0" }],
    });

    await client.accept().expect(200);

    const rows = await prisma.acceptationJuridique.findMany({ orderBy: { id: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(original);
    expect(rows[1]).toMatchObject(currentVersions());
    await (await clientOf(owner.utilisateur)).get("/api/pages/shell").expect(200);
  });

  it("version d'information : aucun blocage, mise à jour signalée", async () => {
    const { owner } = await createShop();
    publish("privacy", "1.1", false);
    const client = await clientOf(owner.utilisateur);

    await client.get("/api/pages/shell").expect(200);
    const status = (await client.get("/api/legal/status")).body.data;
    expect(status.required).toBe(false);
    expect(status.documents.map((item: { status: string }) => item.status)).toEqual(["accepted", "updated"]);
  });

  it("une version d'information publiée après une version majeure n'annule pas l'obligation", async () => {
    const { owner } = await createShop();
    publish("terms", "2.0", true);
    publish("terms", "2.1", false);

    expect((await (await clientOf(owner.utilisateur)).get("/api/products")).status).toBe(403);
  });

  it("un accord sur une version majeure couvre les versions d'information qui suivent", async () => {
    publish("terms", "2.0", true);
    const { owner } = await createShop();
    publish("terms", "2.1", false);

    await (await clientOf(owner.utilisateur)).get("/api/products").expect(200);
  });

  it("un nouvel inscrit accepte la dernière version et n'est pas redemandé", async () => {
    publish("terms", "2.0", true);
    publish("terms", "2.1", false);
    const created = await request(app).post("/api/register").send(registration(consent())).expect(201);

    const status = (await (await clientOf(created.body.data)).get("/api/legal/status")).body.data;
    expect(status.required).toBe(false);
    expect(status.documents[0].status).toBe("accepted");
  });

  it("une preuve portant une version inconnue ne vaut pas accord", async () => {
    const { user } = await existingMember();
    await prisma.acceptationJuridique.create({
      data: { userId: user.id, termsVersion: "inconnue", privacyVersion: "inconnue", source: "WEB" },
    });

    expect((await (await clientOf(user)).get("/api/products")).status).toBe(403);
  });

  it("acceptations simultanées ou répétées : une seule preuve, la première date fait foi", async () => {
    const { user } = await existingMember();
    const client = await clientOf(user);
    const results = await Promise.all(Array.from({ length: 5 }, () => client.accept()));
    expect(results.map((item) => item.status)).toEqual([200, 200, 200, 200, 200]);
    const first = await prisma.acceptationJuridique.findFirstOrThrow({ where: { userId: user.id } });

    await client.accept().expect(200);

    expect(await prisma.acceptationJuridique.findMany({ where: { userId: user.id } })).toEqual([first]);
  });

  it("les anciennes versions restent consultables", async () => {
    publish("terms", "2.0", true);
    const url = "/api/legal/documents/conditions-utilisation";

    expect((await request(app).get(url)).body.data).toMatchObject({ version: "2.0", isCurrent: true });
    expect((await request(app).get(`${url}?version=1.0`)).body.data).toMatchObject({ version: "1.0", isCurrent: false });
    await request(app).get(`${url}?version=9.9`).expect(404);
    await request(app).get("/api/legal/documents/__proto__").expect(404);
  });

  it("le texte d'une version publiée n'a pas changé", () => {
    const published = Object.values(LEGAL_DOCUMENTS).flatMap((document) =>
      document.releases.map((release) => `${document.kind}@${release.version} ${releaseHash(release)}`),
    );
    // Empreintes figées. Si ce test échoue, créez une nouvelle version au lieu de modifier le texte.
    expect(published).toMatchSnapshot();
  });

  it.each(["terms", "privacy"] as const)("%s : registre cohérent", (kind) => {
    const { releases } = LEGAL_DOCUMENTS[kind];
    expect(releases[0]!.requiresAcceptance).toBe(true);
    expect(new Set(releases.map((release) => release.version)).size).toBe(releases.length);
    for (const release of releases) {
      expect(new Set(release.sections.map((section) => section.id)).size).toBe(release.sections.length);
    }
  });
});

describe("sécurité", () => {
  /** Toutes les routes déclarées dans src/routes, avec leur préfixe de app.ts. */
  function declaredRoutes() {
    const appSource = readFileSync("src/app.ts", "utf8");
    const files = new Map([...appSource.matchAll(/import (\w+) from "@\/routes\/([\w.-]+)"/g)].map((m) => [m[1]!, `${m[2]}.ts`]));
    const mounts = [...appSource.matchAll(/app\.use\("([^"]+)", (\w+Routes)\)/g)];
    expect(new Set(mounts.map((m) => files.get(m[2]!)))).toEqual(new Set(readdirSync("src/routes")));

    return mounts.flatMap(([, prefix, name]) =>
      [...readFileSync(`src/routes/${files.get(name!)}`, "utf8").matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map(
        ([, method, path]) => ({
          method: method as "get" | "post" | "put" | "patch" | "delete",
          route: `${prefix}${path === "/" ? "" : path}`,
        }),
      ),
    );
  }

  // Seules routes ouvertes à un compte qui n'a pas accepté.
  const OPEN = new Set([
    "get /api/legal",
    "get /api/legal/documents/:slug",
    "get /api/legal/status",
    "post /api/legal/acceptance",
    "post /api/auth/login",
    "post /api/mobile/auth/login",
    "post /api/register",
    "post /api/auth/logout",
    "get /api/auth/session",
    "post /api/auth/session/refresh",
    "get /api/session/expired",
    "post /api/webhooks/payments/:provider",
  ]);

  it.each([
    ["propriétaire", "web", false],
    ["propriétaire", "mobile", false],
    ["super administrateur", "web", true],
  ] as const)("aucune route protégée ne s'ouvre sans accord (%s, %s)", async (_label, audience, superAdmin) => {
    const user = superAdmin ? await existingUser({ superAdmin }) : (await existingMember({}, Role.OWNER)).user;
    const client = await clientOf(user, audience);
    const guarded = declaredRoutes().filter(({ method, route }) => !OPEN.has(`${method} ${route}`));
    expect(guarded.length).toBeGreaterThan(100);

    const opened: string[] = [];
    for (const { method, route } of guarded) {
      const response = await client.send(method, route.replace(/:\w+/g, "1")).send(method === "get" ? undefined : {});
      const blocked =
        response.status === 403 &&
        (response.body.code === "LEGAL_ACCEPTANCE_REQUIRED" || response.body.redirect === "/acceptation-conditions");
      if (!blocked) opened.push(`${method} ${route} -> ${response.status}`);
    }
    expect(opened).toEqual([]);
  });

  it("statut et acceptation exigent une session", async () => {
    await request(app).get("/api/legal/status").expect(401);
    await request(app).post("/api/legal/acceptance").send(consent()).expect(401);
  });

  it("acceptation refusée sans accord explicite ou sur une autre version", async () => {
    const { user } = await existingMember();
    const client = await clientOf(user);

    await client.accept({}).expect(400);
    await client.accept({ ...consent(), accepteDocuments: "true" }).expect(400);
    await client.accept({ ...consent(), termsVersion: "0.9" }).expect(409);
    expect(await prisma.acceptationJuridique.count({ where: { userId: user.id } })).toBe(0);
  });

  it("on ne peut pas accepter au nom d'un autre", async () => {
    const { shop, user } = await existingMember();
    const victim = await createMember(shop.organisation.id, Role.SELLER, null, { accepted: false });

    await (await clientOf(user)).accept({ ...consent(), userId: victim.utilisateur.id }).expect(200);

    expect(await prisma.acceptationJuridique.count({ where: { userId: victim.utilisateur.id } })).toBe(0);
  });

  it("acceptation depuis un autre site refusée (CSRF)", async () => {
    const { user } = await existingMember();
    const { token } = await issueSessionToken(user, "web");

    await request(app)
      .post("/api/legal/acceptance")
      .set("Cookie", `${SESSION_COOKIE}=${token}`)
      .set("Origin", "https://ailleurs.example")
      .send(consent())
      .expect(403);
    expect(await prisma.acceptationJuridique.count({ where: { userId: user.id } })).toBe(0);
  });

  it("compte désactivé ou session révoquée : aucun accès au statut", async () => {
    const { user } = await existingMember();
    const client = await clientOf(user);
    await prisma.utilisateur.update({ where: { id: user.id }, data: { actif: false } });

    await client.get("/api/legal/status").expect(401);
    await client.accept().expect(401);
  });

  it("chacun ne voit que ses accords, sans identifiant, IP, navigateur ni coordonnées", async () => {
    const { user } = await existingMember();
    const client = await clientOf(user);
    await client.accept().expect(200);

    const { history } = (await client.get("/api/legal/status")).body.data;

    expect(history).toHaveLength(1);
    expect(Object.keys(history[0]).sort()).toEqual(["acceptedAt", "id", "privacyVersion", "source", "termsVersion"]);
  });

  it("les routes publiques ne renvoient aucune donnée de compte", async () => {
    await existingMember();
    for (const path of ["/api/legal", "/api/legal/documents/politique-confidentialite"]) {
      expect(JSON.stringify((await request(app).get(path)).body)).not.toContain("existant@test.local");
    }
  });

  it("la base refuse de modifier ou d'effacer une preuve, et de supprimer le compte qui la porte", async () => {
    const { owner } = await createShop();
    const userId = owner.utilisateur.id;

    await expect(prisma.acceptationJuridique.updateMany({ where: { userId }, data: { termsVersion: "x" } })).rejects.toThrow();
    await expect(prisma.acceptationJuridique.deleteMany({ where: { userId } })).rejects.toThrow();
    await expect(prisma.utilisateur.delete({ where: { id: userId } })).rejects.toThrow();
    expect(await prisma.acceptationJuridique.count({ where: { userId } })).toBe(1);
  });

  it("la table de preuves est protégée par la RLS", async () => {
    const [table] = await prisma.$queryRaw<{ rls: boolean }[]>`
      SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'AcceptationJuridique' AND relnamespace = 'public'::regnamespace`;
    expect(table!.rls).toBe(true);
  });
});
