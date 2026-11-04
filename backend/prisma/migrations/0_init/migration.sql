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
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'PREPARING', 'DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeliveryAllocationStatus" AS ENUM ('PENDING', 'ALLOCATED', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('REQUEST_CREATED', 'AUTHORIZATION_CHECKED', 'DEMAND_AGGREGATED', 'SUPPLIERS_DISCOVERED', 'OFFER_REJECTED', 'NEGOTIATION_STARTED', 'NEGOTIATION_COMPLETED', 'OFFER_SELECTED', 'ORDER_CREATED', 'PAYMENT_AUTHORIZED', 'PAYMENT_SUCCESS', 'SUPPLIER_CONFIRMED', 'DISPATCHED', 'DELIVERED', 'RECONCILED', 'AGENT_REQUEST_RECEIVED', 'AGENT_TOOL_CALLED', 'AGENT_TOOL_SUCCEEDED', 'AGENT_TOOL_FAILED', 'AGENT_WORKFLOW_COMPLETED', 'AGENT_WORKFLOW_FAILED', 'PAYMENT_EXECUTION_STARTED', 'PAYMENT_EXECUTION_SUCCEEDED', 'PAYMENT_EXECUTION_FAILED', 'SUPPLIER_PO_SUBMITTED', 'SUPPLIER_REJECTED', 'DELIVERY_INITIALIZED', 'DELIVERY_PREPARING', 'DELIVERY_OUT_FOR_DELIVERY', 'ALLOCATION_STARTED', 'ALLOCATION_CALCULATED', 'ALLOCATION_VALIDATED', 'ALLOCATION_FINALIZED', 'ALLOCATION_REJECTED', 'LEDGER_ENTRY_CREATED', 'LEDGER_ADJUSTMENT_CREATED', 'LEDGER_REVERSAL_CREATED', 'RECONCILIATION_STARTED', 'RECONCILIATION_RECONCILED', 'RECONCILIATION_DISCREPANCY', 'RECONCILIATION_BLOCKED', 'WORKFLOW_CREATED', 'WORKFLOW_STAGE_STARTED', 'WORKFLOW_STAGE_COMPLETED', 'WORKFLOW_WAITING', 'WORKFLOW_RETRYING', 'WORKFLOW_BLOCKED', 'WORKFLOW_FAILED', 'WORKFLOW_COMPLETED');

