/**
 * Sessions et mots de passe, avec de VRAIS jetons (aucune session simulée) :
 * déconnexion réelle, révocation, changement et réinitialisation du mot de
 * passe, journal de sécurité, limitation de débit partagée.
 */
import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { SignJWT } from "jose";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/enums";
import { createApp } from "@/app";
import { hashPassword } from "@/lib/auth/password";
import { createMember, createShop, resetDatabase } from "./helpers/factories";

const app = createApp();
const PASSWORD = "Secret123";

beforeEach(async () => {
  await resetDatabase();
});

async function withPassword(userId: number, password = PASSWORD) {
  const user = await prisma.utilisateur.update({ where: { id: userId }, data: { motDePasseHash: await hashPassword(password) } });
  return user.email!;
}

async function mobileLogin(email: string, password = PASSWORD) {
  const response = await request(app).post("/api/mobile/auth/login").send({ identifiant: email, motDePasse: password });
  return { status: response.status, token: response.body.data?.token as string | undefined };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("sessions révocables", () => {
  it("déconnexion réelle : le jeton mobile cesse de fonctionner, même conservé", async () => {
    const shop = await createShop();
    const email = await withPassword(shop.owner.utilisateur.id);
    const { token } = await mobileLogin(email);

    expect((await request(app).get("/api/me").set(bearer(token!))).status).toBe(200);
    expect((await request(app).post("/api/auth/logout").set(bearer(token!))).status).toBe(200);
    expect((await request(app).get("/api/me").set(bearer(token!))).status).toBe(401);

    const session = await prisma.sessionUtilisateur.findFirstOrThrow({ where: { utilisateurId: shop.owner.utilisateur.id } });
    expect(session.revoqueLe).toBeInstanceOf(Date);
  });

  it("déconnexion du site : le cookie copié ne permet plus rien", async () => {
    const shop = await createShop();
    const email = await withPassword(shop.owner.utilisateur.id);
    const login = await request(app).post("/api/auth/login").send({ identifiant: email, motDePasse: PASSWORD });
    const cookie = login.headers["set-cookie"] as unknown as string[];
    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(200);

    await request(app).post("/api/auth/logout").set("Cookie", cookie).set("Origin", "http://localhost:5173").expect(200);
    expect((await request(app).get("/api/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("refuse un jeton signé mais sans session (émis avant les sessions révocables)", async () => {
    const shop = await createShop();
    const legacy = await new SignJWT({ id: shop.owner.utilisateur.id, name: "Ancien" })
      .setProtectedHeader({ alg: "HS256" })
      .setAudience("mobile")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET));
    expect((await request(app).get("/api/me").set(bearer(legacy))).status).toBe(401);
  });

  it("retirer un membre ferme ses sessions", async () => {
    const shop = await createShop();
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const { token } = await mobileLogin(await withPassword(seller.utilisateur.id));
    const ownerToken = (await mobileLogin(await withPassword(shop.owner.utilisateur.id))).token!;

    await request(app).delete(`/api/members/${seller.membre.id}`).set(bearer(ownerToken)).expect(200);
    expect((await request(app).get("/api/me").set(bearer(token!))).status).toBe(401);
    expect(await prisma.sessionUtilisateur.count({ where: { utilisateurId: seller.utilisateur.id, revoqueLe: null } })).toBe(0);
  });

  it("« déconnecter mes autres appareils » garde seulement la session courante", async () => {
    const shop = await createShop();
    const email = await withPassword(shop.owner.utilisateur.id);
    const phone = (await mobileLogin(email)).token!;
    const tablet = (await mobileLogin(email)).token!;

    const sessions = await request(app).get("/api/account/sessions").set(bearer(phone));
    expect(sessions.body.data).toHaveLength(2);
    expect(sessions.body.data.filter((item: { courante: boolean }) => item.courante)).toHaveLength(1);

    await request(app).post("/api/account/sessions/revoke-others").set(bearer(phone)).expect(200);
    expect((await request(app).get("/api/me").set(bearer(phone))).status).toBe(200);
    expect((await request(app).get("/api/me").set(bearer(tablet))).status).toBe(401);
  });
});

describe("mots de passe", () => {
  it("changement : ancien mot de passe exigé, autres appareils déconnectés, nouveau mot de passe actif", async () => {
    const shop = await createShop();
    const email = await withPassword(shop.owner.utilisateur.id);
    const current = (await mobileLogin(email)).token!;
    const other = (await mobileLogin(email)).token!;

    const wrong = await request(app).post("/api/account/password").set(bearer(current)).send({ motDePasseActuel: "Mauvais999", nouveauMotDePasse: "Nouveau456" });
    expect(wrong.status).toBe(403);
    const weak = await request(app).post("/api/account/password").set(bearer(current)).send({ motDePasseActuel: PASSWORD, nouveauMotDePasse: "court" });
    expect(weak.status).toBe(400);

    await request(app).post("/api/account/password").set(bearer(current)).send({ motDePasseActuel: PASSWORD, nouveauMotDePasse: "Nouveau456" }).expect(200);
    expect((await request(app).get("/api/me").set(bearer(current))).status).toBe(200);
    expect((await request(app).get("/api/me").set(bearer(other))).status).toBe(401);
    expect((await mobileLogin(email)).status).toBe(401);
    expect((await mobileLogin(email, "Nouveau456")).status).toBe(200);

    const user = await prisma.utilisateur.findUniqueOrThrow({ where: { id: shop.owner.utilisateur.id } });
    expect(user.motDePasseHash).not.toContain("Nouveau456");
    expect(user.motDePasseHash.startsWith("$2")).toBe(true);
  });

  it("réinitialisation par le propriétaire : sessions fermées, mot de passe temporaire à changer avant tout", async () => {
    const shop = await createShop();
    const ownerToken = (await mobileLogin(await withPassword(shop.owner.utilisateur.id))).token!;
    const seller = await createMember(shop.organisation.id, Role.SELLER);
    const sellerEmail = await withPassword(seller.utilisateur.id);
    const oldToken = (await mobileLogin(sellerEmail)).token!;

    await request(app).post(`/api/members/${seller.membre.id}/reset-password`).set(bearer(ownerToken)).send({ motDePasseTemporaire: "Temporaire1" }).expect(200);
    expect((await request(app).get("/api/me").set(bearer(oldToken))).status).toBe(401);

    const login = await request(app).post("/api/mobile/auth/login").send({ identifiant: sellerEmail, motDePasse: "Temporaire1" });
    expect(login.body.data.doitChangerMotDePasse).toBe(true);
    const temp = login.body.data.token as string;

    const me = await request(app).get("/api/me").set(bearer(temp));
    expect(me.status).toBe(200);
    expect(me.body.data.doitChangerMotDePasse).toBe(true);
    const blocked = await request(app).get("/api/sales").set(bearer(temp));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    await request(app).post("/api/account/password").set(bearer(temp)).send({ motDePasseActuel: "Temporaire1", nouveauMotDePasse: "Personnel9" }).expect(200);
    expect((await request(app).get("/api/sales").set(bearer(temp))).status).toBe(200);
  });

  it("hiérarchie : un administrateur ne réinitialise ni le propriétaire ni un autre administrateur ; un gérant rien", async () => {
    const shop = await createShop();
    const admin = await createMember(shop.organisation.id, Role.ADMIN);
    const otherAdmin = await createMember(shop.organisation.id, Role.ADMIN);
    const manager = await createMember(shop.organisation.id, Role.MANAGER);
    const adminToken = (await mobileLogin(await withPassword(admin.utilisateur.id))).token!;
    const managerToken = (await mobileLogin(await withPassword(manager.utilisateur.id))).token!;
    const body = { motDePasseTemporaire: "Temporaire1" };

    expect((await request(app).post(`/api/members/${shop.owner.membre.id}/reset-password`).set(bearer(adminToken)).send(body)).status).toBe(403);
    expect((await request(app).post(`/api/members/${otherAdmin.membre.id}/reset-password`).set(bearer(adminToken)).send(body)).status).toBe(403);
    // Le gérant tente avant d'être lui-même réinitialisé (ce qui fermerait sa session).
    expect((await request(app).post(`/api/members/${admin.membre.id}/reset-password`).set(bearer(managerToken)).send(body)).status).toBe(403);
    expect((await request(app).post(`/api/members/${manager.membre.id}/reset-password`).set(bearer(adminToken)).send(body)).status).toBe(200);
    expect((await request(app).get("/api/me").set(bearer(managerToken))).status).toBe(401);

    const other = await createShop("Autre");
    const otherOwnerToken = (await mobileLogin(await withPassword(other.owner.utilisateur.id))).token!;
    expect((await request(app).post(`/api/members/${manager.membre.id}/reset-password`).set(bearer(otherOwnerToken)).send(body)).status).toBe(404);
  });
});

describe("journal de sécurité et limitation de débit", () => {
  it("trace connexions réussies et refusées, sans jamais écrire le mot de passe", async () => {
    const shop = await createShop();
    const email = await withPassword(shop.owner.utilisateur.id);
    await mobileLogin(email, "Mauvais999");
    await mobileLogin(email);

    const events = await prisma.journalSecurite.findMany({ orderBy: { id: "asc" } });
    expect(events.map((event) => event.evenement)).toEqual(["login.failure", "login.success"]);
    expect(JSON.stringify(events)).not.toContain("Mauvais999");
    expect(JSON.stringify(events)).not.toContain(PASSWORD);
  });

  it("bloque la 11e tentative sur un même compte (compteur en base, partagé entre instances)", async () => {
    const shop = await createShop();
    const email = await withPassword(shop.owner.utilisateur.id);
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await mobileLogin(email, "Mauvais999")).status).toBe(401);
    const blocked = await request(app).post("/api/mobile/auth/login").send({ identifiant: email, motDePasse: PASSWORD });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    // Une autre instance de l'application lit le même compteur.
    const otherInstance = createApp();
    expect((await request(otherInstance).post("/api/mobile/auth/login").send({ identifiant: email, motDePasse: PASSWORD })).status).toBe(429);
    expect(await prisma.journalSecurite.count({ where: { evenement: "rate_limit.blocked" } })).toBeGreaterThan(0);
  });
});
