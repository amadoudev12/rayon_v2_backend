import { Role } from "@/generated/prisma/enums";

/**
 * Capability-based permission matrix. Every mutation in the API layer must
 * call `can()` with the acting membership role before touching the
 * database — never infer permissions from the UI.
 */
export const PERMISSIONS = {
  "org:manage": [Role.OWNER],
  "members:manage": [Role.OWNER, Role.ADMIN],
  "store:manage": [Role.OWNER, Role.ADMIN],
  "category:manage": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.STOCK_MANAGER],
  "product:manage": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.STOCK_MANAGER],
  "stock:adjust": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.STOCK_MANAGER],
  "purchase:manage": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.STOCK_MANAGER],
  "supplier:manage": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.STOCK_MANAGER],
  "customer:manage": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.SELLER],
  "sale:create": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.SELLER],
  "sale:cancel": [Role.OWNER, Role.ADMIN, Role.MANAGER],
  "expense:manage": [Role.OWNER, Role.ADMIN, Role.MANAGER],
  "report:view": [Role.OWNER, Role.ADMIN, Role.MANAGER, Role.STOCK_MANAGER],
} as const;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}

export const ROLE_LABELS: Record<Role, string> = {
  [Role.OWNER]: "Propriétaire",
  [Role.ADMIN]: "Administrateur",
  [Role.MANAGER]: "Gérant",
  [Role.SELLER]: "Vendeur",
  [Role.STOCK_MANAGER]: "Gestionnaire de stock",
};
