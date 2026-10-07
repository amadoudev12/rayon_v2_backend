import { compare, hash } from "bcrypt";

// Cost factor 12: strong enough for password storage without making the
// request handler noticeably slow.
const BCRYPT_COST = 12;

export function hashPassword(plainPassword: string): Promise<string> {
  return hash(plainPassword, BCRYPT_COST);
}

export function verifyPassword(plainPassword: string, passwordHash: string): Promise<boolean> {
  return compare(plainPassword, passwordHash);
}
