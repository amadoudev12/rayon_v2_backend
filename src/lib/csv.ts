import type { Response } from "express";
import { Prisma } from "@/generated/prisma/client";

type Cell = string | number | Prisma.Decimal | Date | null | undefined;

/**
 * CSV lisible directement par Excel en français : séparateur « ; », virgule
 * décimale, BOM UTF-8. Toute valeur texte commençant par = + - @ (ou une
 * tabulation) est neutralisée : un nom de client piégé ne peut pas exécuter
 * de formule à l'ouverture du fichier.
 */
export function csvCell(value: Cell, timeZone = "UTC"): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (value instanceof Date) {
    text = new Intl.DateTimeFormat("fr-FR", { timeZone, dateStyle: "short", timeStyle: "short" }).format(value);
  } else if (value instanceof Prisma.Decimal || typeof value === "number") {
    text = value.toString().replace(".", ",");
  } else {
    text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  }
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Ouvre une réponse CSV en téléchargement et renvoie une fonction d'écriture de lignes. */
export function startCsv(res: Response, fileName: string, headers: string[]) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  res.write("﻿" + headers.map((header) => csvCell(header)).join(";") + "\r\n");
  return (cells: Cell[], timeZone?: string) => {
    res.write(cells.map((cell) => csvCell(cell, timeZone)).join(";") + "\r\n");
  };
}
