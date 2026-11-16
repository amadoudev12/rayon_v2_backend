import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { StockMovementType } from "@/generated/prisma/enums";
import { containsText } from "@/lib/search";
import { resolveRequestStoreId } from "@/lib/auth/store";
import { getOrganizationTimeZone } from "@/lib/organization";
import { parsePeriod } from "@/lib/period";
import type { AuthContext } from "@/lib/auth/session";

/**
 * Filtres de l'historique des mouvements, communs à l'écran, à l'API et à
 * l'export : boutique (demandée ou celle du sélecteur), produit, type,
 * utilisateur, document source et période (`?periode=custom&du=&au=`, jours
 * comptés dans le fuseau de l'organisation).
 */
export async function movementFilters(context: AuthContext, params: URLSearchParams, options: { requirePeriod: boolean }) {
  const storeId = await resolveRequestStoreId(context, Number(params.get("storeId")) || undefined);
  const timeZone = await getOrganizationTimeZone(context.organizationId);

  const typeValue = params.get("type");
  const type = typeValue ? z.enum(StockMovementType).parse(typeValue) : undefined;
  const productId = Number(params.get("productId")) || undefined;
  const userId = Number(params.get("userId")) || undefined;
  const search = params.get("search")?.trim() ?? "";
  const sourceReference = params.get("source")?.trim() ?? "";

  if (options.requirePeriod && !params.get("periode")) params.set("periode", "month");
  const period = params.get("periode") ? parsePeriod(params, new Date(), timeZone) : null;

  const where: Prisma.MouvementStockWhereInput = {
    boutiqueId: storeId,
    produit: {
      organisationId: context.organizationId,
      ...(search ? { nom: containsText(search) } : {}),
    },
    ...(productId ? { produitId: productId } : {}),
    ...(userId ? { utilisateurId: userId } : {}),
    ...(sourceReference ? { sourceReference: { contains: sourceReference, mode: "insensitive" } } : {}),
    ...(type ? { type } : {}),
    ...(period ? { creeLe: { gte: period.start, lt: period.end } } : {}),
  };
  return { where, period, timeZone, storeId };
}
