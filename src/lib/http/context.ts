import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Requête HTTP en cours de traitement, accessible sans la passer de fonction
 * en fonction : les règles d'accès (lib/auth/session) gardent ainsi la même
 * signature que les services, et se testent sans serveur.
 */
type RequestStore = { req: Request; res: Response; memo: Map<unknown, Map<string, Promise<unknown>>> };

const storage = new AsyncLocalStorage<RequestStore>();

/** Middleware Express : ouvre le contexte de la requête pour toute la suite du traitement. */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  storage.run({ req, res, memo: new Map() }, next);
}

/** Requête en cours ; null hors d'une requête HTTP (tests des services, scripts). */
export function currentRequest(): Request | null {
  return storage.getStore()?.req ?? null;
}

/**
 * Mémorise le résultat de `fn` pour la durée d'une requête : plusieurs
 * lectures du même compte ne coûtent qu'un aller-retour en base. Hors d'une
 * requête, `fn` est simplement appelée.
 */
export function requestCache<Args extends unknown[], Result>(fn: (...args: Args) => Promise<Result>) {
  return (...args: Args): Promise<Result> => {
    const store = storage.getStore();
    if (!store) return fn(...args);

    let results = store.memo.get(fn);
    if (!results) {
      results = new Map();
      store.memo.set(fn, results);
    }
    const key = JSON.stringify(args);
    let result = results.get(key) as Promise<Result> | undefined;
    if (!result) {
      result = fn(...args);
      results.set(key, result);
    }
    return result;
  };
}
