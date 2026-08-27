// Rate card persistence and versioning.
//
// VERSIONS ARE IMMUTABLE. Uploading new pricing creates the NEXT version and
// marks the previous one superseded. Nothing edits an existing version in
// place, because reconciliation runs point at the version they used, and a run
// that said "$2.00 was agreed" was correct about the world at the time it ran.
// Rewriting it would destroy evidence the merchant may need in a dispute.
//
// Deleting a card does not delete the runs that used it: the foreign key is
// ON DELETE SET NULL and each run keeps rateCardVersion and rateCardName as
// denormalized copies.

import { HttpError } from "../lib/httpError";
import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";
import { chargeKey, type RateEntry } from "./rateCardCalc";
import { parseSpreadsheet, SpreadsheetParseError } from "./spreadsheetParsing";
import { normalizeCurrency } from "./reconciliationImportCalc";
import { parseNumeric } from "./reconciliationModel";
import { normalizeHeader } from "./columnMapping";

/** Rate-card columns, kept separate from the reconciliation field registry. */
export const RATE_CARD_FIELDS = [
  {
    key: "chargeType",
    label: "Charge type",
    purpose:
      "The name of the fee as it appears on your invoices, e.g. pick fee, storage, return handling.",
    aliases: [
      "charge",
      "charge type",
      "chargetype",
      "fee",
      "fee type",
      "service",
      "service type",
      "activity",
      "description",
      "item",
      "line item",
      "charge description",
    ],
    required: true,
    numeric: false,
  },
  {
    key: "rate",
    label: "Agreed rate",
    purpose: "The price you agreed for one unit of this charge.",
    aliases: [
      "rate",
      "price",
      "agreed rate",
      "contract rate",
      "unit rate",
      "unit price",
      "cost",
      "amount",
      "tariff",
      "fee amount",
    ],
    required: true,
    numeric: true,
  },
  {
    key: "unit",
    label: "Charged per",
    purpose:
      "What one unit of this charge is: order, item, shipment, month, kg, or whatever your contract says.",
    aliases: ["unit", "per", "charged per", "uom", "basis", "unit of measure"],
    required: false,
    numeric: false,
  },
  {
    key: "currency",
    label: "Currency",
    purpose: "Currency of the agreed rate.",
    aliases: ["currency", "ccy", "curr", "currency code"],
    required: false,
    numeric: false,
  },
  {
    key: "aliases",
    label: "Also known as",
    purpose:
      "Other spellings this charge appears under on your invoices, separated by semicolons. VedaSuite never invents one.",
    aliases: ["alias", "aliases", "also known as", "aka", "synonyms", "invoice name"],
    required: false,
    numeric: false,
  },
  {
    key: "minQuantity",
    label: "Minimum quantity",
    purpose: "Lowest quantity this rate applies to, when your contract has bands.",
    aliases: ["min", "min qty", "minimum", "minimum quantity", "from qty", "from"],
    required: false,
    numeric: true,
  },
  {
    key: "maxQuantity",
    label: "Maximum quantity",
    purpose: "Highest quantity this rate applies to, when your contract has bands.",
    aliases: ["max", "max qty", "maximum", "maximum quantity", "to qty", "to"],
    required: false,
    numeric: true,
  },
] as const;

export type RateCardFieldKey = (typeof RATE_CARD_FIELDS)[number]["key"];
export type RateCardMapping = Partial<Record<RateCardFieldKey, string>>;

/** Suggests a column for each rate-card field. Same discipline as the import. */
export function suggestRateCardMapping(input: {
  headers: string[];
  sampleRows: string[][];
}) {
  const normalized = input.headers.map((header, index) => ({
    original: header,
    normalized: normalizeHeader(header),
    index,
  }));

  const looksNumeric = (columnIndex: number) => {
    const values = input.sampleRows
      .map((row) => (row[columnIndex] ?? "").trim())
      .filter(Boolean);
    if (values.length === 0) return false;
    return (
      values.filter((value) => parseNumeric(value) != null).length / values.length >= 0.8
    );
  };

  const suggestions = RATE_CARD_FIELDS.map((field) => {
    const exact = normalized.filter((header) =>
      (field.aliases as readonly string[]).includes(header.normalized)
    );
    let suggestedHeader: string | null = null;
    let confidence: "confident" | "uncertain" | "none" = "none";
    let reason = `No column looked like ${field.label.toLowerCase()}.`;

    if (exact.length === 1) {
      const shapeOk = !field.numeric || looksNumeric(exact[0].index);
      suggestedHeader = exact[0].original;
      confidence = shapeOk ? "confident" : "uncertain";
      reason = shapeOk
        ? ""
        : `"${exact[0].original}" is named like ${field.label.toLowerCase()}, but its values do not look like numbers.`;
    } else if (exact.length > 1) {
      confidence = "uncertain";
      reason = `${exact.length} columns could be ${field.label.toLowerCase()}. Choose one.`;
    }

    return {
      field: field.key,
      label: field.label,
      purpose: field.purpose,
      required: field.required,
      suggestedHeader,
      confidence,
      candidates: exact.map((header) => header.original),
      reason,
    };
  });

  return {
    suggestions,
    needsConfirmation: suggestions.some(
      (suggestion) => suggestion.required && suggestion.confidence !== "confident"
    ),
  };
}

