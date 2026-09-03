import { isBackupEligible, isTransient, type ErrorKind } from "@providerkit/core";

/** The remedy a kind belongs to. This is the taxonomy: the package groups
 *  failures by what fixes them, so the grouping is the product, not a palette. */
export type Family = "retry" | "account" | "context" | "ours" | "inert";

export interface Kind {
  kind: ErrorKind;
  family: Family;
  /** The answer to the only question an error asks: what do I do now? */
  fix: string;
  isTransient: boolean;
  isBackupEligible: boolean;
}

/** Prose is editorial and lives here; the flags come from the package itself so
 *  they cannot drift. `Record<ErrorKind, …>` is what makes this exhaustive —
 *  add a kind to core and this stops compiling until it is described. */
const FIX: Record<ErrorKind, { family: Family; fix: string }> = {
  aborted: { family: "inert", fix: "Nothing. The caller pressed Stop — this is not a failure." },
  timeout: { family: "retry", fix: "Retry. Our deadline fired, not their answer." },
  network: { family: "retry", fix: "Retry. The request never reached them." },
  overload: { family: "retry", fix: "Retry — or fall back to another model." },
  rate: { family: "retry", fix: "Wait out the window, or rotate the key or model." },
  quota: { family: "account", fix: "Top up, or wait for the reset. Retrying will not help." },
  entitlement: {
    family: "account",
    fix: "Change the plan. A new key and a top-up both fail here.",
  },
  auth: { family: "account", fix: "Fix the credential. Every retry lands the same." },
  context: {
    family: "context",
    fix: "Send less. Compact the conversation — waiting fixes nothing.",
  },
  model: { family: "ours", fix: "Use a model this endpoint actually serves." },
  content: { family: "ours", fix: "A safety filter caught the prompt or the answer." },
  invalid: { family: "ours", fix: "Fix the request. This one is our bug." },
  unknown: { family: "inert", fix: "Unrecognised. Surface the body and look at it." },
};

/** `Object.keys` widens to `string[]` — the assertion restores what the Record
 *  already guarantees. Order is source order, and it is the order of the bench. */
const ORDER = Object.keys(FIX) as ErrorKind[];

/** Every kind, sorted into its remedy band. This ordering is the exit ladder on
 *  the bench and the row order in `/kinds.json` — one list, two readers. */
export const KINDS: Kind[] = (["retry", "account", "context", "ours", "inert"] as const).flatMap(
  (family) =>
    ORDER.filter((kind) => FIX[kind].family === family).map((kind) => ({
      kind,
      family,
      fix: FIX[kind].fix,
      isTransient: isTransient(kind),
      isBackupEligible: isBackupEligible(kind),
    })),
);

export const BY_KIND: Record<ErrorKind, Kind> = Object.fromEntries(
  KINDS.map((k) => [k.kind, k]),
) as Record<ErrorKind, Kind>;

/** What each band is called on the bench, and what the whole band means. */
export const FAMILIES: { family: Family; label: string; note: string }[] = [
  { family: "retry", label: "Retry", note: "time fixes it" },
  { family: "account", label: "Account", note: "money or plan fixes it" },
  { family: "context", label: "Context", note: "sending less fixes it" },
  { family: "ours", label: "Ours", note: "our request was wrong" },
  { family: "inert", label: "Inert", note: "nothing to do" },
];
