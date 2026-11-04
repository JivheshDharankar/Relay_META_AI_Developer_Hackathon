-- CreateEnum
CREATE TYPE "ResidentStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SupplierStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ProductUnit" AS ENUM ('KG', 'LITRE', 'GRAM', 'ML', 'PACK', 'UNIT');

-- CreateEnum
CREATE TYPE "ResidentOrderStatus" AS ENUM ('PENDING', 'AGGREGATING', 'PROCURED', 'PAYMENT_PENDING', 'PAID', 'FULFILLING', 'DELIVERED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CommunityOrderStatus" AS ENUM ('CREATED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCESS', 'SUPPLIER_CONFIRMED', 'DISPATCHED', 'DELIVERED', 'RECONCILED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SupplierOfferStatus" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'REJECTED', 'NEGOTIATING', 'ACCEPTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NegotiationStatus" AS ENUM ('STARTED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentMandateStatus" AS ENUM ('ACTIVE', 'PAUSED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'PROCESSING', 'SUCCESS', 'FAILED', 'REFUNDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PREPARING', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryAllocationStatus" AS ENUM ('PENDING', 'ALLOCATED', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('REQUEST_CREATED', 'AUTHORIZATION_CHECKED', 'DEMAND_AGGREGATED', 'SUPPLIERS_DISCOVERED', 'OFFER_REJECTED', 'NEGOTIATION_STARTED', 'NEGOTIATION_COMPLETED', 'OFFER_SELECTED', 'ORDER_CREATED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCESS', 'SUPPLIER_CONFIRMED', 'DISPATCHED', 'DELIVERED', 'RECONCILED');

-- CreateTable
CREATE TABLE "societies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "societies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "residents" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "flatNumber" TEXT,
    "status" "ResidentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "residents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "serviceRadiusKm" DECIMAL(6,2) NOT NULL DEFAULT 10.0,
    "reliabilityScore" DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    "status" "SupplierStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" "ProductUnit" NOT NULL,
    "sku" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resident_orders" (
    "id" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "communityOrderId" TEXT,
    "status" "ResidentOrderStatus" NOT NULL DEFAULT 'PENDING',
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "deliveryAddress" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resident_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "residentOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,4) NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_orders" (
    "id" TEXT NOT NULL,
    "societyId" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "supplierOfferId" TEXT,
    "status" "CommunityOrderStatus" NOT NULL DEFAULT 'CREATED',
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "deliveryDeadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_order_items" (
    "id" TEXT NOT NULL,
    "communityOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "totalQuantity" DECIMAL(10,4) NOT NULL,
    "negotiatedUnitPrice" DECIMAL(12,2) NOT NULL,
    "totalPrice" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_offers" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "communityOrderId" TEXT,
    "status" "SupplierOfferStatus" NOT NULL DEFAULT 'RECEIVED',
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "estimatedDeliveryTime" TIMESTAMP(3),
    "reliabilitySnapshot" DECIMAL(3,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negotiations" (
    "id" TEXT NOT NULL,
    "supplierOfferId" TEXT NOT NULL,
    "status" "NegotiationStatus" NOT NULL DEFAULT 'STARTED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "initialAmount" DECIMAL(12,2) NOT NULL,
    "finalAmount" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "negotiations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "negotiation_rounds" (
    "id" TEXT NOT NULL,
    "negotiationId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL,
    "offerAmount" DECIMAL(12,2) NOT NULL,
    "supplierResponse" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "negotiation_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_mandates" (
    "id" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "status" "PaymentMandateStatus" NOT NULL DEFAULT 'ACTIVE',
    "maximumAmount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "purpose" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3),
    "providerReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "residentOrderId" TEXT NOT NULL,
    "paymentMandateId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "communityOrderId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_allocations" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "residentOrderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DECIMAL(10,4) NOT NULL,
    "status" "DeliveryAllocationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delivery_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "eventType" "AuditEventType" NOT NULL,
    "actor" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "residents_email_key" ON "residents"("email");

-- CreateIndex
CREATE INDEX "residents_societyId_idx" ON "residents"("societyId");

-- CreateIndex
CREATE INDEX "residents_status_idx" ON "residents"("status");

-- CreateIndex
CREATE INDEX "suppliers_status_idx" ON "suppliers"("status");

-- CreateIndex
CREATE INDEX "suppliers_city_idx" ON "suppliers"("city");

-- CreateIndex
CREATE UNIQUE INDEX "products_sku_key" ON "products"("sku");

-- CreateIndex
CREATE INDEX "products_category_idx" ON "products"("category");

-- CreateIndex
CREATE INDEX "resident_orders_residentId_idx" ON "resident_orders"("residentId");

-- CreateIndex
CREATE INDEX "resident_orders_societyId_idx" ON "resident_orders"("societyId");

-- CreateIndex
CREATE INDEX "resident_orders_communityOrderId_idx" ON "resident_orders"("communityOrderId");

-- CreateIndex
CREATE INDEX "resident_orders_status_idx" ON "resident_orders"("status");

-- CreateIndex
CREATE INDEX "order_items_residentOrderId_idx" ON "order_items"("residentOrderId");

-- CreateIndex
CREATE INDEX "order_items_productId_idx" ON "order_items"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "community_orders_supplierOfferId_key" ON "community_orders"("supplierOfferId");

-- CreateIndex
CREATE INDEX "community_orders_societyId_idx" ON "community_orders"("societyId");

-- CreateIndex
CREATE INDEX "community_orders_supplierId_idx" ON "community_orders"("supplierId");

-- CreateIndex
CREATE INDEX "community_orders_status_idx" ON "community_orders"("status");

-- CreateIndex
CREATE INDEX "community_orders_deliveryDeadline_idx" ON "community_orders"("deliveryDeadline");

-- CreateIndex
CREATE INDEX "community_order_items_communityOrderId_idx" ON "community_order_items"("communityOrderId");

-- CreateIndex
CREATE INDEX "community_order_items_productId_idx" ON "community_order_items"("productId");

-- CreateIndex
CREATE INDEX "supplier_offers_supplierId_idx" ON "supplier_offers"("supplierId");

-- CreateIndex
CREATE INDEX "supplier_offers_communityOrderId_idx" ON "supplier_offers"("communityOrderId");

-- CreateIndex
CREATE INDEX "supplier_offers_status_idx" ON "supplier_offers"("status");

-- CreateIndex
CREATE INDEX "negotiations_supplierOfferId_idx" ON "negotiations"("supplierOfferId");

-- CreateIndex
CREATE INDEX "negotiations_status_idx" ON "negotiations"("status");

-- CreateIndex
CREATE INDEX "negotiation_rounds_negotiationId_idx" ON "negotiation_rounds"("negotiationId");

-- CreateIndex
CREATE UNIQUE INDEX "negotiation_rounds_negotiationId_roundNumber_key" ON "negotiation_rounds"("negotiationId", "roundNumber");

-- CreateIndex
CREATE INDEX "payment_mandates_residentId_idx" ON "payment_mandates"("residentId");

-- CreateIndex
CREATE INDEX "payment_mandates_status_idx" ON "payment_mandates"("status");

-- CreateIndex
CREATE INDEX "payments_residentOrderId_idx" ON "payments"("residentOrderId");

-- CreateIndex
CREATE INDEX "payments_paymentMandateId_idx" ON "payments"("paymentMandateId");

-- CreateIndex
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_communityOrderId_key" ON "deliveries"("communityOrderId");

-- CreateIndex
CREATE INDEX "deliveries_communityOrderId_idx" ON "deliveries"("communityOrderId");

-- CreateIndex
CREATE INDEX "deliveries_status_idx" ON "deliveries"("status");

-- CreateIndex
CREATE INDEX "delivery_allocations_deliveryId_idx" ON "delivery_allocations"("deliveryId");

-- CreateIndex
CREATE INDEX "delivery_allocations_residentOrderId_idx" ON "delivery_allocations"("residentOrderId");

-- CreateIndex
CREATE INDEX "delivery_allocations_productId_idx" ON "delivery_allocations"("productId");

-- CreateIndex
CREATE INDEX "audit_events_entityType_entityId_idx" ON "audit_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_events_eventType_idx" ON "audit_events"("eventType");

-- CreateIndex
CREATE INDEX "audit_events_createdAt_idx" ON "audit_events"("createdAt");

-- AddForeignKey
ALTER TABLE "residents" ADD CONSTRAINT "residents_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "societies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_orders" ADD CONSTRAINT "resident_orders_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_orders" ADD CONSTRAINT "resident_orders_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "societies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resident_orders" ADD CONSTRAINT "resident_orders_communityOrderId_fkey" FOREIGN KEY ("communityOrderId") REFERENCES "community_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_residentOrderId_fkey" FOREIGN KEY ("residentOrderId") REFERENCES "resident_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_orders" ADD CONSTRAINT "community_orders_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "societies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_orders" ADD CONSTRAINT "community_orders_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_orders" ADD CONSTRAINT "community_orders_supplierOfferId_fkey" FOREIGN KEY ("supplierOfferId") REFERENCES "supplier_offers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_order_items" ADD CONSTRAINT "community_order_items_communityOrderId_fkey" FOREIGN KEY ("communityOrderId") REFERENCES "community_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_order_items" ADD CONSTRAINT "community_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_offers" ADD CONSTRAINT "supplier_offers_communityOrderId_fkey" FOREIGN KEY ("communityOrderId") REFERENCES "community_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negotiations" ADD CONSTRAINT "negotiations_supplierOfferId_fkey" FOREIGN KEY ("supplierOfferId") REFERENCES "supplier_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negotiation_rounds" ADD CONSTRAINT "negotiation_rounds_negotiationId_fkey" FOREIGN KEY ("negotiationId") REFERENCES "negotiations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_mandates" ADD CONSTRAINT "payment_mandates_residentId_fkey" FOREIGN KEY ("residentId") REFERENCES "residents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_residentOrderId_fkey" FOREIGN KEY ("residentOrderId") REFERENCES "resident_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_paymentMandateId_fkey" FOREIGN KEY ("paymentMandateId") REFERENCES "payment_mandates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_communityOrderId_fkey" FOREIGN KEY ("communityOrderId") REFERENCES "community_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_allocations" ADD CONSTRAINT "delivery_allocations_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_allocations" ADD CONSTRAINT "delivery_allocations_residentOrderId_fkey" FOREIGN KEY ("residentOrderId") REFERENCES "resident_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_allocations" ADD CONSTRAINT "delivery_allocations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
