CREATE TABLE "ProductSnapshot" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "shopifyProductId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "currentPrice" DOUBLE PRECISION,
    "currency" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VariantSnapshot" (
    "id" TEXT NOT NULL,
    "productSnapshotId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariantSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductSnapshot_storeId_shopifyProductId_key" ON "ProductSnapshot"("storeId", "shopifyProductId");
CREATE INDEX "ProductSnapshot_storeId_handle_idx" ON "ProductSnapshot"("storeId", "handle");
CREATE UNIQUE INDEX "VariantSnapshot_productSnapshotId_shopifyVariantId_key" ON "VariantSnapshot"("productSnapshotId", "shopifyVariantId");

ALTER TABLE "ProductSnapshot"
ADD CONSTRAINT "ProductSnapshot_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "VariantSnapshot"
ADD CONSTRAINT "VariantSnapshot_productSnapshotId_fkey"
FOREIGN KEY ("productSnapshotId") REFERENCES "ProductSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
