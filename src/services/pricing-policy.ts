import { Prisma } from "@/generated/prisma/client";
import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api/errors";
import type { AuthContext } from "@/lib/auth/session";
import type { PriceCheck } from "@/services/sale";

/**
 * Politique de prix d'une organisation, appliquée par le serveur à chaque
 * vente (jamais seulement dans l'interface) :
 *
 * - remise effective = (prix catalogue × quantités − total encaissable) / prix
 *   catalogue × quantités : elle cumule les prix négociés ligne à ligne et la
 *   remise globale (vendre à 0 F est une remise de 100 %) ;
 * - plafond : vendeur et gestionnaire de stock = `remiseMaxVendeurPct`
 *   (10 % par défaut), gérant = `remiseMaxGerantPct` (30 % par défaut),
 *   propriétaire et administrateur = sans limite ;
 * - vendre un article sous son coût d'achat (prix net après remise) est
 *   réservé au propriétaire et à l'administrateur.
 *
 * Au-delà, la vente est refusée avec un message explicite : un responsable
 * habilité l'enregistre lui-même (l'audit garde son nom).
 */
export type PricingLimits = { maxDiscountPct: number | null; belowCostAllowed: boolean };

const UNLIMITED_ROLES: Role[] = [Role.OWNER, Role.ADMIN];

export async function pricingLimitsFor(context: AuthContext): Promise<PricingLimits> {
  if (UNLIMITED_ROLES.includes(context.role)) return { maxDiscountPct: null, belowCostAllowed: true };
  const organization = await prisma.organisation.findUniqueOrThrow({
    where: { id: context.organizationId },
    select: { remiseMaxVendeurPct: true, remiseMaxGerantPct: true },
  });
  return {
    maxDiscountPct: context.role === Role.MANAGER ? organization.remiseMaxGerantPct : organization.remiseMaxVendeurPct,
    belowCostAllowed: false,
  };
}

/** Remise effective en % du prix catalogue (0 si aucune ligne n'a de prix catalogue). */
export function effectiveDiscountPct(input: Parameters<PriceCheck>[0]): Prisma.Decimal {
  const catalogTotal = input.lines.reduce((sum, line) => sum.plus(line.prixCatalogue.times(line.quantite)), new Prisma.Decimal(0));
  if (!catalogTotal.greaterThan(0)) return new Prisma.Decimal(0);
  const charged = input.sousTotal.minus(input.remise);
  const discount = catalogTotal.minus(charged);
  return discount.isNegative() ? new Prisma.Decimal(0) : discount.dividedBy(catalogTotal).times(100);
}

export function pricePolicyCheck(limits: PricingLimits): PriceCheck {
  return (input) => {
    const pct = effectiveDiscountPct(input);
    if (limits.maxDiscountPct !== null && pct.greaterThan(limits.maxDiscountPct)) {
      throw new ApiError(
        403,
        `La remise accordée (${pct.toDecimalPlaces(1).toString()} %) dépasse votre plafond de ${limits.maxDiscountPct} %. ` +
          "Un gérant ou le propriétaire doit enregistrer cette vente.",
      );
    }
    if (!limits.belowCostAllowed && input.sousTotal.greaterThan(0)) {
      const ratio = input.sousTotal.minus(input.remise).dividedBy(input.sousTotal);
      const belowCost = input.lines.find((line) => line.cout.greaterThan(0) && line.prixUnitaire.times(ratio).lessThan(line.cout));
      if (belowCost) {
        throw new ApiError(
          403,
          `Prix de vente inférieur au coût d'achat pour « ${belowCost.nom} ». Seul le propriétaire ou un administrateur peut vendre à perte.`,
        );
      }
    }
  };
}

export async function pricePolicyFor(context: AuthContext): Promise<PriceCheck> {
  return pricePolicyCheck(await pricingLimitsFor(context));
}