async function resolveStoreId(shopDomain: string): Promise<string> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!store) throw new HttpError(404, "Store not found.");
  return store.id;
}

export interface SaveRateCardResult {
  rateCardId: string;
  name: string;
  version: number;
  entryCount: number;
  skippedRows: Array<{ rowNumber: number; reason: string }>;
  supersededVersion: number | null;
}

/**
 * Saves a rate card as a NEW VERSION.
 *
 * The previous version is marked superseded, never deleted and never edited.
 * Runs that used it keep pointing at it and keep showing the rates that were
 * agreed when they ran.
 */
export async function saveRateCard(input: {
  shopDomain: string;
  name: string;
  fileName: string;
  buffer: Buffer;
  mapping: RateCardMapping;
  sheetName?: string | null;
  note?: string | null;
}): Promise<SaveRateCardResult> {
  const storeId = await resolveStoreId(input.shopDomain);
  const name = String(input.name ?? "").trim().slice(0, 120) || "Rate card";

  let parsed;
  try {
    parsed = parseSpreadsheet({
      fileName: input.fileName,
      buffer: input.buffer,
      sheetName: input.sheetName,
    });
  } catch (error) {
    if (error instanceof SpreadsheetParseError) throw new HttpError(400, error.message);
    throw error;
  }

  const indexOf = (field: RateCardFieldKey) => {
    const header = input.mapping[field];
    return header ? parsed.headers.indexOf(header) : -1;
  };
  const columns = Object.fromEntries(
    RATE_CARD_FIELDS.map((field) => [field.key, indexOf(field.key)])
  ) as Record<RateCardFieldKey, number>;

  if (columns.chargeType < 0 || columns.rate < 0) {
    throw new HttpError(
      400,
      "Choose a column for Charge type and a column for Agreed rate before saving."
    );
  }

  const cell = (row: string[], field: RateCardFieldKey) => {
    const index = columns[field];
    if (index < 0) return null;
    const value = (row[index] ?? "").trim();
    return value.length > 0 ? value : null;
  };

  const skippedRows: Array<{ rowNumber: number; reason: string }> = [];
  const entries: Array<{
    chargeKey: string;
    chargeType: string;
    aliasesJson: string | null;
    unit: string | null;
    rate: number;
    currency: string | null;
    minQuantity: number | null;
    maxQuantity: number | null;
  }> = [];
  const seenKeys = new Set<string>();

  parsed.rows.forEach((row, offset) => {
    const rowNumber = offset + 2;
    if (row.every((value) => !String(value ?? "").trim())) return;

    const chargeType = cell(row, "chargeType");
    const rate = parseNumeric(cell(row, "rate"));

    if (!chargeType) {
      skippedRows.push({ rowNumber, reason: "No charge type on this row." });
      return;
    }
    if (rate == null) {
      skippedRows.push({
        rowNumber,
        reason: `The rate for "${chargeType}" could not be read as a number.`,
      });
      return;
    }
    if (rate < 0) {
      skippedRows.push({
        rowNumber,
        reason: `The rate for "${chargeType}" is negative, which VedaSuite cannot use as an agreed price.`,
      });
      return;
    }

    const key = chargeKey(chargeType);
    if (!key) {
      skippedRows.push({ rowNumber, reason: "That charge type is not usable as a name." });
      return;
    }

    const min = parseNumeric(cell(row, "minQuantity"));
    const max = parseNumeric(cell(row, "maxQuantity"));
    // A row with a quantity band is a DIFFERENT entry for the same charge, so
    // it is not a duplicate. Only an unbanded repeat is.
    const identity = `${key}|${min ?? ""}|${max ?? ""}`;
    if (seenKeys.has(identity)) {
      skippedRows.push({
        rowNumber,
        reason: `"${chargeType}" already appears earlier in this file with the same quantity band.`,
      });
      return;
    }
    seenKeys.add(identity);

    const aliasRaw = cell(row, "aliases");
    const aliases = aliasRaw
      ? aliasRaw
          .split(/[;|]/)
          .map((alias) => chargeKey(alias))
          .filter((alias): alias is string => !!alias)
      : [];

    entries.push({
      chargeKey: key,
      chargeType,
      aliasesJson: aliases.length > 0 ? JSON.stringify(aliases) : null,
      unit: cell(row, "unit"),
      rate,
      currency: normalizeCurrency(cell(row, "currency")),
      minQuantity: min,
      maxQuantity: max,
    });
  });

  if (entries.length === 0) {
    throw new HttpError(
      400,
      "No usable rates were found in that file. Check that the charge type and rate columns are mapped correctly."
    );
  }

  const previous = await prisma.rateCard.findFirst({
    where: { storeId, name },
    orderBy: { version: "desc" },
    select: { id: true, version: true },
  });
  const version = (previous?.version ?? 0) + 1;

  const created = await prisma.$transaction(async (tx) => {
    if (previous) {
      // Superseded, NOT deleted. The old version still explains old runs.
      await tx.rateCard.updateMany({
        where: { storeId, name, status: "active" },
        data: { status: "superseded" },
      });
    }

    const card = await tx.rateCard.create({
      data: {
        storeId,
        name,
        version,
        status: "active",
        sourceFileName: parsed.fileName,
        currency: entries.find((entry) => entry.currency)?.currency ?? null,
        note: input.note?.slice(0, 500) ?? null,
      },
      select: { id: true },
    });

    await tx.rateCardEntry.createMany({
      data: entries.map((entry) => ({ ...entry, rateCardId: card.id, storeId })),
    });

    return card;
  });

  // Shape only: a charge type is commercially sensitive contract detail.
  logEvent("info", "reconciliation.rate_card_saved", {
    storeId,
    rateCardId: created.id,
    version,
    entryCount: entries.length,
    skippedCount: skippedRows.length,
  });

  return {
    rateCardId: created.id,
    name,
    version,
    entryCount: entries.length,
    skippedRows: skippedRows.slice(0, 20),
    supersededVersion: previous?.version ?? null,
  };
}

