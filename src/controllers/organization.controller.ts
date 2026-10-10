import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { jsonData } from "@/lib/api/response";

const updateSchema = z.object({
  nom: z.string().trim().min(2, "Le nom est requis."),
  devise: z.string().trim().length(3, "Code devise invalide (3 lettres)."),
});

export async function getOrganization(req: Request, res: Response) {
  const context = req.user;
  const organization = await prisma.organisation.findUniqueOrThrow({ where: { id: context.organizationId } });
  return jsonData(res, organization);
}

export async function updateOrganization(req: Request, res: Response) {
  const context = req.user;

  const parsed = updateSchema.parse(req.body);
  const organization = await prisma.organisation.update({
    where: { id: context.organizationId },
    data: { nom: parsed.nom, devise: parsed.devise.toUpperCase() },
  });

  return jsonData(res, organization);
}
