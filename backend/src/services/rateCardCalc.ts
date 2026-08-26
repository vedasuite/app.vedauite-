// Matching a billed charge to an agreed rate.
//
// PURE. No database.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// A 3PL invoice says "Pick Fee". A rate card says "pick fee". Another says
// "PICKING". These are the same charge, and a merchant should not have to
// normalise their own paperwork to find that out.
//
// But the cost of matching wrongly is that VedaSuite compares a storage charge
// against a picking rate and announces a discrepancy that does not exist. So
// the rule is the same one the rest of the engine follows: match on evidence,
// and when the evidence is thin, say UNMAPPED rather than guessing.
//
// NOTHING HERE ENUMERATES A FIXED SET OF FEES. A 3PL contract can contain any
// charge the two parties agreed on, so `chargeType` is whatever the merchant
// wrote, and merchant-declared aliases are the only source of equivalence
// beyond exact and containment matching.

/** Canonical form used for comparison. Case and spacing only. */
export function chargeKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .toLowerCase()
    .replace(/[_\-/]+/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

export interface RateEntry {
  id: string;
  chargeKey: string;
  chargeType: string;
  /** Merchant-declared alternative spellings, already canonicalised. */
  aliases: string[];
  unit: string | null;
  rate: number;
  currency: string | null;
  minQuantity: number | null;
  maxQuantity: number | null;
}

export type RateMatchConfidence = "exact" | "alias" | "probable" | "unmapped";

export interface RateMatch {
  entry: RateEntry | null;
  confidence: RateMatchConfidence;
  /** Stated whenever the match is not exact or alias. */
  reason: string;
  /** Every entry that could have been meant, when more than one could. */
  candidates: RateEntry[];
}

/**
 * Finds the agreed rate for a billed charge type.
 *
 * ORDER OF STRENGTH:
 *
 *   exact    — the canonical keys are identical.
 *   alias    — the merchant declared this spelling for that charge.
 *   probable — one entry contains the billed key, or vice versa, and only one
 *              does. Enough to show the merchant; NOT enough to call a
 *              difference an overcharge.
 *   unmapped — nothing matched, or several matched equally well.
 *
 * A quantity band, where the contract has one, must also be satisfied. An entry
 * priced "above 100 units" does not price an invoice line of 12, and silently
 * applying it would produce a fabricated expected amount.
 */
export function matchRate(input: {
  billedChargeType: string | null | undefined;
  quantity?: number | null;
  entries: RateEntry[];
}): RateMatch {
  const key = chargeKey(input.billedChargeType);
  if (!key) {
    return {
      entry: null,
      confidence: "unmapped",
      reason:
        "This invoice line has no charge type, so VedaSuite cannot tell which agreed rate it should be compared against.",
      candidates: [],
    };
  }

  const withinBand = (entry: RateEntry) => {
    if (input.quantity == null) return entry.minQuantity == null && entry.maxQuantity == null
      ? true
      // A banded rate needs a quantity to know which band applies.
      : false;
    if (entry.minQuantity != null && input.quantity < entry.minQuantity) return false;
    if (entry.maxQuantity != null && input.quantity > entry.maxQuantity) return false;
    return true;
  };

  const exact = input.entries.filter((entry) => entry.chargeKey === key);
  const alias = input.entries.filter(
    (entry) => entry.chargeKey !== key && entry.aliases.includes(key)
  );
  const partial = input.entries.filter(
    (entry) =>
      entry.chargeKey !== key &&
      !entry.aliases.includes(key) &&
      (entry.chargeKey.includes(key) || key.includes(entry.chargeKey)) &&
      // Two-character overlaps are noise, not evidence.
      Math.min(entry.chargeKey.length, key.length) >= 4
  );

  for (const [group, confidence] of [
    [exact, "exact"],
    [alias, "alias"],
  ] as const) {
    const inBand = group.filter(withinBand);
    if (inBand.length === 1) {
      return { entry: inBand[0], confidence, reason: "", candidates: inBand };
    }
    if (inBand.length > 1) {
      return {
        entry: null,
        confidence: "unmapped",
        reason: `Your rate card has ${inBand.length} entries for "${input.billedChargeType}", so VedaSuite cannot tell which one applies.`,
        candidates: inBand,
      };
    }
    if (group.length > 0) {
      // Matched by name but no band covers this quantity.
      return {
        entry: null,
        confidence: "unmapped",
        reason: `Your rate card prices "${group[0].chargeType}" only for certain quantities, and this line's quantity is outside them.`,
        candidates: group,
      };
    }
  }

  const partialInBand = partial.filter(withinBand);
  if (partialInBand.length === 1) {
    return {
      entry: partialInBand[0],
      confidence: "probable",
      reason: `"${input.billedChargeType}" is not an exact match for "${partialInBand[0].chargeType}" on your rate card. Confirm they are the same charge before treating any difference as real.`,
      candidates: partialInBand,
    };
  }
  if (partialInBand.length > 1) {
    return {
      entry: null,
      confidence: "unmapped",
      reason: `"${input.billedChargeType}" could match ${partialInBand
        .map((entry) => `"${entry.chargeType}"`)
        .join(" or ")} on your rate card. Add an alias so VedaSuite knows which.`,
      candidates: partialInBand,
    };
  }

  return {
    entry: null,
    confidence: "unmapped",
    reason: `"${input.billedChargeType}" does not appear on your rate card, so VedaSuite has no agreed rate to compare it against.`,
    candidates: [],
  };
}

/**
 * Whether a rate match is strong enough to support a MONETARY claim.
 *
 * A probable match is worth showing the merchant — they can confirm it in a
 * second — but it is not proof that two charges are the same thing, and an
 * overcharge figure computed across a maybe is exactly the kind of number this
 * engine exists not to produce.
 */
export function rateSupportsMonetaryClaim(confidence: RateMatchConfidence): boolean {
  return confidence === "exact" || confidence === "alias";
}

/**
 * The expected amount for a line, and whether it may be stated.
 *
 * REQUIRES ALL THREE: a rate strong enough to claim on, a quantity that was
 * actually proven from Shopify activity, and agreeing currencies. Any one
 * missing means the amount is not computed — not estimated, not defaulted.
 */
export function expectedAmountFor(input: {
  match: RateMatch;
  provenQuantity: number | null;
  billedCurrency: string | null;
}):
  | { status: "computed"; amount: number; currency: string; basis: string }
  | { status: "not_computed"; reason: string } {
  if (!input.match.entry || !rateSupportsMonetaryClaim(input.match.confidence)) {
    return {
      status: "not_computed",
      reason:
        input.match.reason ||
        "VedaSuite has no confidently matched agreed rate for this charge.",
    };
  }
  if (input.provenQuantity == null || !Number.isFinite(input.provenQuantity)) {
    return {
      status: "not_computed",
      reason:
        "VedaSuite could not prove from your Shopify orders how many units this charge should cover, so it cannot say what the charge should have been.",
    };
  }
  const entry = input.match.entry;
  if (
    input.billedCurrency &&
    entry.currency &&
    input.billedCurrency !== entry.currency
  ) {
    return {
      status: "not_computed",
      reason: `This line is billed in ${input.billedCurrency} but your rate card prices it in ${entry.currency}. VedaSuite does not convert currencies.`,
    };
  }
  const currency = entry.currency ?? input.billedCurrency;
  if (!currency) {
    return {
      status: "not_computed",
      reason: "No currency is recorded for this rate, so no expected amount is calculated.",
    };
  }
  return {
    status: "computed",
    amount: Math.round(entry.rate * input.provenQuantity * 100) / 100,
    currency,
    basis: `${input.provenQuantity} x ${entry.rate} ${currency} agreed rate for "${entry.chargeType}".`,
  };
}
