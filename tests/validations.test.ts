import { describe, expect, it } from "vitest";
import { saleSchema } from "@/lib/validations/sale";
import { purchaseSchema } from "@/lib/validations/purchase";
import { productSchema, stockAdjustmentSchema } from "@/lib/validations/product";
import { loginSchema, registerSchema } from "@/lib/validations/auth";
import { parseIdentifier } from "@/lib/auth/identifier";

// Ces schémas ne touchent pas la base : ce sont les règles de saisie
// appliquées par les API avant tout traitement.
describe("validations des données envoyées aux API", () => {
  it("vente : applique les valeurs par défaut et convertit les nombres saisis", () => {
    const parsed = saleSchema.parse({ lignes: [{ produitId: "3", quantite: "2" }] });
    expect(parsed).toMatchObject({ lignes: [{ produitId: 3, quantite: 2 }], modePaiement: "CASH", remise: 0 });
  });

  it("vente : refuse un panier vide, une quantité nulle ou une remise négative", () => {
    expect(saleSchema.safeParse({ lignes: [] }).success).toBe(false);
    expect(saleSchema.safeParse({ lignes: [{ produitId: 1, quantite: 0 }] }).success).toBe(false);
    expect(saleSchema.safeParse({ lignes: [{ produitId: 1, quantite: 1 }], remise: -5 }).success).toBe(false);
    expect(saleSchema.safeParse({ lignes: [{ produitId: 1, quantite: 1 }], modePaiement: "BITCOIN" }).success).toBe(false);
  });

  it("achat : refuse un coût unitaire négatif", () => {
    expect(
      purchaseSchema.safeParse({ lignes: [{ produitId: 1, quantite: 1, coutUnitaire: -1 }] }).success,
    ).toBe(false);
  });

  it("produit : exige un prix de vente strictement positif", () => {
    const base = { nom: "Riz", prixAchat: 100, seuilAlerte: 5 };
    expect(productSchema.safeParse({ ...base, prixVente: 0 }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, prixVente: 150 }).success).toBe(true);
  });

  it("ajustement de stock : refuse une variation nulle", () => {
    expect(stockAdjustmentSchema.safeParse({ variationQuantite: 0 }).success).toBe(false);
    expect(stockAdjustmentSchema.safeParse({ variationQuantite: -2 }).success).toBe(true);
  });

  it("inscription : exige un mot de passe d'au moins 8 caractères avec lettre et chiffre", () => {
    const base = { prenom: "Awa", nom: "Diallo", identifiant: "awa@test.local" };
    expect(registerSchema.safeParse({ ...base, motDePasse: "court1" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, motDePasse: "sanschiffre" }).success).toBe(false);
    expect(registerSchema.safeParse({ ...base, motDePasse: "Solide123" }).success).toBe(true);
  });
  it("identifiant : accepte un email ou un téléphone avec indicatif, et les normalise", () => {
    expect(parseIdentifier(" Awa@Test.Local ")).toEqual({ kind: "email", email: "awa@test.local" });
    // Espaces, points, tirets et préfixe 00 : un seul et même numéro stocké.
    expect(parseIdentifier("+221 77 123 45 67")).toEqual({ kind: "telephone", telephone: "+221771234567" });
    expect(parseIdentifier("00221-77.123.45.67")).toEqual({ kind: "telephone", telephone: "+221771234567" });
    // Sans indicatif, le pays est inconnu : refusé plutôt que deviné.
    expect(parseIdentifier("77 123 45 67")).toBeNull();
    expect(parseIdentifier("awa@")).toBeNull();
    expect(parseIdentifier("")).toBeNull();

    expect(loginSchema.safeParse({ identifiant: "+221771234567", motDePasse: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ identifiant: "771234567", motDePasse: "x" }).success).toBe(false);
    const base = { prenom: "Awa", nom: "Diallo", motDePasse: "Solide123" };
    expect(registerSchema.safeParse({ ...base, identifiant: "+221 77 123 45 67" }).success).toBe(true);
    expect(registerSchema.safeParse({ ...base, identifiant: "pas un identifiant" }).success).toBe(false);
  });
});
