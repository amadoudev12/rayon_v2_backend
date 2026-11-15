-- Jeu de données de charge (base JETABLE uniquement) : 50 organisations,
-- 100 boutiques, 50 000 produits, 100 000 lignes de stock, 200 000 ventes sur
-- 90 jours (400 000 lignes, 200 000 paiements). Mot de passe de tous les
-- comptes : variable psql :hash (empreinte bcrypt fournie par run.ts).

INSERT INTO "Organisation" ("nom", "slug", "modifieLe")
SELECT 'Organisation ' || g, 'charge-' || g, NOW() FROM generate_series(1, 50) g;

INSERT INTO "Boutique" ("nom", "organisationId", "parDefaut", "modifieLe")
SELECT 'Boutique ' || o."id" || '-' || k, o."id", k = 1, NOW()
FROM "Organisation" o, generate_series(1, 2) k;

INSERT INTO "Utilisateur" ("prenom", "nom", "email", "motDePasseHash", "modifieLe")
SELECT 'Propriétaire', 'Org' || o."id", 'owner' || o."id" || '@charge.test', :'hash', NOW() FROM "Organisation" o;
INSERT INTO "Utilisateur" ("prenom", "nom", "email", "motDePasseHash", "modifieLe")
SELECT 'Vendeur', 'Org' || o."id" || '-' || k, 'seller' || o."id" || '-' || k || '@charge.test', :'hash', NOW()
FROM "Organisation" o, generate_series(1, 2) k;

INSERT INTO "Membre" ("role", "utilisateurId", "organisationId", "modifieLe")
SELECT CASE WHEN u."email" LIKE 'owner%' THEN 'OWNER'::"Role" ELSE 'SELLER'::"Role" END, u."id",
       CAST(substring(u."email" FROM '^[a-z]+([0-9]+)') AS INTEGER), NOW()
FROM "Utilisateur" u WHERE u."email" LIKE '%@charge.test';

INSERT INTO "Produit" ("nom", "prixAchat", "prixVente", "seuilAlerte", "organisationId", "modifieLe")
SELECT 'Article ' || g, 500 + (g % 50) * 10, 1000 + (g % 50) * 20, 5, o."id", NOW()
FROM "Organisation" o, generate_series(1, 1000) g;

INSERT INTO "Stock" ("boutiqueId", "produitId", "quantite", "modifieLe")
SELECT b."id", p."id", CASE WHEN p."id" % 40 = 0 THEN 2 ELSE 100000 END, NOW()
FROM "Boutique" b JOIN "Produit" p ON p."organisationId" = b."organisationId";

CREATE TEMP TABLE owners AS SELECT m."organisationId", m."utilisateurId" FROM "Membre" m WHERE m."role" = 'OWNER';
CREATE TEMP TABLE ranked AS
  SELECT p."id", p."organisationId", ROW_NUMBER() OVER (PARTITION BY p."organisationId" ORDER BY p."id") AS rn FROM "Produit" p;
CREATE INDEX ON ranked ("organisationId", rn);

INSERT INTO "Vente" ("statut", "modePaiement", "sousTotal", "total", "montantPaye", "resteAPayer", "organisationId", "boutiqueId", "vendeurId", "creeLe")
SELECT 'COMPLETED', 'CASH', 2000, 2000, 2000, 0, b."organisationId", b."id", o."utilisateurId", NOW() - (random() * 90 || ' days')::interval
FROM "Boutique" b JOIN owners o ON o."organisationId" = b."organisationId", generate_series(1, 2000) g;

INSERT INTO "LigneVente" ("quantite", "prixUnitaire", "coutUnitaire", "sousTotal", "venteId", "produitId")
SELECT 1, 1000, 500, 1000, v."id", r."id"
FROM "Vente" v JOIN ranked r ON r."organisationId" = v."organisationId" AND r.rn IN ((v."id" % 998) + 1, (v."id" % 998) + 2);

INSERT INTO "PaiementVente" ("montant", "modePaiement", "date", "venteId", "utilisateurId")
SELECT v."total", 'CASH', v."creeLe", v."id", v."vendeurId" FROM "Vente" v;

INSERT INTO "Depense" ("categorie", "libelle", "montant", "date", "organisationId", "boutiqueId", "creeParId")
SELECT 'Loyer', 'Loyer', 50000, NOW() - (k || ' days')::interval, o."organisationId", NULL, o."utilisateurId"
FROM owners o, generate_series(0, 89, 30) k;

ANALYZE;
