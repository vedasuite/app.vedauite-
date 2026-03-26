import { prisma } from "../db/prismaClient";

export type SettingsInput = {
  fraudSensitivity?: "low" | "medium" | "high";
  sharedFraudNetwork?: boolean;
  pricingBias?: number;
  profitGuardrail?: number;
  competitorDomains?: { domain: string; label?: string }[];
};

export async function getSettings(shopDomain: string) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
    include: { competitorDomains: true },
  });
  if (!store) throw new Error("Store not found");

  return {
    fraudSensitivity: store.fraudSensitivity,
    sharedFraudNetwork: store.sharedFraudNetwork,
    pricingBias: store.pricingBias,
    profitGuardrail: store.profitGuardrail,
    competitorDomains: store.competitorDomains,
  };
}

export async function updateSettings(
  shopDomain: string,
  input: SettingsInput
) {
  const store = await prisma.store.findUnique({
    where: { shop: shopDomain },
  });
  if (!store) throw new Error("Store not found");

  await prisma.store.update({
    where: { id: store.id },
    data: {
      fraudSensitivity: input.fraudSensitivity ?? store.fraudSensitivity,
      sharedFraudNetwork:
        input.sharedFraudNetwork ?? store.sharedFraudNetwork,
      pricingBias: input.pricingBias ?? store.pricingBias,
      profitGuardrail: input.profitGuardrail ?? store.profitGuardrail,
    },
  });

  if (input.competitorDomains) {
    await prisma.competitorDomain.deleteMany({
      where: { storeId: store.id },
    });
    await prisma.competitorDomain.createMany({
      data: input.competitorDomains.map((d) => ({
        storeId: store.id,
        domain: d.domain,
        label: d.label,
      })),
    });
  }

  return getSettings(shopDomain);
}

