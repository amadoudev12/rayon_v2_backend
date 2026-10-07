/**
 * Crée (ou promeut) un compte super administrateur de la plateforme.
 *
 * C'est volontairement le SEUL moyen d'obtenir ce rôle : aucune page ni
 * route API ne permet de l'attribuer. Il faut donc un accès au serveur et à
 * la base de données.
 *
 * Utilisation :
 *   SUPER_ADMIN_EMAIL="moi@exemple.com" SUPER_ADMIN_PASSWORD="MotDePasse123" npm run admin:create
 *
 * Variables optionnelles : SUPER_ADMIN_PRENOM, SUPER_ADMIN_NOM.
 * - Email inconnu : le compte est créé (mot de passe obligatoire).
 * - Email existant sans boutique : le compte est promu (mot de passe mis à
 *   jour uniquement s'il est fourni).
 * - Email d'un membre d'une boutique : refusé. Les deux rôles sont
 *   strictement séparés ; utilisez une adresse dédiée à l'administration.
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "bcrypt";

function fail(message: string): never {
  console.error(`Erreur : ${message}`);
  process.exit(1);
}

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("SUPER_ADMIN_EMAIL est requis (adresse email valide).");
  if (password !== undefined && (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password))) {
    fail("SUPER_ADMIN_PASSWORD doit contenir au moins 8 caractères, dont une lettre et un chiffre.");
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  try {
    const existing = await prisma.utilisateur.findUnique({ where: { email }, select: { id: true, membre: true } });

    if (existing?.membre) {
      fail(`${email} est membre d'une boutique. Utilisez une adresse dédiée à l'administration de la plateforme.`);
    }

    if (existing) {
      await prisma.utilisateur.update({
        where: { id: existing.id },
        data: { superAdmin: true, actif: true, ...(password ? { motDePasseHash: await hash(password, 12) } : {}) },
      });
      console.log(`Compte existant promu super administrateur : ${email}`);
    } else {
      if (!password) fail("SUPER_ADMIN_PASSWORD est requis pour créer un nouveau compte.");
      await prisma.utilisateur.create({
        data: {
          email,
          prenom: process.env.SUPER_ADMIN_PRENOM?.trim() || "Super",
          nom: process.env.SUPER_ADMIN_NOM?.trim() || "Admin",
          motDePasseHash: await hash(password, 12),
          superAdmin: true,
        },
      });
      console.log(`Super administrateur créé : ${email}`);
    }
    console.log("Connectez-vous sur /login : vous serez dirigé vers /admin.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
