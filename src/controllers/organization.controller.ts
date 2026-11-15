import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonData } from "@/lib/api/response";
import { recordAuditLog } from "@/lib/api/audit";
import { isTimeZone } from "@/lib/timezone";

const percent = (label: string) =>
  z.coerce.number().int(`${label} : nombre entier attendu.`).min(0, `${label} : 0 % au minimum.`).max(100, `${label} : 100 % au maximum.`);

const updateSchema = z
  .object({
    nom: z.string().trim().min(2, "Le nom est requis."),
    devise: z.string().trim().length(3, "Code devise invalide (3 lettres)."),
    fuseauHoraire: z.string().refine(isTimeZone, "Fuseau horaire IANA invalide.").default("Africa/Dakar"),
    /** Plafonds de remise (en % du prix catalogue) ; absents : inchangés. */
    remiseMaxVendeurPct: percent("Remise maximale d'un vendeur").optional(),
    remiseMaxGerantPct: percent("Remise maximale d'un gérant").optional(),
  })
  .refine(
    (value) => value.remiseMaxVendeurPct === undefined || value.remiseMaxGerantPct === undefined || value.remiseMaxGerantPct >= value.remiseMaxVendeurPct,
    { message: "Le plafond d'un gérant ne peut pas être inférieur à celui d'un vendeur.", path: ["remiseMaxGerantPct"] },
  );

export async function getOrganization(req: Request, res: Response) {
  const context = req.user;
  const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId } });
  return jsonData(res, organization);
}

export async function updateOrganization(req: Request, res: Response) {
  const context = req.user;
  const parsed = updateSchema.parse(req.body);
  const before = await prisma.organisation.findUniqueOrThrow({
    where: { id: context.organizationId },
    select: { remiseMaxVendeurPct: true, remiseMaxGerantPct: true },
  });

  const organization = await prisma.organisation.update({
    where: { id: context.organizationId },
    data: {
      nom: parsed.nom,
      devise: parsed.devise.toUpperCase(),
      fuseauHoraire: parsed.fuseauHoraire,
      remiseMaxVendeurPct: parsed.remiseMaxVendeurPct,
      remiseMaxGerantPct: parsed.remiseMaxGerantPct,
    },
  });

  if (organization.remiseMaxVendeurPct !== before.remiseMaxVendeurPct || organization.remiseMaxGerantPct !== before.remiseMaxGerantPct) {
    await recordAuditLog({
      organisationId: context.organizationId,
      utilisateurId: context.userId,
      action: "organization.pricing_policy_changed",
      entite: "Organisation",
      entiteId: context.organizationId,
      metadonnees: {
        avant: before,
        apres: { remiseMaxVendeurPct: organization.remiseMaxVendeurPct, remiseMaxGerantPct: organization.remiseMaxGerantPct },
      },
    });
  }

  return jsonData(res, organization);
}
