import { prisma } from "../db/prismaClient";
import { logEvent } from "./observabilityService";

export const SUPPORT_TICKET_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
] as const;
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number];

export const SUPPORT_TICKET_CATEGORIES = [
  "general",
  "billing",
  "technical",
  "bug",
  "feature_request",
] as const;
export type SupportTicketCategory = (typeof SUPPORT_TICKET_CATEGORIES)[number];

const SUBJECT_MAX = 150;
const MESSAGE_MAX = 4000;
const EMAIL_MAX = 200;

function normalizeCategory(value: unknown): SupportTicketCategory {
  return SUPPORT_TICKET_CATEGORIES.includes(value as SupportTicketCategory)
    ? (value as SupportTicketCategory)
    : "general";
}

function trimmedString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

export type CreateTicketInput = {
  subject?: unknown;
  message?: unknown;
  category?: unknown;
  contactEmail?: unknown;
};

export type CreateTicketResult =
  | { ok: true; ticket: MerchantTicketView }
  | { ok: false; error: string };

export type MerchantTicketView = {
  id: string;
  subject: string;
  category: string;
  message: string;
  status: string;
  adminResponse: string | null;
  respondedAt: string | null;
  createdAt: string;
};

function toMerchantView(t: {
  id: string;
  subject: string;
  category: string;
  message: string;
  status: string;
  adminResponse: string | null;
  respondedAt: Date | null;
  createdAt: Date;
}): MerchantTicketView {
  return {
    id: t.id,
    subject: t.subject,
    category: t.category,
    message: t.message,
    status: t.status,
    adminResponse: t.adminResponse,
    respondedAt: t.respondedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function createSupportTicket(
  shopDomain: string,
  input: CreateTicketInput
): Promise<CreateTicketResult> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });

  if (!store) {
    return { ok: false, error: "Store not found." };
  }

  const subject = trimmedString(input.subject, SUBJECT_MAX);
  const message = trimmedString(input.message, MESSAGE_MAX);
  const contactEmail = trimmedString(input.contactEmail, EMAIL_MAX);

  if (!subject) {
    return { ok: false, error: "A subject is required." };
  }
  if (!message) {
    return { ok: false, error: "A message is required." };
  }
  if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) {
    return { ok: false, error: "Enter a valid contact email, or leave it blank." };
  }

  const ticket = await prisma.supportTicket.create({
    data: {
      storeId: store.id,
      shop: shopDomain,
      subject,
      message,
      category: normalizeCategory(input.category),
      contactEmail: contactEmail || null,
      status: "OPEN",
    },
  });

  logEvent("info", "support.ticket_created", {
    shop: shopDomain,
    ticketId: ticket.id,
    category: ticket.category,
  });

  return { ok: true, ticket: toMerchantView(ticket) };
}

export async function listTicketsForShop(
  shopDomain: string
): Promise<MerchantTicketView[]> {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    select: { id: true },
  });
  if (!store) return [];

  const tickets = await prisma.supportTicket.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return tickets.map(toMerchantView);
}

// ---- Admin (developer) side ----

export type AdminTicketView = MerchantTicketView & {
  shop: string;
  contactEmail: string | null;
  updatedAt: string;
};

export async function listAllTickets(filter?: {
  status?: string;
}): Promise<AdminTicketView[]> {
  const where =
    filter?.status && SUPPORT_TICKET_STATUSES.includes(filter.status as SupportTicketStatus)
      ? { status: filter.status }
      : {};

  const tickets = await prisma.supportTicket.findMany({
    where,
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 500,
  });

  return tickets.map((t) => ({
    ...toMerchantView(t),
    shop: t.shop,
    contactEmail: t.contactEmail,
    updatedAt: t.updatedAt.toISOString(),
  }));
}

export type UpdateTicketResult =
  | { ok: true }
  | { ok: false; error: string };

export async function updateTicketAsAdmin(
  ticketId: string,
  input: { status?: unknown; adminResponse?: unknown }
): Promise<UpdateTicketResult> {
  const existing = await prisma.supportTicket.findUnique({
    where: { id: ticketId },
    select: { id: true },
  });
  if (!existing) {
    return { ok: false, error: "Ticket not found." };
  }

  const status =
    typeof input.status === "string" &&
    SUPPORT_TICKET_STATUSES.includes(input.status as SupportTicketStatus)
      ? (input.status as SupportTicketStatus)
      : undefined;

  const adminResponse =
    typeof input.adminResponse === "string"
      ? input.adminResponse.trim().slice(0, MESSAGE_MAX)
      : undefined;

  if (status === undefined && adminResponse === undefined) {
    return { ok: false, error: "Nothing to update." };
  }

  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      ...(status !== undefined ? { status } : {}),
      ...(adminResponse !== undefined
        ? { adminResponse, respondedAt: new Date() }
        : {}),
    },
  });

  logEvent("info", "support.ticket_updated", {
    ticketId,
    status: status ?? "(unchanged)",
    responded: adminResponse !== undefined,
  });

  return { ok: true };
}
