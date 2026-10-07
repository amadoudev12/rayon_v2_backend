import { Prisma } from "@/generated/prisma/client";

/** Converts a Prisma Decimal (or plain number) to a JSON-safe number. */
export function toNumber(value: Prisma.Decimal | number): number {
  return typeof value === "number" ? value : value.toNumber();
}

/** Sums a list of Decimal values without floating-point drift. */
export function sumDecimals(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
}

export function decimal(value: number | string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}
