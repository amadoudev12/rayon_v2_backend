-- Cas historiques possibles AVANT la migration 20261115120000 (jeu de test).
INSERT INTO "Utilisateur" (id, prenom, nom, email, "motDePasseHash", "modifieLe") VALUES (1, 'A', 'B', 'a@b.c', 'x', NOW());
INSERT INTO "Organisation" (id, nom, slug, "modifieLe") VALUES (1, 'Org', 'org', NOW());
INSERT INTO "Boutique" (id, nom, "organisationId", "modifieLe") VALUES (1, 'B', 1, NOW());
INSERT INTO "Produit" (id, nom, "prixAchat", "prixVente", "organisationId", "modifieLe") VALUES (1, 'P', 500, 1000, 1, NOW());

-- A : comptant normal          B : crédit en cours
-- C : annulée avant le suivi   D : annulée avec demande de remboursement
-- E : remboursement partiel sans retour (ancienne fonction)
INSERT INTO "Vente" (id, statut, "modePaiement", "sousTotal", total, "montantPaye", "organisationId", "boutiqueId", "vendeurId", "annuleLe") VALUES
  (1, 'COMPLETED', 'CASH',   1000, 1000, 1000, 1, 1, 1, NULL),
  (2, 'COMPLETED', 'CREDIT', 5000, 5000, 2000, 1, 1, 1, NULL),
  (3, 'CANCELLED', 'CASH',   3000, 3000, 3000, 1, 1, 1, NOW()),
  (4, 'CANCELLED', 'CASH',   1000, 1000, 1000, 1, 1, 1, NOW()),
  (5, 'COMPLETED', 'CASH',   2000, 2000, 2000, 1, 1, 1, NULL);

INSERT INTO "PaiementVente" (montant, "venteId", "modePaiement") VALUES
  (1000, 1, 'CASH'), (2000, 2, NULL), (3000, 3, 'CASH'), (1000, 4, 'CASH'), (2000, 5, 'CASH');

INSERT INTO "RemboursementVente" (montant, motif, "cleIdempotence", "venteId", "demandeParId", "modifieLe") VALUES
  (1000, 'Annulation', 'annulation-4', 4, 1, NOW()),
  (700, 'Geste', 'k-5', 5, 1, NOW());
