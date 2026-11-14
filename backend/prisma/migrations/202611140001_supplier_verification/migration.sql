
CREATE TYPE "SupplierVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED', 'SUSPENDED');
CREATE TYPE "SupplierEvidenceType" AS ENUM ('BUSINESS_REGISTRATION', 'TAX_REGISTRATION', 'CONTACT_OWNERSHIP', 'ADDRESS_VERIFICATION', 'BANK_ACCOUNT_OWNERSHIP', 'PRODUCT_CATALOG', 'SUPPLIER_QUOTE', 'MANUAL_REVIEW');
CREATE TYPE "EvidenceVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

ALTER TABLE "suppliers"
  ADD COLUMN "verificationStatus" "SupplierVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "verificationNotes" TEXT;

CREATE TABLE "supplier_discovery_leads" (
  "id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceExternalId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "formattedAddress" TEXT NOT NULL,
  "street" TEXT,
  "city" TEXT,
  "state" TEXT,
  "postalCode" TEXT,
  "country" TEXT,
  "latitude" DECIMAL(9,6),
  "longitude" DECIMAL(9,6),
  "phone" TEXT,
  "email" TEXT,
  "website" TEXT,
  "categories" JSONB,
  "firstDiscoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastDiscoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawEvidence" JSONB,
  "supplierId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_discovery_leads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "supplier_verification_evidence" (
  "id" TEXT NOT NULL,
  "supplierId" TEXT,
  "discoveryLeadId" TEXT,
  "evidenceType" "SupplierEvidenceType" NOT NULL,
  "status" "EvidenceVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "source" TEXT NOT NULL,
  "sourceReference" TEXT,
  "contentHash" TEXT,
  "notes" TEXT,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "supplier_verification_evidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_discovery_leads_source_sourceExternalId_key" ON "supplier_discovery_leads"("source", "sourceExternalId");
CREATE UNIQUE INDEX "supplier_discovery_leads_supplierId_key" ON "supplier_discovery_leads"("supplierId");
CREATE INDEX "supplier_discovery_leads_city_state_idx" ON "supplier_discovery_leads"("city", "state");
CREATE INDEX "supplier_discovery_leads_lastDiscoveredAt_idx" ON "supplier_discovery_leads"("lastDiscoveredAt");
CREATE INDEX "supplier_verification_evidence_supplierId_status_idx" ON "supplier_verification_evidence"("supplierId", "status");
CREATE INDEX "supplier_verification_evidence_discoveryLeadId_status_idx" ON "supplier_verification_evidence"("discoveryLeadId", "status");
CREATE INDEX "supplier_verification_evidence_evidenceType_status_idx" ON "supplier_verification_evidence"("evidenceType", "status");
CREATE INDEX "suppliers_verificationStatus_idx" ON "suppliers"("verificationStatus");

ALTER TABLE "supplier_discovery_leads"
  ADD CONSTRAINT "supplier_discovery_leads_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "supplier_verification_evidence"
  ADD CONSTRAINT "supplier_verification_evidence_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "supplier_verification_evidence"
  ADD CONSTRAINT "supplier_verification_evidence_discoveryLeadId_fkey"
  FOREIGN KEY ("discoveryLeadId") REFERENCES "supplier_discovery_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A verified delivery capability is evidence, not a request-time override.
ALTER TYPE "SupplierEvidenceType" ADD VALUE IF NOT EXISTS 'DELIVERY_CAPABILITY';
ALTER TABLE "supplier_verification_evidence"
  ADD COLUMN "verifiedDeliveryHours" INTEGER;

-- Each evidence item must belong to exactly one supplier or discovery lead.
ALTER TABLE "supplier_verification_evidence"
  ADD CONSTRAINT "supplier_verification_evidence_exactly_one_owner_check"
  CHECK (("supplierId" IS NOT NULL)::integer + ("discoveryLeadId" IS NOT NULL)::integer = 1);

-- Keep source provenance immutable while allowing review status/notes to evolve.
CREATE OR REPLACE FUNCTION relay_guard_supplier_evidence_provenance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
    OR NEW."discoveryLeadId" IS DISTINCT FROM OLD."discoveryLeadId"
    OR NEW."evidenceType" IS DISTINCT FROM OLD."evidenceType"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."sourceReference" IS DISTINCT FROM OLD."sourceReference"
    OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
    OR NEW."observedAt" IS DISTINCT FROM OLD."observedAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION 'Supplier evidence provenance fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "supplier_verification_evidence_provenance_immutable"
BEFORE UPDATE ON "supplier_verification_evidence"
FOR EACH ROW EXECUTE FUNCTION relay_guard_supplier_evidence_provenance();

CREATE TABLE "supplier_discovery_observations" (
  "id" TEXT NOT NULL,
  "discoveryLeadId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceExternalId" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "normalizedSnapshot" JSONB NOT NULL,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "supplier_discovery_observations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "supplier_discovery_observations_discoveryLeadId_observedAt_idx"
  ON "supplier_discovery_observations"("discoveryLeadId", "observedAt");
ALTER TABLE "supplier_discovery_observations"
  ADD CONSTRAINT "supplier_discovery_observations_discoveryLeadId_fkey"
  FOREIGN KEY ("discoveryLeadId") REFERENCES "supplier_discovery_leads"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
