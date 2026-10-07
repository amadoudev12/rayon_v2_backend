/**
 * Données de démonstration.
 *
 * Tout ce qui est créé ici est clairement fictif : le nom de l'organisation,
 * l'email du compte et les noms des produits/clients l'indiquent. Sans risque
 * sur une base de développement neuve ; ne fait rien si le compte de
 * démonstration existe déjà.
 *
 * Utilisation : npx prisma db seed
 */
import "dotenv/config";
import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { hash } from "bcrypt";
import { Role, StockMovementType, PaymentMethod } from "../src/generated/prisma/enums";

const DEMO_EMAIL = "demo@boutique-diallo.test";

async function main() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  const existing = await prisma.utilisateur.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    console.log(`Le compte de démonstration existe déjà (${DEMO_EMAIL}). Rien à faire.`);
    await prisma.$disconnect();
    return;
  }

  const motDePasseHash = await hash("Demo1234!", 12);

  await prisma.$transaction(async (tx) => {
    const organization = await tx.organisation.create({
      data: { nom: "Boutique Démo Diallo", slug: "boutique-demo-diallo", devise: "XOF" },
    });

    const store = await tx.boutique.create({
      data: {
        organisationId: organization.id,
        nom: "Boutique Démo — Centre-ville",
        adresse: "12 Avenue de la République, Dakar",
        telephone: "+221 77 000 00 00",
        parDefaut: true,
      },
    });

    const owner = await tx.utilisateur.create({
      data: {
        prenom: "Demo",
        nom: "Diallo",
        email: DEMO_EMAIL,
        motDePasseHash,
      },
    });

    await tx.membre.create({
      data: { utilisateurId: owner.id, organisationId: organization.id, role: Role.OWNER },
    });

    const seller = await tx.utilisateur.create({
      data: {
        prenom: "Awa",
        nom: "Démo",
        email: "vendeuse@boutique-diallo.test",
        motDePasseHash: await hash("Demo1234!", 12),
      },
    });
    await tx.membre.create({
      data: { utilisateurId: seller.id, organisationId: organization.id, role: Role.SELLER, boutiqueId: store.id },
    });

    const [epicerie, boissons, hygiene] = await Promise.all([
      tx.categorie.create({ data: { organisationId: organization.id, nom: "Épicerie (démo)" } }),
      tx.categorie.create({ data: { organisationId: organization.id, nom: "Boissons (démo)" } }),
      tx.categorie.create({ data: { organisationId: organization.id, nom: "Hygiène (démo)" } }),
    ]);

    const productDefs = [
      { nom: "Riz parfumé 5kg (démo)", categorieId: epicerie.id, prixAchat: 3500, prixVente: 4250, stock: 40, unite: "sac" },
      { nom: "Huile végétale 1L (démo)", categorieId: epicerie.id, prixAchat: 1100, prixVente: 1400, stock: 60, unite: "bouteille" },
      { nom: "Sucre en poudre 1kg (démo)", categorieId: epicerie.id, prixAchat: 600, prixVente: 800, stock: 8, unite: "kg" },
      { nom: "Eau minérale 1.5L (démo)", categorieId: boissons.id, prixAchat: 250, prixVente: 400, stock: 120, unite: "bouteille" },
      { nom: "Jus de bissap 33cl (démo)", categorieId: boissons.id, prixAchat: 300, prixVente: 500, stock: 3, unite: "bouteille" },
      { nom: "Savon de toilette (démo)", categorieId: hygiene.id, prixAchat: 350, prixVente: 550, stock: 50, unite: "pièce" },
      { nom: "Dentifrice 100ml (démo)", categorieId: hygiene.id, prixAchat: 700, prixVente: 1000, stock: 0, unite: "pièce" },
    ];

    const products = [];
    for (const def of productDefs) {
      const product = await tx.produit.create({
        data: {
          organisationId: organization.id,
          categorieId: def.categorieId,
          nom: def.nom,
          unite: def.unite,
          prixAchat: def.prixAchat,
          prixVente: def.prixVente,
          seuilAlerte: 10,
        },
      });
      await tx.stock.create({ data: { boutiqueId: store.id, produitId: product.id, quantite: def.stock } });
      if (def.stock > 0) {
        await tx.mouvementStock.create({
          data: {
            boutiqueId: store.id,
            produitId: product.id,
            utilisateurId: owner.id,
            type: StockMovementType.INITIAL,
            variationQuantite: def.stock,
            note: "Stock initial (démo)",
          },
        });
      }
      products.push({ ...product, stock: def.stock });
    }

    const customers = await Promise.all(
      [
        { nom: "Fatou Ndiaye (client démo)", telephone: "+221 77 111 11 11" },
        { nom: "Moussa Sow (client démo)", telephone: "+221 77 222 22 22" },
        { nom: "Aïcha Ba (client démo)", telephone: "+221 77 333 33 33" },
      ].map((data) => tx.client.create({ data: { organisationId: organization.id, ...data } })),
    );

    await Promise.all(
      [
        { nom: "Grossiste Sahel (fournisseur démo)", telephone: "+221 33 800 00 01" },
        { nom: "Distributions Teranga (fournisseur démo)", telephone: "+221 33 800 00 02" },
      ].map((data) => tx.fournisseur.create({ data: { organisationId: organization.id, ...data } })),
    );

    // Quelques ventes de démonstration réparties sur les derniers jours.
    const [rice, oil, water, soap] = products;
    const salesPlan = [
      { daysAgo: 4, items: [[rice, 2], [water, 6]], customer: customers[0], method: PaymentMethod.CASH },
      { daysAgo: 3, items: [[oil, 3], [soap, 4]], customer: customers[1], method: PaymentMethod.MOBILE_MONEY },
      { daysAgo: 2, items: [[water, 10]], customer: null, method: PaymentMethod.CASH },
      { daysAgo: 1, items: [[rice, 1], [oil, 1], [soap, 2]], customer: customers[2], method: PaymentMethod.CARD },
      { daysAgo: 0, items: [[water, 4], [soap, 1]], customer: null, method: PaymentMethod.CASH },
    ] as const;

    for (const plan of salesPlan) {
      const creeLe = new Date();
      creeLe.setDate(creeLe.getDate() - plan.daysAgo);

      const lines = plan.items.map(([product, quantite]) => ({
        produitId: product.id,
        quantite,
        prixUnitaire: new Prisma.Decimal(product.prixVente),
        coutUnitaire: new Prisma.Decimal(product.prixAchat),
        sousTotal: new Prisma.Decimal(product.prixVente).times(quantite),
      }));
      const sousTotal = lines.reduce((sum, l) => sum.plus(l.sousTotal), new Prisma.Decimal(0));

      const sale = await tx.vente.create({
        data: {
          organisationId: organization.id,
          boutiqueId: store.id,
          vendeurId: seller.id,
          clientId: plan.customer?.id ?? null,
          modePaiement: plan.method,
          sousTotal,
          remise: 0,
          total: sousTotal,
          montantPaye: sousTotal,
          creeLe,
          lignes: { create: lines },
        },
      });

      for (const [product, quantite] of plan.items) {
        await tx.stock.update({
          where: { boutiqueId_produitId: { boutiqueId: store.id, produitId: product.id } },
          data: { quantite: { decrement: quantite } },
        });
        await tx.mouvementStock.create({
          data: {
            boutiqueId: store.id,
            produitId: product.id,
            utilisateurId: seller.id,
            type: StockMovementType.SALE,
            variationQuantite: -quantite,
            venteId: sale.id,
            creeLe,
          },
        });
      }
    }

    // Un achat de démonstration pour réapprovisionner le jus en stock faible.
    const bissap = products[4];
    const purchase = await tx.achat.create({
      data: {
        organisationId: organization.id,
        boutiqueId: store.id,
        creeParId: owner.id,
        total: new Prisma.Decimal(bissap.prixAchat).times(30),
        note: "Réapprovisionnement (démo)",
        lignes: {
          create: [
            {
              produitId: bissap.id,
              quantite: 30,
              coutUnitaire: bissap.prixAchat,
              sousTotal: new Prisma.Decimal(bissap.prixAchat).times(30),
            },
          ],
        },
      },
    });
    await tx.stock.update({
      where: { boutiqueId_produitId: { boutiqueId: store.id, produitId: bissap.id } },
      data: { quantite: { increment: 30 } },
    });
    await tx.mouvementStock.create({
      data: {
        boutiqueId: store.id,
        produitId: bissap.id,
        utilisateurId: owner.id,
        type: StockMovementType.PURCHASE,
        variationQuantite: 30,
        achatId: purchase.id,
      },
    });

    await Promise.all(
      [
        { categorie: "Loyer", libelle: "Loyer boutique (démo)", montant: 60000 },
        { categorie: "Électricité / eau", libelle: "Facture SENELEC (démo)", montant: 15000 },
        { categorie: "Transport", libelle: "Transport marchandises (démo)", montant: 5000 },
      ].map(({ categorie, libelle, montant }) =>
        tx.depense.create({
          data: { organisationId: organization.id, boutiqueId: store.id, categorie, libelle, montant, creeParId: owner.id },
        }),
      ),
    );

    await tx.journalAudit.create({
      data: {
        organisationId: organization.id,
        utilisateurId: owner.id,
        action: "organization.seeded",
        entite: "Organization",
        entiteId: organization.id,
        metadonnees: { source: "prisma/seed.ts" },
      },
    });
  });

  console.log("Données de démonstration créées avec succès.");
  console.log(`  Propriétaire : ${DEMO_EMAIL} / Demo1234!`);
  console.log("  Vendeuse     : vendeuse@boutique-diallo.test / Demo1234!");

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