-- CreateEnum
CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'RECEIVED', 'UNDERSTANDING', 'AWAITING_CLARIFICATION', 'DEMAND_CREATED', 'DISCOVERING_SUPPLIERS', 'QUALIFYING_SUPPLIERS', 'REQUESTING_QUOTES', 'WAITING_FOR_QUOTES', 'NEGOTIATING', 'SELECTING_SUPPLIER', 'COMMITTING_PROCUREMENT', 'AUTHORIZING_PAYMENT', 'EXECUTING_PAYMENT', 'FULFILLING', 'DELIVERING', 'VERIFYING_FULFILLMENT', 'ALLOCATING_RESIDENT_DEMAND', 'RECONCILING', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowStage" AS ENUM ('UNDERSTAND', 'DISCOVER', 'QUALIFY', 'QUOTE', 'NEGOTIATE', 'SELECT', 'COMMIT', 'PAY', 'FULFILL', 'VERIFY', 'ALLOCATE', 'RECONCILE', 'COMPLETE');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('PENDING', 'CALCULATED', 'VALIDATED', 'FINALIZED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'RECONCILED', 'DISCREPANCY', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ResidentLedgerEntryType" AS ENUM ('PROCUREMENT_ALLOCATION', 'ADJUSTMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "ResidentLedgerEntryStatus" AS ENUM ('POSTED', 'ADJUSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ReconciliationDiscrepancyType" AS ENUM ('QUANTITY_MISMATCH', 'MONETARY_MISMATCH', 'SUPPLIER_OBLIGATION_MISMATCH', 'PAYMENT_LINKAGE_MISMATCH', 'UNVERIFIED_FULFILLMENT', 'NEGATIVE_VALUE_DETECTED', 'OVER_ALLOCATION_DETECTED');

-- CreateTable
CREATE TABLE "system_health_records" (
    "id" TEXT NOT NULL,
    "service" TEXT NOT NULL DEFAULT 'relay-backend',
    "status" TEXT NOT NULL DEFAULT 'ok',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "system_health_records_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "supplier_products" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "basePrice" DECIMAL(12,2) NOT NULL,
    "moq" DECIMAL(10,4) NOT NULL DEFAULT 1.0,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resident_orders" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT,
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
    "idempotencyKey" TEXT,
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
    "idempotencyKey" TEXT,
    "residentOrderId" TEXT,
    "paymentMandateId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "providerReference" TEXT,
    "failureCode" TEXT,
    "authorizedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "providerName" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "attempts" JSONB NOT NULL DEFAULT '[]',
    "metadata" JSONB,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "communityOrderId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "trackingCode" TEXT,
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

-- CreateTable
CREATE TABLE "resident_allocations" (
    "id" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "purchaseOrderId" TEXT,
    "fulfillmentOrderId" TEXT,
    "residentOrderId" TEXT NOT NULL,
    "residentReference" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "requestedQuantity" DECIMAL(10,4) NOT NULL,
    "allocatedQuantity" DECIMAL(10,4) NOT NULL,
    "unit" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "allocatedTax" DECIMAL(12,2) NOT NULL,
    "allocatedDeliveryFee" DECIMAL(12,2) NOT NULL,
    "allocatedOtherCharges" DECIMAL(12,2) NOT NULL,
    "totalAmount" DECIMAL(12,2) NOT NULL,
    "status" "AllocationStatus" NOT NULL DEFAULT 'PENDING',
    "reconciliationStatus" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resident_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resident_ledger_entries" (
    "id" TEXT NOT NULL,
    "residentReference" TEXT NOT NULL,
    "residentOrderId" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "entryType" "ResidentLedgerEntryType" NOT NULL DEFAULT 'PROCUREMENT_ALLOCATION',
    "status" "ResidentLedgerEntryStatus" NOT NULL DEFAULT 'POSTED',
    "referenceEntryId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resident_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_records" (
    "id" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedFulfilledQuantity" DECIMAL(10,4) NOT NULL,
    "totalAllocatedQuantity" DECIMAL(10,4) NOT NULL,
    "authoritativeProcurementAmount" DECIMAL(12,2) NOT NULL,
    "totalAllocatedResidentAmount" DECIMAL(12,2) NOT NULL,
    "isQuantityMatched" BOOLEAN NOT NULL DEFAULT false,
    "isMonetaryMatched" BOOLEAN NOT NULL DEFAULT false,
    "isSupplierObligationsMatched" BOOLEAN NOT NULL DEFAULT false,
    "isPaymentVerified" BOOLEAN NOT NULL DEFAULT false,
    "reconciledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "societyId" TEXT,
    "workflowId" TEXT,
    "inputHash" TEXT,
    "inputRefs" JSONB,
    "lineItems" JSONB,
    "commercialBasisSimulated" BOOLEAN,
    "settlementBasis" TEXT NOT NULL DEFAULT 'COMPUTED',
    "idempotencyKey" TEXT,
    "reason" TEXT,

    CONSTRAINT "reconciliation_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_discrepancies" (
    "id" TEXT NOT NULL,
    "reconciliationId" TEXT NOT NULL,
    "commitmentId" TEXT NOT NULL,
    "discrepancyType" "ReconciliationDiscrepancyType" NOT NULL,
    "expectedValue" TEXT NOT NULL,
    "actualValue" TEXT NOT NULL,
    "difference" DECIMAL(12,4) NOT NULL,
    "affectedResidentOrderIds" TEXT[],
    "reasonCode" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_discrepancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_workflows" (
    "id" TEXT NOT NULL,
    "residentReference" TEXT NOT NULL,
    "societyReference" TEXT NOT NULL,
    "requestText" TEXT NOT NULL,
    "status" "WorkflowStatus" NOT NULL DEFAULT 'RECEIVED',
    "currentStage" "WorkflowStage" NOT NULL DEFAULT 'UNDERSTAND',
    "workflowVersion" INTEGER NOT NULL DEFAULT 1,
    "failureReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relay_workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mission_idempotency_keys" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "residentReference" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mission_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_workflow_checkpoints" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "stage" "WorkflowStage" NOT NULL,
    "status" "WorkflowStatus" NOT NULL,
    "entityIds" JSONB NOT NULL,
    "stateSnapshot" JSONB,
    "workflowVersion" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relay_workflow_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_workflow_events" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "stage" "WorkflowStage" NOT NULL,
    "payload" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relay_workflow_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "authProvider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "name" TEXT NOT NULL,
    "profileImage" TEXT,
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_idempotency_claims" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "payment_data" JSONB,
    "provider_tx_id" TEXT,
    "failure_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_idempotency_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_refund_claims" (
    "id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "mandate_id" TEXT NOT NULL,
    "provider_tx_id" TEXT,
    "mandate_credited" BOOLEAN NOT NULL DEFAULT false,
    "mandate_credited_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_refund_claims_pkey" PRIMARY KEY ("id")
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
CREATE INDEX "supplier_products_supplierId_idx" ON "supplier_products"("supplierId");

-- CreateIndex
CREATE INDEX "supplier_products_productId_idx" ON "supplier_products"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_products_supplierId_productId_key" ON "supplier_products"("supplierId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "resident_orders_idempotencyKey_key" ON "resident_orders"("idempotencyKey");

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
CREATE UNIQUE INDEX "community_orders_idempotencyKey_key" ON "community_orders"("idempotencyKey");

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
CREATE UNIQUE INDEX "payments_idempotencyKey_key" ON "payments"("idempotencyKey");

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

-- CreateIndex
CREATE UNIQUE INDEX "resident_allocations_idempotencyKey_key" ON "resident_allocations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "resident_allocations_commitmentId_idx" ON "resident_allocations"("commitmentId");

-- CreateIndex
CREATE INDEX "resident_allocations_residentOrderId_idx" ON "resident_allocations"("residentOrderId");

-- CreateIndex
CREATE INDEX "resident_allocations_residentReference_idx" ON "resident_allocations"("residentReference");

-- CreateIndex
CREATE INDEX "resident_allocations_status_idx" ON "resident_allocations"("status");

-- CreateIndex
CREATE INDEX "resident_ledger_entries_residentReference_idx" ON "resident_ledger_entries"("residentReference");

-- CreateIndex
CREATE INDEX "resident_ledger_entries_residentOrderId_idx" ON "resident_ledger_entries"("residentOrderId");

-- CreateIndex
CREATE INDEX "resident_ledger_entries_allocationId_idx" ON "resident_ledger_entries"("allocationId");

-- CreateIndex
CREATE INDEX "resident_ledger_entries_commitmentId_idx" ON "resident_ledger_entries"("commitmentId");

-- CreateIndex
CREATE INDEX "reconciliation_records_commitmentId_idx" ON "reconciliation_records"("commitmentId");

-- CreateIndex
CREATE INDEX "reconciliation_records_status_idx" ON "reconciliation_records"("status");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_records_commitmentId_idempotencyKey_key" ON "reconciliation_records"("commitmentId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_records_commitmentId_version_key" ON "reconciliation_records"("commitmentId", "version");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_reconciliationId_idx" ON "reconciliation_discrepancies"("reconciliationId");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_commitmentId_idx" ON "reconciliation_discrepancies"("commitmentId");

-- CreateIndex
CREATE INDEX "reconciliation_discrepancies_discrepancyType_idx" ON "reconciliation_discrepancies"("discrepancyType");

-- CreateIndex
CREATE INDEX "relay_workflows_residentReference_idx" ON "relay_workflows"("residentReference");

-- CreateIndex
CREATE INDEX "relay_workflows_status_idx" ON "relay_workflows"("status");

-- CreateIndex
CREATE INDEX "relay_workflows_currentStage_idx" ON "relay_workflows"("currentStage");

-- CreateIndex
CREATE INDEX "mission_idempotency_keys_workflowId_idx" ON "mission_idempotency_keys"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "mission_idempotency_keys_residentReference_keyHash_key" ON "mission_idempotency_keys"("residentReference", "keyHash");

-- CreateIndex
CREATE INDEX "relay_workflow_checkpoints_workflowId_idx" ON "relay_workflow_checkpoints"("workflowId");

-- CreateIndex
CREATE INDEX "relay_workflow_checkpoints_stage_idx" ON "relay_workflow_checkpoints"("stage");

-- CreateIndex
CREATE INDEX "relay_workflow_events_workflowId_idx" ON "relay_workflow_events"("workflowId");

-- CreateIndex
CREATE INDEX "relay_workflow_events_eventName_idx" ON "relay_workflow_events"("eventName");

-- CreateIndex
CREATE UNIQUE INDEX "user_sessions_tokenHash_key" ON "user_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "user_sessions_userId_idx" ON "user_sessions"("userId");

-- CreateIndex
CREATE INDEX "user_sessions_expiresAt_idx" ON "user_sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "user_sessions_revokedAt_idx" ON "user_sessions"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_idempotency_claims_key_key" ON "payment_idempotency_claims"("key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refund_claims_payment_id_key" ON "payment_refund_claims"("payment_id");

-- AddForeignKey
ALTER TABLE "residents" ADD CONSTRAINT "residents_societyId_fkey" FOREIGN KEY ("societyId") REFERENCES "societies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "resident_allocations" ADD CONSTRAINT "resident_allocations_residentOrderId_fkey" FOREIGN KEY ("residentOrderId") REFERENCES "resident_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_discrepancies" ADD CONSTRAINT "reconciliation_discrepancies_reconciliationId_fkey" FOREIGN KEY ("reconciliationId") REFERENCES "reconciliation_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mission_idempotency_keys" ADD CONSTRAINT "mission_idempotency_keys_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "relay_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_workflow_checkpoints" ADD CONSTRAINT "relay_workflow_checkpoints_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "relay_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_workflow_events" ADD CONSTRAINT "relay_workflow_events_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "relay_workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