/** Loads a rate-card version's entries in the shape the checks expect. */
export async function loadRateCardEntries(input: {
  storeId: string;
  rateCardId: string;
}): Promise<{ name: string; version: number; entries: RateEntry[] } | null> {
  const card = await prisma.rateCard.findFirst({
    where: { id: input.rateCardId, storeId: input.storeId },
    select: {
      name: true,
      version: true,
      entries: {
        select: {
          id: true,
          chargeKey: true,
          chargeType: true,
          aliasesJson: true,
          unit: true,
          rate: true,
          currency: true,
          minQuantity: true,
          maxQuantity: true,
        },
      },
    },
  });
  if (!card) return null;

  return {
    name: card.name,
    version: card.version,
    entries: card.entries.map((entry) => ({
      id: entry.id,
      chargeKey: entry.chargeKey,
      chargeType: entry.chargeType,
      aliases: safeAliases(entry.aliasesJson),
      unit: entry.unit,
      rate: entry.rate,
      currency: entry.currency,
      minQuantity: entry.minQuantity,
      maxQuantity: entry.maxQuantity,
    })),
  };
}

function safeAliases(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** The active version for a store, used when a run does not name one. */
export async function getActiveRateCard(storeId: string) {
  return prisma.rateCard.findFirst({
    where: { storeId, status: "active" },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, version: true },
  });
}

/** Every version, newest first, so a merchant can see the history. */
export async function listRateCards(shopDomain: string) {
  const storeId = await resolveStoreId(shopDomain);
  const cards = await prisma.rateCard.findMany({
    where: { storeId },
    orderBy: [{ name: "asc" }, { version: "desc" }],
    take: 50,
    select: {
      id: true,
      name: true,
      version: true,
      status: true,
      currency: true,
      note: true,
      sourceFileName: true,
      createdAt: true,
      _count: { select: { entries: true } },
    },
  });
  return cards.map((card) => ({
    id: card.id,
    name: card.name,
    version: card.version,
    status: card.status,
    currency: card.currency,
    note: card.note,
    sourceFileName: card.sourceFileName,
    createdAt: card.createdAt,
    entryCount: card._count.entries,
  }));
}
