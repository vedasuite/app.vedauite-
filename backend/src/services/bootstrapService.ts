import { prisma } from "../db/prismaClient";

export async function ensureStoreBootstrapped(shop: string) {
  const store = await prisma.store.findUnique({
    where: { shop },
  });

  if (!store) {
    throw new Error("Store not found");
  }

  const existingOrderCount = await prisma.order.count({
    where: { storeId: store.id },
  });

  if (existingOrderCount > 0) {
    return;
  }

  const now = Date.now();

  await prisma.$transaction(async (tx) => {
    const customerA = await tx.customer.create({
      data: {
        storeId: store.id,
        shopifyCustomerId: `${shop}-customer-1`,
        email: "vip@vedasuite-demo.com",
        totalOrders: 9,
        totalRefunds: 1,
        refundRate: 0.11,
        fraudSignalsCount: 0,
        paymentReliability: 18,
        creditScore: 88,
        creditCategory: "Trusted Buyer",
      },
    });

    const customerB = await tx.customer.create({
      data: {
        storeId: store.id,
        shopifyCustomerId: `${shop}-customer-2`,
        email: "returns@vedasuite-demo.com",
        totalOrders: 6,
        totalRefunds: 3,
        refundRate: 0.5,
        fraudSignalsCount: 3,
        paymentReliability: 8,
        creditScore: 42,
        creditCategory: "Risky Buyer",
      },
    });

    const approvedOrder = await tx.order.create({
      data: {
        storeId: store.id,
        customerId: customerA.id,
        shopifyOrderId: `${shop}-order-1001`,
        totalAmount: 129.99,
        currency: "USD",
        fraudScore: 18,
        fraudRiskLevel: "Low",
        status: "approved",
        createdAt: new Date(now - 2 * 60 * 60 * 1000),
      },
    });

    const flaggedOrder = await tx.order.create({
      data: {
        storeId: store.id,
        customerId: customerB.id,
        shopifyOrderId: `${shop}-order-1002`,
        totalAmount: 349.5,
        currency: "USD",
        fraudScore: 81,
        fraudRiskLevel: "High",
        status: "manual_review",
        refundRequested: true,
        createdAt: new Date(now - 45 * 60 * 1000),
      },
    });

    await tx.fraudSignal.create({
      data: {
        storeId: store.id,
        orderId: flaggedOrder.id,
        customerId: customerB.id,
        ipAddress: "10.23.45.67",
        email: customerB.email,
        shippingAddress: "14 Demo Street, Jaipur",
        deviceFingerprint: "demo-device-risk",
        paymentFingerprint: "demo-payment-risk",
        refundHistory: "3",
        orderFrequency: "High",
        riskScore: 81,
        riskLevel: "High",
      },
    });

    await tx.competitorDomain.createMany({
      data: [
        {
          storeId: store.id,
          domain: "styleorbit.example",
          label: "Style Orbit",
        },
        {
          storeId: store.id,
          domain: "urbanloom.example",
          label: "Urban Loom",
        },
      ],
    });

    await tx.competitorData.createMany({
      data: [
        {
          storeId: store.id,
          productHandle: "linen-shirt",
          competitorName: "Style Orbit",
          competitorUrl: "https://styleorbit.example/products/linen-shirt",
          source: "website",
          price: 59,
          promotion: "10% off",
          stockStatus: "in_stock",
          collectedAt: new Date(now - 3 * 60 * 60 * 1000),
        },
        {
          storeId: store.id,
          productHandle: "cotton-kurta",
          competitorName: "Urban Loom",
          competitorUrl: "https://urbanloom.example/products/cotton-kurta",
          source: "website",
          price: 74,
          promotion: null,
          stockStatus: "low_stock",
          collectedAt: new Date(now - 90 * 60 * 1000),
        },
      ],
    });

    await tx.priceHistory.createMany({
      data: [
        {
          storeId: store.id,
          productHandle: "linen-shirt",
          currentPrice: 62,
          recommendedPrice: 64,
          expectedMarginDelta: 6.5,
          expectedProfitGain: 240,
        },
        {
          storeId: store.id,
          productHandle: "cotton-kurta",
          currentPrice: 79,
          recommendedPrice: 76,
          expectedMarginDelta: 3.2,
          expectedProfitGain: 180,
        },
      ],
    });

    await tx.profitOptimizationData.create({
      data: {
        storeId: store.id,
        productHandle: "linen-shirt",
        productCost: 28,
        sellingPrice: 62,
        competitorAveragePrice: 59,
        advertisingSpend: 8,
        shippingCost: 4,
        returnRate: 0.06,
        salesVelocity: 3.5,
        optimalPrice: 64,
        projectedMarginIncrease: 6.5,
        projectedMonthlyProfit: 240,
        bundleSuggestionsJson: JSON.stringify(["Pair with summer trousers"]),
        discountStrategyJson: JSON.stringify(["Keep full price; add bundle offer"]),
      },
    });

    await tx.subscriptionPlan.upsert({
      where: { name: "PRO" },
      update: {},
      create: {
        name: "PRO",
        price: 99,
        trialDays: 3,
        features: JSON.stringify({
          fraud: true,
          competitor: true,
          pricing: true,
          creditScore: true,
          profitOptimization: true,
        }),
      },
    });

    const proPlan = await tx.subscriptionPlan.findUnique({
      where: { name: "PRO" },
    });

    if (proPlan) {
      await tx.storeSubscription.upsert({
        where: { storeId: store.id },
        update: {
          planId: proPlan.id,
          active: true,
          endsAt: null,
        },
        create: {
          storeId: store.id,
          planId: proPlan.id,
          active: true,
        },
      });
    }

    await tx.order.update({
      where: { id: approvedOrder.id },
      data: {
        updatedAt: new Date(now - 30 * 60 * 1000),
      },
    });
  });
}
