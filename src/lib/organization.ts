import { prisma } from "@/lib/prisma";

/** Fuseau horaire IANA de l'organisation : les jours et périodes sont comptés dans ce fuseau. */
export async function getOrganizationTimeZone(organizationId: number): Promise<string> {
  const organization = await prisma.organisation.findUniqueOrThrow({
    where: { id: organizationId },
    select: { fuseauHoraire: true },
  });
  return organization.fuseauHoraire;
}
