import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api/errors";

export type Tx = Prisma.TransactionClient;

type Options = {
  /** Niveau d'isolation ; READ COMMITTED (défaut PostgreSQL) sinon. */
  isolationLevel?: Prisma.TransactionIsolationLevel;
  /** Durée maximale de la transaction (ms). */
  timeout?: number;
  /** Nombre de tentatives en cas de conflit de sérialisation ou d'interblocage. */
  attempts?: number;
};

/**
 * Délais par défaut : le délai de 5 s de Prisma est trop court pour une
 * opération commerciale sous charge ou avec une base distante. Au-delà, la
 * transaction est annulée en entier (jamais appliquée à moitié).
 */
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_WAIT_MS = 10_000;

/** Conflits transitoires : relancer la transaction entière est sans risque. */
function isRetryable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034 : conflit d'écriture ou interblocage détecté par PostgreSQL.
    return error.code === "P2034";
  }
  const message = error instanceof Error ? error.message : "";
  return /could not serialize access|deadlock detected|40001|40P01/.test(message);
}

/**
 * Exécute `fn` dans une transaction interactive. Les conflits transitoires
 * (sérialisation, interblocage) sont relancés depuis le début, ce qui est sûr
 * puisque rien n'a été validé. Les autres erreurs remontent telles quelles.
 */
export async function runTransaction<T>(fn: (tx: Tx) => Promise<T>, options: Options = {}): Promise<T> {
  const attempts = options.attempts ?? (options.isolationLevel === "Serializable" ? 4 : 2);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: options.isolationLevel,
        timeout: options.timeout ?? DEFAULT_TIMEOUT_MS,
        maxWait: DEFAULT_MAX_WAIT_MS,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      // Attente courte et aléatoire avant de rejouer, pour désynchroniser
      // les transactions concurrentes.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt + Math.random() * 50));
    }
  }
  if (isRetryable(lastError)) {
    throw new ApiError(409, "L'opération est en conflit avec une autre en cours. Réessayez.");
  }
  throw lastError;
}
