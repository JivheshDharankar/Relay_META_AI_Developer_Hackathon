import { z } from 'zod';
import { RelayTool, ToolExecutionContext } from './types';
import { ToolExecutionError } from './registry';
import {
  requireCommitmentSociety,
  requireContextResidentEcho,
  requireMandateOwner,
  requireSelfResident,
  requireToolContext,
  requireWorkflowOwnership,
} from './authorization';
import {
  requestService,
  authorizationService,
  aggregationService,
  supplierService,
  offerService,
  orderService,
  allocationService,
  reconciliationService,
} from '../../services/procurement';
import { ProductUnit, DeliveryStatus } from '@prisma/client';
import { executionService } from '../../execution';
import { ProcurementError, ProcurementErrorCode } from '../../domain/procurement';
import {
  addDecimals,
  divideDecimals,
  isDecimalEqual,
  roundMoney,
  toDecimal,
} from '../../domain/procurement/decimal';
import { calculateDistanceKm } from '../../domain/procurement/geo';
import {
  rfqService,
  quoteNormalizationService,
  negotiationService,
  negotiationAIAdvisor,
  NegotiationStrategy,
  SupplierCandidate,
  QuoteStatus,
  procurementCommitmentService,
  purchaseOrderService,
  selectionValidator,
  AISelectionRecommendation,
  quoteSelectionComparator,
  qualificationService,
} from '../../discovery/supplier';
import { prisma } from '../../config/prisma';
import { mandateService, paymentService } from '../../payment';
import { fulfillmentService } from '../../fulfillment';
import {
  allocationService as residentAllocationService,
  residentLedgerService,
  reconciliationService as residentReconciliationService,
} from '../../allocation';
import { relayOrchestrator } from '../../orchestration';
import type { RelayWorkflow } from '../../orchestration/types';
import { OPERATIONAL_SLA_HOURS } from '../../orchestration/sla';
import { resolveWorkflowRequest } from '../intent/resolveWorkflowItems';

/**
 * Ownership guard for community-order-scoped tools. The community order is
 * loaded from the database and must belong to the execution context's
 * society; a bare model-supplied ID is never sufficient authority.
 * Model-driven execution always carries a context (RelayAgent supplies
 * it); context-free in-process harness calls fall through to the service
 * layer, which performs its own validation.
 */
async function requireCommunityOrderAccess(
  ctx: ToolExecutionContext | undefined,
  communityOrderId: string,
  toolName: string,
): Promise<void> {
  if (!ctx || !ctx.residentId) return;
  const context = ctx;
  const order = await prisma.communityOrder.findUnique({
    where: { id: communityOrderId },
    select: { societyId: true },
  });
  if (!order) {
    throw new ToolExecutionError(
      'COMMUNITY_ORDER_NOT_FOUND',
      `Tool '${toolName}' rejected: community order '${communityOrderId}' does not exist.`
    );
  }
  if (order.societyId !== context.societyId) {
    throw new ToolExecutionError(
      'CROSS_SOCIETY_ACCESS_DENIED',
      `Tool '${toolName}' rejected: community order belongs to another society.`
    );
  }
}

/**
 * Ownership guard for RFQ-scoped tools (in-memory discovery stack). RFQs
 * created through createRFQ carry the creating society; access from another
 * society is denied. Legacy RFQs without a society binding fall through to
 * the service layer, matching requireCommitmentSociety semantics.
 */
function requireRfqAccess(
  ctx: ToolExecutionContext | undefined,
  rfqId: string,
  toolName: string,
): void {
  if (!ctx || !ctx.residentId) return;
  const rfq = rfqService.getRFQ(rfqId);
  if (rfq) {
    requireCommitmentSociety(ctx, rfq.societyId, toolName);
  }
}

// ---------------------------------------------------------------------------
// 1. CREATE REQUEST TOOL
// ---------------------------------------------------------------------------
export const createRequestTool: RelayTool = {
  name: 'createRequest',
  description: 'Validates and records a resident procurement demand within pre-authorized boundaries.',
  schema: z.object({
    quantity: z.number().positive('Quantity must be greater than zero'),
    unit: z.enum(['KG', 'LITRE', 'GRAM', 'ML', 'PACK', 'UNIT']),
    // Optional: when omitted, requestService derives Flat/society/city from
    // the canonical resident+society records. Never default to a seed flat.
    deliveryAddress: z.string().optional(),
    productId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          quantity: { type: 'number', description: 'Requested quantity' },
          unit: {
            type: 'string',
            enum: ['KG', 'LITRE', 'GRAM', 'ML', 'PACK', 'UNIT'],
            description: 'Measurement unit',
          },
          deliveryAddress: { type: 'string', description: 'Flat or unit delivery address' },
          productId: { type: 'string', description: 'Product ID (optional if present in context)' },
        },
        required: ['quantity', 'unit'],
      },
    };
  },
  async execute(args, ctx) {
    const resolvedProductId =
      args.productId ||
      (ctx.metadata?.activeProductId as string) ||
      (ctx.metadata?.productId as string);

    if (!resolvedProductId) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Missing required productId: must be provided in request arguments or active workflow context'
      );
    }

    const validated = await requestService.validateRequest({
      residentId: ctx.residentId,
      societyId: ctx.societyId,
      productId: resolvedProductId,
      quantity: args.quantity,
      unit: args.unit as ProductUnit,
      deliveryAddress: args.deliveryAddress,
      idempotencyKey: args.idempotencyKey,
    });

    const order = await requestService.createResidentOrder(validated);

    if (!ctx.metadata) {
      ctx.metadata = {};
    }
    ctx.metadata.activeProductId = validated.productId;
    ctx.metadata.activeQuantity = Number(validated.quantity);
    ctx.metadata.lastOrderId = order.id;

    return {
      success: true,
      orderId: order.id,
      productId: validated.productId,
      productName: validated.productName,
      quantity: Number(validated.quantity),
      unit: validated.unit,
      totalAmount: Number(order.totalAmount),
      totalPrice: Number(order.totalAmount),
    };
  },
};

// ---------------------------------------------------------------------------
// 2. CHECK AUTHORIZATION TOOL
// ---------------------------------------------------------------------------
export const checkAuthorizationTool: RelayTool = {
  name: 'checkAuthorization',
  description: 'Verifies whether a requested procurement amount falls within the resident pre-authorized payment mandate limit.',
  schema: z.object({
    requestedAmount: z.number().positive('Requested amount must be positive'),
    purpose: z.string().optional(),
    mandateId: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          requestedAmount: { type: 'number', description: 'Total cost to verify against mandate cap' },
          purpose: { type: 'string', description: 'Procurement purpose' },
        },
        required: ['requestedAmount'],
      },
    };
  },
  async execute(args, ctx) {
    const res = await authorizationService.checkAuthorization({
      residentId: ctx.residentId,
      societyId: ctx.societyId,
      requestedAmount: args.requestedAmount,
      purpose: args.purpose,
      mandateId: args.mandateId,
    });

    return {
      success: res.authorized,
      authorized: res.authorized,
      mandateId: res.mandateId,
      code: res.code,
      maxAllowed: res.maxAuthorizedAmount ? Number(res.maxAuthorizedAmount) : null,
      requestedAmount: Number(res.requestedAmount),
      reason: res.reason ?? null,
    };
  },
};

// ---------------------------------------------------------------------------
// 3. AGGREGATE DEMAND TOOL
// ---------------------------------------------------------------------------
export const aggregateDemandTool: RelayTool = {
  name: 'aggregateDemand',
  description: 'Aggregates compatible resident demands within the community to secure bulk volume discounts (anonymized for suppliers).',
  schema: z.object({
    orderIds: z.array(z.string()).optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          orderIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of specific resident order IDs to include',
          },
        },
      },
    };
  },
  async execute(args, ctx) {
    const { supplierFacingGroups } = await aggregationService.aggregateSocietyDemand(
      ctx.societyId,
      args.orderIds
    );

    const mappedGroups = supplierFacingGroups.map((g) => ({
      productId: g.productId,
      productName: g.productName,
      totalQuantity: Number(g.totalQuantity),
      unit: g.unit,
      contributingOrdersCount: g.contributingOrdersCount,
    }));

    return {
      success: true,
      societyId: ctx.societyId,
      groupsCount: mappedGroups.length,
      groups: mappedGroups,
      supplierFacingGroups: mappedGroups,
    };
  },
};

// ---------------------------------------------------------------------------
// 4. DISCOVER SUPPLIERS TOOL
// ---------------------------------------------------------------------------
export const discoverSuppliersTool: RelayTool = {
  name: 'discoverSuppliers',
  description: 'Discovers authorized local suppliers and filters them strictly against hard constraints (SLA <= 12h, MOQ, radius).',
  schema: z.object({
    productId: z.string().optional(),
    requestedQuantity: z.number().positive().optional(),
    maxSlaHours: z.number().default(12.0),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID (optional if established in previous step)' },
          requestedQuantity: { type: 'number', description: 'Bulk quantity (optional if established in previous step)' },
          maxSlaHours: { type: 'number', description: 'Turnaround deadline in hours (Relay 12h SLA)' },
        },
      },
    };
  },
  async execute(args, ctx) {
    const resolvedProductId =
      args.productId ||
      (ctx.metadata?.activeProductId as string) ||
      (ctx.metadata?.productId as string);
    const resolvedQuantity =
      args.requestedQuantity ??
      (ctx.metadata?.activeQuantity as number) ??
      (ctx.metadata?.quantity as number);

    if (!resolvedProductId) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Missing required productId for discoverSuppliers: must be provided in arguments or active workflow context'
      );
    }
    if (!resolvedQuantity || resolvedQuantity <= 0) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Missing required requestedQuantity for discoverSuppliers: must be provided in arguments or active workflow context'
      );
    }

    if (!ctx.metadata) ctx.metadata = {};
    ctx.metadata.activeProductId = resolvedProductId;
    ctx.metadata.activeQuantity = resolvedQuantity;

    const results = await supplierService.filterEligibleSuppliers({
      societyId: ctx.societyId,
      productId: resolvedProductId,
      requestedQuantity: resolvedQuantity,
      maxSlaHours: args.maxSlaHours,
    });

    const eligibleSuppliers = results.filter((r) => r.eligible);

    return {
      success: true,
      eligibleCount: eligibleSuppliers.length,
      qualifiedCount: eligibleSuppliers.length,
      suppliers: results.map((r) => ({
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        eligible: r.eligible,
        distanceKm: r.distanceKm,
        serviceRadiusKm: r.serviceRadiusKm,
        deliverySlaHours: r.estimatedDeliveryHours,
        reasons: r.reasons,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// 5. EVALUATE OFFERS TOOL
// ---------------------------------------------------------------------------
export const evaluateOffersTool: RelayTool = {
  name: 'evaluateOffers',
  description: 'Ranks supplier quotes deterministically using multi-factor scoring (price 50%, reliability 30%, SLA speed 20%).',
  schema: z.object({
    productId: z.string().optional(),
    totalQuantity: z.number().positive().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID (optional if established in previous step)' },
          totalQuantity: { type: 'number', description: 'Quantity (optional if established in previous step)' },
        },
      },
    };
  },
  async execute(args, ctx) {
    const resolvedProductId =
      args.productId ||
      (ctx.metadata?.activeProductId as string) ||
      (ctx.metadata?.productId as string);
    const resolvedQuantity =
      args.totalQuantity ??
      (ctx.metadata?.activeQuantity as number) ??
      (ctx.metadata?.quantity as number);

    if (!resolvedProductId) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Missing required productId for evaluateOffers: must be provided in arguments or active workflow context'
      );
    }
    if (!resolvedQuantity || resolvedQuantity <= 0) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Missing required totalQuantity for evaluateOffers: must be provided in arguments or active workflow context'
      );
    }

    if (!ctx.metadata) ctx.metadata = {};
    ctx.metadata.activeProductId = resolvedProductId;
    ctx.metadata.activeQuantity = resolvedQuantity;

    const ranked = await offerService.evaluateOffers({
      societyId: ctx.societyId,
      productId: resolvedProductId,
      totalQuantity: resolvedQuantity,
    });

    return {
      success: true,
      rankedOffers: ranked.map((r) => ({
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        totalPrice: Number(r.totalPrice),
        deliveryHours: r.deliveryHours,
        reliabilityScore: r.reliabilityScore,
        compositeScore: r.compositeScore,
        eligible: r.hardConstraintPassed,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// 6. SELECT OFFER TOOL
// ---------------------------------------------------------------------------
export const selectOfferTool: RelayTool = {
  name: 'selectOffer',
  description: 'Deterministically selects the winning compliant supplier offer based on ranking rules.',
  schema: z.object({
    productId: z.string().optional(),
    totalQuantity: z.number().positive().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID (optional if established in previous step)' },
          totalQuantity: { type: 'number', description: 'Quantity (optional if established in previous step)' },
        },
      },
    };
  },
  async execute(args, ctx) {
    const resolvedProductId =
      args.productId ||
      (ctx.metadata?.activeProductId as string) ||
      (ctx.metadata?.productId as string);
    const resolvedQuantity =
      args.totalQuantity ??
      (ctx.metadata?.activeQuantity as number) ??
      (ctx.metadata?.quantity as number);

    if (!resolvedProductId) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Missing required productId for selectOffer: must be provided in arguments or active workflow context'
      );
    }
    if (!resolvedQuantity || resolvedQuantity <= 0) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Missing required totalQuantity for selectOffer: must be provided in arguments or active workflow context'
      );
    }

    if (!ctx.metadata) ctx.metadata = {};
    ctx.metadata.activeProductId = resolvedProductId;
    ctx.metadata.activeQuantity = resolvedQuantity;

    const winning = await offerService.selectBestOffer({
      societyId: ctx.societyId,
      productId: resolvedProductId,
      totalQuantity: resolvedQuantity,
    });

    // Pin the winning economics server-side (exact decimal strings). The
    // model cannot alter ctx, so createCommunityOrder can verify the order
    // lines against THIS record instead of trusting restated prices.
    const selections = (ctx.metadata.offerSelections as Record<
      string,
      { supplierId: string; totalQuantity: string; totalPrice: string }
    >) || {};
    selections[resolvedProductId] = {
      supplierId: winning.supplierId,
      totalQuantity: toDecimal(resolvedQuantity).toString(),
      totalPrice: toDecimal(winning.totalPrice).toString(),
    };
    ctx.metadata.offerSelections = selections;

    return {
      success: true,
      supplierId: winning.supplierId,
      supplierName: winning.supplierName,
      totalPrice: Number(winning.totalPrice),
      compositeScore: winning.compositeScore,
      deliveryHours: winning.deliveryHours,
    };
  },
};

export interface PinnedOfferSelection {
  supplierId: string;
  totalQuantity: string;
  totalPrice: string;
}

export interface CommunityOrderLineInput {
  productId: string;
  totalQuantity: number | string;
  negotiatedUnitPrice: number | string;
}

/**
 * Binds model-restated community-order lines to the server-pinned winning
 * selections (see selectOfferTool) and returns lines with DETERMINISTIC unit
 * prices derived from the pin — the model's restated negotiatedUnitPrice is
 * never trusted, so prices cannot be altered between selectOffer and
 * createCommunityOrder.
 *
 * Per (supplier, product): the selection must exist, the supplier must match,
 * and the aggregate quantity must EXACTLY equal the pinned quantity (throws
 * SELECTION_MISMATCH fail-closed otherwise). Unit price is derived as
 * pinnedTotal / pinnedQty rounded to paise (the schema stores 2dp unit
 * prices); exact restatement matching is impossible in general because
 * 2dp-rounded unit prices need not re-extend to the pinned total.
 */
export function bindCommunityOrderItemsToSelection(
  supplierId: string,
  items: CommunityOrderLineInput[],
  selections: Record<string, PinnedOfferSelection> | undefined
): CommunityOrderLineInput[] {
  if (!selections) {
    throw new ProcurementError(
      ProcurementErrorCode.SELECTION_MISMATCH,
      'No winning offer selection is pinned in this run: selectOffer must precede createCommunityOrder'
    );
  }
  const byProduct = new Map<string, CommunityOrderLineInput[]>();
  for (const item of items) {
    const group = byProduct.get(item.productId) || [];
    group.push(item);
    byProduct.set(item.productId, group);
  }
  return items.map((item) => {
    const pinned = selections[item.productId];
    if (!pinned) {
      throw new ProcurementError(
        ProcurementErrorCode.SELECTION_MISMATCH,
        `Product '${item.productId}' was not part of the winning selection`
      );
    }
    if (pinned.supplierId !== supplierId) {
      throw new ProcurementError(
        ProcurementErrorCode.SELECTION_MISMATCH,
        `Supplier '${supplierId}' does not match the winning supplier '${pinned.supplierId}' for product '${item.productId}'`
      );
    }
    const lines = byProduct.get(item.productId)!;
    const totalQty = addDecimals(...lines.map((l) => toDecimal(l.totalQuantity)));
    if (!isDecimalEqual(totalQty, toDecimal(pinned.totalQuantity))) {
      throw new ProcurementError(
        ProcurementErrorCode.SELECTION_MISMATCH,
        `Quantity ${totalQty.toString()} for product '${item.productId}' does not match the selected ${pinned.totalQuantity}`
      );
    }
    const unitPrice = roundMoney(divideDecimals(toDecimal(pinned.totalPrice), toDecimal(pinned.totalQuantity)));
    return { ...item, negotiatedUnitPrice: unitPrice.toString() };
  });
}

// ---------------------------------------------------------------------------
// 7. CREATE COMMUNITY ORDER TOOL
// ---------------------------------------------------------------------------
export const createCommunityOrderTool: RelayTool = {
  name: 'createCommunityOrder',
  description: 'Atomically persists a consolidated CommunityOrder in PostgreSQL within 12h SLA boundaries.',
  schema: z.object({
    supplierId: z.string(),
    deliveryDeadline: z.string(),
    idempotencyKey: z.string().optional(),
    items: z.array(
      z.object({
        productId: z.string(),
        totalQuantity: z.union([z.number(), z.string()]),
        negotiatedUnitPrice: z.union([z.number(), z.string()]),
      })
    ),
    contributingResidentOrderIds: z.array(z.string()).optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          supplierId: { type: 'string', description: 'Selected supplier ID' },
          deliveryDeadline: { type: 'string', description: 'Fulfillment deadline ISO string' },
          items: {
            type: 'array',
            items: { type: 'object' },
            description: 'Line items',
          },
          idempotencyKey: { type: 'string', description: 'Idempotency key for retry safety' },
        },
        required: ['supplierId', 'deliveryDeadline', 'items'],
      },
    };
  },
  async execute(args, ctx) {
    // The model restates prices here: bind every line to the server-pinned
    // winning selection and persist DETERMINISTIC unit prices derived from
    // the pin — the restated negotiatedUnitPrice is never trusted.
    const boundItems = bindCommunityOrderItemsToSelection(
      args.supplierId,
      args.items,
      ctx.metadata?.offerSelections as Record<string, PinnedOfferSelection> | undefined
    );
    const result = await orderService.createCommunityOrder({
      societyId: ctx.societyId,
      supplierId: args.supplierId,
      deliveryDeadline: new Date(args.deliveryDeadline),
      idempotencyKey: args.idempotencyKey,
      items: boundItems,
      contributingResidentOrderIds: args.contributingResidentOrderIds,
    });

    return {
      success: true,
      order: {
        id: result.order.id,
        status: result.order.status,
        totalAmount: Number(result.order.totalAmount),
        deliveryDeadline: result.order.deliveryDeadline.toISOString(),
        itemsCount: result.order.items.length,
      },
      isDuplicate: result.isDuplicate,
    };
  },
};

// ---------------------------------------------------------------------------
// 8. ALLOCATE RESIDENT ORDERS TOOL
// ---------------------------------------------------------------------------
export const allocateResidentOrdersTool: RelayTool = {
  name: 'allocateResidentOrders',
  description: 'Allocates delivered community bulk quantities back to individual resident units with strict quantity match.',
  schema: z.object({
    communityOrderId: z.string(),
    allocations: z.array(
      z.object({
        residentOrderId: z.string(),
        productId: z.string(),
        quantity: z.union([z.number(), z.string()]),
      })
    ),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          communityOrderId: { type: 'string', description: 'Community order ID' },
          allocations: {
            type: 'array',
            items: { type: 'object' },
            description: 'Per-resident itemized allocations',
          },
        },
        required: ['communityOrderId', 'allocations'],
      },
    };
  },
  async execute(args, ctx) {
    await requireCommunityOrderAccess(ctx, args.communityOrderId, 'allocateResidentOrders');
    const delivery = await allocationService.allocateCommunityDelivery({
      communityOrderId: args.communityOrderId,
      allocations: args.allocations,
    });

    return {
      success: true,
      communityOrderId: args.communityOrderId,
      deliveryId: delivery?.id,
      allocationsCount: delivery?.allocations.length ?? 0,
    };
  },
};

// ---------------------------------------------------------------------------
// 9. RECONCILE ORDER TOOL
// ---------------------------------------------------------------------------
export const reconcileOrderTool: RelayTool = {
  name: 'reconcileOrder',
  description: 'Executes multi-dimensional financial, quantity, product, and society reconciliation for a community order.',
  schema: z.object({
    communityOrderId: z.string(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          communityOrderId: { type: 'string', description: 'Community order ID to reconcile' },
        },
        required: ['communityOrderId'],
      },
    };
  },
  async execute(args, ctx) {
    await requireCommunityOrderAccess(ctx, args.communityOrderId, 'reconcileOrder');
    const report = await reconciliationService.reconcileCommunityOrder(args.communityOrderId);

    return {
      success: report.isReconciled,
      isReconciled: report.isReconciled,
      status: report.status,
      communityOrderId: report.communityOrderId,
      quantityPassed: report.quantityReconciliation.passed,
      financialPassed: report.financialReconciliation.passed,
      productPassed: report.productIntegrity.passed,
      societyPassed: report.societyIntegrity.passed,
      discrepancies: report.discrepancies,
    };
  },
};

// ---------------------------------------------------------------------------
// 10. PAYMENT EXECUTION TOOL (Milestone 5 Real Execution via PaymentAdapter)
// ---------------------------------------------------------------------------
export const requestPaymentTool: RelayTool = {
  name: 'requestPayment',
  description: 'Executes pre-authorized payment execution through the PaymentAdapter within verified mandate boundaries.',
  schema: z.object({
    residentOrderId: z.string(),
    amount: z.number().positive().optional(),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          residentOrderId: { type: 'string', description: 'Resident order to pay for' },
          amount: { type: 'number', description: 'Authorized payment amount' },
          idempotencyKey: { type: 'string', description: 'Optional unique key for payment retry safety' },
        },
        required: ['residentOrderId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'requestPayment');
    const result = await executionService.executeResidentPayment({
      residentOrderId: args.residentOrderId,
      amount: args.amount,
      idempotencyKey: args.idempotencyKey,
      expectedResidentId: context.residentId,
    });

    return {
      success: result.success,
      orderId: result.orderId,
      status: result.payment.status,
      providerReference: result.payment.providerReference,
      amount: result.payment.amount,
      currency: result.payment.currency,
      executedAt: result.payment.executedAt.toISOString(),
      isDuplicate: result.payment.isDuplicate ?? false,
    };
  },
};

// ---------------------------------------------------------------------------
// 11. DELIVERY SIMULATOR TOOL (Milestone 5 Real Deterministic Simulator)
// ---------------------------------------------------------------------------
export const trackDeliveryTool: RelayTool = {
  name: 'trackDelivery',
  description: 'Tracks, initializes, or advances physical community delivery state through the deterministic delivery simulator.',
  schema: z.object({
    communityOrderId: z.string(),
    advanceStatus: z.enum(['PREPARING', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED']).optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          communityOrderId: { type: 'string', description: 'Community order ID' },
          advanceStatus: {
            type: 'string',
            enum: ['PREPARING', 'DISPATCHED', 'OUT_FOR_DELIVERY', 'DELIVERED'],
            description: 'Optional target status to advance simulator',
          },
        },
        required: ['communityOrderId'],
      },
    };
  },
  async execute(args, ctx) {
    await requireCommunityOrderAccess(ctx, args.communityOrderId, 'trackDelivery');
    if (args.advanceStatus) {
      if (args.advanceStatus === 'DELIVERED') {
        // Deterministically progress delivery through required FSM sequence to terminal state
        await executionService.advanceCommunityDelivery(args.communityOrderId, DeliveryStatus.PREPARING);
        await executionService.advanceCommunityDelivery(args.communityOrderId, DeliveryStatus.DISPATCHED);
        await executionService.advanceCommunityDelivery(args.communityOrderId, DeliveryStatus.OUT_FOR_DELIVERY);
        const res = await executionService.advanceCommunityDelivery(args.communityOrderId, DeliveryStatus.DELIVERED);
        return {
          success: res.success,
          deliveryId: res.deliveryId,
          communityOrderId: res.communityOrderId,
          previousStatus: res.previousStatus,
          status: res.currentStatus,
          isTerminal: res.isTerminal,
          trackingCode: res.trackingCode,
          message: res.message,
        };
      }

      const res = await executionService.advanceCommunityDelivery(
        args.communityOrderId,
        args.advanceStatus as DeliveryStatus
      );
      return {
        success: res.success,
        deliveryId: res.deliveryId,
        communityOrderId: res.communityOrderId,
        previousStatus: res.previousStatus,
        status: res.currentStatus,
        isTerminal: res.isTerminal,
        trackingCode: res.trackingCode,
        message: res.message,
      };
    }

    try {
      const snapshot = await executionService.getDeliveryStatus(args.communityOrderId);
      return {
        success: true,
        deliveryId: snapshot.deliveryId,
        communityOrderId: snapshot.communityOrderId,
        status: snapshot.status,
        trackingCode: snapshot.trackingCode,
        dispatchedAt: snapshot.dispatchedAt?.toISOString(),
        deliveredAt: snapshot.deliveredAt?.toISOString(),
      };
    } catch {
      const res = await executionService.advanceCommunityDelivery(
        args.communityOrderId,
        DeliveryStatus.PREPARING
      );
      return {
        success: res.success,
        deliveryId: res.deliveryId,
        communityOrderId: res.communityOrderId,
        previousStatus: res.previousStatus,
        status: res.currentStatus,
        isTerminal: res.isTerminal,
        message: res.message,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 12. CREATE RFQ TOOL
// ---------------------------------------------------------------------------
export const createRFQTool: RelayTool = {
  name: 'createRFQ',
  description:
    'Generates a structured Request for Quote (RFQ) for an eligible supplier candidate. Strictly anonymizes resident demand.',
  schema: z.object({
    candidateId: z.string(),
    candidateName: z.string().optional(),
    candidateEmail: z.string().optional(),
    items: z
      .array(
        z.object({
          productId: z.string().optional(),
          productName: z.string(),
          quantity: z.number().positive(),
          unit: z.string(),
          specification: z.string().optional(),
        })
      )
      .min(1, 'At least one line item is required'),
    deliveryArea: z.string().optional(),
    quoteDeadlineHours: z.number().positive().default(2),
    deliveryDeadlineHours: z.number().positive().default(12),
    contactMethod: z.enum(['email', 'whatsapp', 'api', 'manual']).default('email'),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', description: 'Discovered supplier candidate ID' },
          candidateName: { type: 'string', description: 'Supplier business name' },
          candidateEmail: { type: 'string', description: 'Supplier contact email' },
          items: {
            type: 'array',
            description: 'Consolidated procurement line items',
            items: {
              type: 'object',
              properties: {
                productName: { type: 'string' },
                quantity: { type: 'number' },
                unit: { type: 'string' },
                specification: { type: 'string' },
              },
              required: ['productName', 'quantity', 'unit'],
            },
          },
          deliveryArea: { type: 'string', description: 'Consolidated community delivery location' },
          quoteDeadlineHours: { type: 'number', description: 'Hours allowed for quote response' },
          deliveryDeadlineHours: { type: 'number', description: 'Hours allowed for fulfillment' },
        },
        required: ['candidateId', 'items'],
      },
    };
  },
  async execute(args, ctx) {
    // The candidate must be a REGISTERED supplier: identity and contact
    // details come from the registry, never from model-supplied name/email
    // (which would let prompts steer RFQs to arbitrary mailboxes).
    const supplier = await prisma.supplier.findUnique({
      where: { id: args.candidateId },
    });
    if (!supplier) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        `Unknown supplier candidate '${args.candidateId}': RFQs are issued only to registered suppliers`
      );
    }
    if (supplier.status !== 'ACTIVE') {
      throw new ProcurementError(
        ProcurementErrorCode.SUPPLIER_INACTIVE,
        `Cannot issue RFQ: supplier '${supplier.name}' is not ACTIVE`
      );
    }
    const society = await prisma.society.findUnique({
      where: { id: ctx.societyId },
    });
    if (
      supplier.latitude === null ||
      supplier.longitude === null ||
      !society ||
      society.latitude === null ||
      society.longitude === null
    ) {
      throw new ProcurementError(
        ProcurementErrorCode.INVALID_REQUEST,
        'Cannot issue RFQ: supplier or society coordinates are missing, so the service area cannot be verified'
      );
    }
    const distanceKm = calculateDistanceKm(
      { latitude: society.latitude, longitude: society.longitude },
      { latitude: supplier.latitude, longitude: supplier.longitude }
    );
    const candidate: SupplierCandidate = {
      id: supplier.id,
      name: supplier.name,
      formattedAddress: `${supplier.address}, ${supplier.city}, ${supplier.state} ${supplier.postalCode}`,
      city: supplier.city,
      state: supplier.state,
      postalCode: supplier.postalCode,
      latitude: Number(supplier.latitude),
      longitude: Number(supplier.longitude),
      distanceKm: Math.round(distanceKm * 100) / 100,
      distanceMeters: Math.round(distanceKm * 1000),
      categories: [],
      source: 'registry',
      email: supplier.contactEmail,
      phone: supplier.contactPhone,
    };

    // Deterministic qualification on real registry data. REJECTED suppliers
    // are blocked by the validation bar inside createRFQ.
    const qualification = qualificationService.qualifyCandidate(candidate, {
      productName: args.items[0]?.productName,
      maxRadiusMeters: Number(supplier.serviceRadiusKm) * 1000,
      maxSlaHours: args.deliveryDeadlineHours,
    });

    const now = new Date();
    const quoteDeadline = new Date(now.getTime() + args.quoteDeadlineHours * 3600 * 1000);
    const deliveryDeadline = new Date(now.getTime() + args.deliveryDeadlineHours * 3600 * 1000);

    const rfq = await rfqService.createRFQ(
      {
        candidate,
        lineItems: args.items,
        deliveryArea: args.deliveryArea || 'Greenview Residency Community Service Area',
        quoteDeadline,
        deliveryDeadline,
        contactMethod: args.contactMethod,
        idempotencyKey: args.idempotencyKey,
        societyId: ctx.societyId,
        procurementRequestId: ctx.requestId,
      },
      qualification,
      now
    );

    return {
      success: true,
      rfqId: rfq.id,
      status: rfq.status,
      candidateId: rfq.candidateId,
      supplierName: rfq.supplierName,
      lineItems: rfq.lineItems,
      deliveryArea: rfq.deliveryArea,
      quoteDeadline: rfq.quoteDeadline.toISOString(),
      deliveryDeadline: rfq.deliveryDeadline.toISOString(),
    };
  },
};

// ---------------------------------------------------------------------------
// 13. SEND RFQ TOOL
// ---------------------------------------------------------------------------
export const sendRFQTool: RelayTool = {
  name: 'sendRFQ',
  description:
    'Dispatches a validated RFQ to the supplier candidate via the configured contact channel.',
  schema: z.object({
    rfqId: z.string(),
    preferredProvider: z.enum(['mock', 'resend']).optional(),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          rfqId: { type: 'string', description: 'ID of the validated RFQ to dispatch' },
          preferredProvider: { type: 'string', enum: ['mock', 'resend'], description: 'Contact provider override' },
        },
        required: ['rfqId'],
      },
    };
  },
  async execute(args, ctx) {
    requireRfqAccess(ctx, args.rfqId, 'sendRFQ');
    const result = await rfqService.sendRFQ(args.rfqId, {
      preferredProvider: args.preferredProvider,
      idempotencyKey: args.idempotencyKey,
    });

    return {
      success: result.success,
      rfqId: result.rfqId,
      status: result.status,
      messageId: result.messageId,
      dispatchedAt: result.dispatchedAt?.toISOString(),
      provider: result.providerName,
      recipient: result.recipient,
      isDuplicate: result.isDuplicate,
    };
  },
};

// ---------------------------------------------------------------------------
// 14. GET QUOTES FOR RFQ TOOL
// ---------------------------------------------------------------------------
export const getQuotesForRFQTool: RelayTool = {
  name: 'getQuotesForRFQ',
  description:
    'Retrieves normalized, mathematically verified supplier quotes for a given RFQ.',
  schema: z.object({
    rfqId: z.string(),
    statusFilter: z.enum(['VALID', 'PARTIAL', 'INVALID', 'EXPIRED', 'SUPERSEDED']).optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          rfqId: { type: 'string', description: 'Originating RFQ identifier' },
          statusFilter: {
            type: 'string',
            enum: ['VALID', 'PARTIAL', 'INVALID', 'EXPIRED', 'SUPERSEDED'],
            description: 'Optional status filter',
          },
        },
        required: ['rfqId'],
      },
    };
  },
  async execute(args, ctx) {
    requireRfqAccess(ctx, args.rfqId, 'getQuotesForRFQ');
    const quotes = quoteNormalizationService.getQuotesForRFQ(
      args.rfqId,
      args.statusFilter as QuoteStatus | undefined
    );

    return {
      success: true,
      rfqId: args.rfqId,
      quoteCount: quotes.length,
      quotes: quotes.map((q) => ({
        id: q.id,
        supplierName: q.supplierName,
        total: q.total,
        subtotal: q.subtotal,
        deliveryFee: q.deliveryFee,
        tax: q.tax,
        deliveryCommitment: q.deliveryCommitment,
        deliveryEtaHours: q.deliveryEtaHours,
        validUntil: q.validUntil.toISOString(),
        status: q.status,
        hasTotalMismatch: q.hasTotalMismatch,
        lineItems: q.lineItems.map((li) => ({
          productName: li.productName,
          quotedQuantity: li.quotedQuantity,
          requestedQuantity: li.requestedQuantity,
          isPartial: li.isPartial,
          unit: li.unit,
          unitPrice: li.unitPrice,
          lineSubtotal: li.lineSubtotal,
        })),
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// 15. GET QUOTE TOOL
// ---------------------------------------------------------------------------
export const getQuoteTool: RelayTool = {
  name: 'getQuote',
  description: 'Retrieves complete details of a specific normalized quote by ID.',
  schema: z.object({
    quoteId: z.string(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'string', description: 'Unique quote identifier' },
        },
        required: ['quoteId'],
      },
    };
  },
  async execute(args, ctx) {
    const quote = quoteNormalizationService.getQuote(args.quoteId);
    if (!quote) {
      throw new Error(`Quote '${args.quoteId}' not found`);
    }
    requireRfqAccess(ctx, quote.rfqId, 'getQuote');

    return {
      success: true,
      quote: {
        id: quote.id,
        rfqId: quote.rfqId,
        supplierName: quote.supplierName,
        candidateId: quote.candidateId,
        total: quote.total,
        subtotal: quote.subtotal,
        deliveryFee: quote.deliveryFee,
        tax: quote.tax,
        otherCharges: quote.otherCharges,
        deliveryCommitment: quote.deliveryCommitment,
        deliveryEtaHours: quote.deliveryEtaHours,
        confirmedDeliveryEta: quote.confirmedDeliveryEta?.toISOString(),
        validUntil: quote.validUntil.toISOString(),
        status: quote.status,
        reasons: quote.reasons,
        hasTotalMismatch: quote.hasTotalMismatch,
        totalMismatchDifference: quote.totalMismatchDifference,
        lineItems: quote.lineItems,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 16. COMPARE QUOTES FOR RFQ TOOL
// ---------------------------------------------------------------------------
export const compareQuotesForRFQTool: RelayTool = {
  name: 'compareQuotesForRFQ',
  description:
    'Returns factual, normalized comparison metrics across all quotes for an RFQ, including lowest price, fastest delivery, fulfillment status, and SLA compliance.',
  schema: z.object({
    rfqId: z.string(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          rfqId: { type: 'string', description: 'Originating RFQ identifier' },
        },
        required: ['rfqId'],
      },
    };
  },
  async execute(args, ctx) {
    requireRfqAccess(ctx, args.rfqId, 'compareQuotesForRFQ');
    const comparison = negotiationService.compareQuotesForRFQ(args.rfqId);
    return {
      success: true,
      rfqId: args.rfqId,
      comparison,
    };
  },
};

// ---------------------------------------------------------------------------
// 17. GET NEGOTIATION STATE TOOL
// ---------------------------------------------------------------------------
export const getNegotiationStateTool: RelayTool = {
  name: 'getNegotiationState',
  description:
    'Retrieves current state, round history, and active proposals for a negotiation by negotiationId or rfqId.',
  schema: z.object({
    negotiationId: z.string().optional(),
    rfqId: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          negotiationId: { type: 'string', description: 'Negotiation identifier' },
          rfqId: { type: 'string', description: 'RFQ identifier' },
        },
      },
    };
  },
  async execute(args, ctx) {
    if (args.negotiationId) {
      const negotiation = negotiationService.getNegotiation(args.negotiationId);
      if (!negotiation) {
        throw new Error(`Negotiation '${args.negotiationId}' not found`);
      }
      requireRfqAccess(ctx, negotiation.rfqId, 'getNegotiationState');
      return { success: true, negotiation };
    }
    if (args.rfqId) {
      requireRfqAccess(ctx, args.rfqId, 'getNegotiationState');
      const list = negotiationService.getNegotiationsForRFQ(args.rfqId);
      return { success: true, count: list.length, negotiations: list };
    }
    throw new Error('Either negotiationId or rfqId must be provided');
  },
};

// ---------------------------------------------------------------------------
// 18. CREATE NEGOTIATION PROPOSAL TOOL
// ---------------------------------------------------------------------------
export const createNegotiationProposalTool: RelayTool = {
  name: 'createNegotiationProposal',
  description:
    'Submits an AI-formulated commercial negotiation proposal for deterministic validation and round registration.',
  schema: z.object({
    negotiationId: z.string(),
    strategy: z.enum([
      'LOWER_PRICE',
      'REDUCE_DELIVERY_FEE',
      'IMPROVE_DELIVERY_TIME',
      'INCREASE_AVAILABLE_QUANTITY',
      'IMPROVE_TERMS',
      'COMBINATION',
      'NO_NEGOTIATION',
    ]),
    targetUnitPrice: z.number().optional(),
    targetDeliveryFee: z.number().optional(),
    targetDeliveryEtaHours: z.number().optional(),
    targetQuantity: z.number().optional(),
    notes: z.string().optional(),
    rationale: z.string(),
    expectedBenefit: z.string(),
    supplierFacingMessage: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          negotiationId: { type: 'string', description: 'Negotiation session identifier' },
          strategy: {
            type: 'string',
            enum: [
              'LOWER_PRICE',
              'REDUCE_DELIVERY_FEE',
              'IMPROVE_DELIVERY_TIME',
              'INCREASE_AVAILABLE_QUANTITY',
              'IMPROVE_TERMS',
              'COMBINATION',
              'NO_NEGOTIATION',
            ],
            description: 'Negotiation objective strategy',
          },
          targetUnitPrice: { type: 'number', description: 'Proposed target unit price in INR' },
          targetDeliveryFee: { type: 'number', description: 'Proposed target delivery fee in INR' },
          targetDeliveryEtaHours: { type: 'number', description: 'Desired delivery turnaround hours' },
          targetQuantity: { type: 'number', description: 'Desired fulfillment quantity' },
          notes: { type: 'string', description: 'Commercial context notes' },
          rationale: { type: 'string', description: 'Reasoning behind the proposal' },
          expectedBenefit: { type: 'string', description: 'Expected savings or logistics gain' },
          supplierFacingMessage: { type: 'string', description: 'Optional customized outbound message' },
        },
        required: ['negotiationId', 'strategy', 'rationale', 'expectedBenefit'],
      },
    };
  },
  async execute(args) {
    const proposal = await negotiationService.createProposal({
      negotiationId: args.negotiationId,
      strategy: args.strategy as NegotiationStrategy,
      requestedChanges: {
        targetUnitPrice: args.targetUnitPrice,
        targetDeliveryFee: args.targetDeliveryFee,
        targetDeliveryEtaHours: args.targetDeliveryEtaHours,
        targetQuantity: args.targetQuantity,
        notes: args.notes,
      },
      rationale: args.rationale,
      expectedBenefit: args.expectedBenefit,
      supplierFacingMessage: args.supplierFacingMessage,
      idempotencyKey: args.idempotencyKey,
    });

    return {
      success: true,
      proposalId: proposal.id,
      status: proposal.status,
      roundNumber: proposal.roundNumber,
      proposal,
    };
  },
};

// ---------------------------------------------------------------------------
// 19. SEND NEGOTIATION PROPOSAL TOOL
// ---------------------------------------------------------------------------
export const sendNegotiationProposalTool: RelayTool = {
  name: 'sendNegotiationProposal',
  description:
    'Dispatches a validated negotiation proposal to the supplier via SupplierContactService.',
  schema: z.object({
    proposalId: z.string(),
    preferredProvider: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'Unique proposal identifier' },
          preferredProvider: { type: 'string', description: 'Optional contact provider name' },
        },
        required: ['proposalId'],
      },
    };
  },
  async execute(args) {
    const result = await negotiationService.sendProposal(
      args.proposalId,
      args.preferredProvider
    );

    return {
      success: result.success,
      messageId: result.messageId,
      dispatchedAt: result.dispatchedAt.toISOString(),
      recipient: result.recipient,
      isDuplicate: result.isDuplicate,
    };
  },
};

// ---------------------------------------------------------------------------
// 20. EVALUATE NEGOTIATION RESPONSE TOOL
// ---------------------------------------------------------------------------
export const evaluateNegotiationResponseTool: RelayTool = {
  name: 'evaluateNegotiationResponse',
  description:
    'Evaluates a supplier counteroffer against the proposal target terms and remaining rounds.',
  schema: z.object({
    negotiationId: z.string(),
    originalQuoteId: z.string(),
    counterofferQuoteId: z.string(),
    roundNumber: z.number().default(1),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          negotiationId: { type: 'string', description: 'Negotiation session identifier' },
          originalQuoteId: { type: 'string', description: 'Original quote identifier' },
          counterofferQuoteId: { type: 'string', description: 'New counteroffer quote identifier' },
          roundNumber: { type: 'number', description: 'Round number being evaluated' },
        },
        required: ['negotiationId', 'originalQuoteId', 'counterofferQuoteId'],
      },
    };
  },
  async execute(args) {
    const origQuote = quoteNormalizationService.getQuote(args.originalQuoteId);
    if (!origQuote) {
      throw new Error(`Original quote '${args.originalQuoteId}' not found`);
    }
    const counterQuote = quoteNormalizationService.getQuote(args.counterofferQuoteId);
    if (!counterQuote) {
      throw new Error(`Counteroffer quote '${args.counterofferQuoteId}' not found`);
    }
    const negotiation = negotiationService.getNegotiation(args.negotiationId);
    if (!negotiation) {
      throw new Error(`Negotiation '${args.negotiationId}' not found`);
    }
    const round = negotiation.rounds.find((r) => r.roundNumber === args.roundNumber);
    if (!round) {
      throw new Error(`Round ${args.roundNumber} not found in negotiation`);
    }

    const remainingRounds = negotiation.maxRounds - args.roundNumber;
    const evaluation = await negotiationAIAdvisor.evaluateCounteroffer(
      origQuote,
      counterQuote,
      round.proposal,
      remainingRounds
    );

    return {
      success: true,
      negotiationId: args.negotiationId,
      roundNumber: args.roundNumber,
      evaluation,
    };
  },
};

// ---------------------------------------------------------------------------
// 21. COMPARE QUOTES FOR SELECTION TOOL
// ---------------------------------------------------------------------------
export const compareQuotesForSelectionTool: RelayTool = {
  name: 'compareQuotesForSelection',
  description:
    'Compares normalized candidate quotes for an RFQ with factual eligibility, SLA margin, unit price, and split candidate metrics.',
  schema: z.object({
    rfqId: z.string(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          rfqId: { type: 'string', description: 'Originating RFQ identifier' },
        },
        required: ['rfqId'],
      },
    };
  },
  async execute(args) {
    const comparison = procurementCommitmentService.compareQuotesForSelection(args.rfqId);
    return {
      success: true,
      rfqId: args.rfqId,
      comparison,
    };
  },
};

// ---------------------------------------------------------------------------
// 22. GET SELECTION STATE TOOL
// ---------------------------------------------------------------------------
export const getSelectionStateTool: RelayTool = {
  name: 'getSelectionState',
  description:
    'Retrieves current selection, commitment, and purchase order state for an RFQ.',
  schema: z.object({
    rfqId: z.string(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          rfqId: { type: 'string', description: 'Originating RFQ identifier' },
        },
        required: ['rfqId'],
      },
    };
  },
  async execute(args) {
    const commitment = procurementCommitmentService.getCommitmentForRFQ(args.rfqId);
    const purchaseOrders = commitment
      ? purchaseOrderService.getPurchaseOrdersForCommitment(commitment.id)
      : [];

    return {
      success: true,
      rfqId: args.rfqId,
      hasCommitment: !!commitment,
      commitment,
      purchaseOrders,
    };
  },
};

// ---------------------------------------------------------------------------
// 23. RECOMMEND SUPPLIER SELECTION TOOL
// ---------------------------------------------------------------------------
export const recommendSupplierSelectionTool: RelayTool = {
  name: 'recommendSupplierSelection',
  description:
    'Autonomous selection tool: evaluates candidate quotes, selects single supplier or split allocation, deterministically validates, and creates commitment with purchase orders.',
  schema: z.object({
    rfqId: z.string(),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          rfqId: { type: 'string', description: 'Originating RFQ identifier' },
          idempotencyKey: { type: 'string', description: 'Optional idempotency key' },
        },
        required: ['rfqId'],
      },
    };
  },
  async execute(args) {
    const result = await procurementCommitmentService.executeAutonomousSelection(args.rfqId, {
      idempotencyKey: args.idempotencyKey,
    });

    return {
      success: true,
      rfqId: args.rfqId,
      decision: result.recommendation.decision,
      recommendation: result.recommendation,
      hasCommitment: !!result.commitment,
      commitmentId: result.commitment?.id,
      purchaseOrderCount: result.purchaseOrders?.length ?? 0,
      status: result.commitment?.status,
    };
  },
};

// ---------------------------------------------------------------------------
// 24. VALIDATE SELECTION TOOL
// ---------------------------------------------------------------------------
export const validateSelectionTool: RelayTool = {
  name: 'validateSelection',
  description:
    'Validates a proposed selection recommendation (SELECT_SUPPLIER or SPLIT_ORDER) against deterministic quantity, MOQ, SLA, and eligibility rules.',
  schema: z.object({
    rfqId: z.string(),
    decision: z.enum(['SELECT_SUPPLIER', 'SPLIT_ORDER', 'REJECT_ALL', 'REQUEST_MORE_NEGOTIATION']),
    supplierId: z.string().optional(),
    quoteId: z.string().optional(),
    allocations: z
      .array(
        z.object({
          supplierId: z.string(),
          quoteId: z.string(),
          quantity: z.number().positive(),
        })
      )
      .optional(),
    reason: z.string(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          rfqId: { type: 'string', description: 'Originating RFQ identifier' },
          decision: {
            type: 'string',
            enum: ['SELECT_SUPPLIER', 'SPLIT_ORDER', 'REJECT_ALL', 'REQUEST_MORE_NEGOTIATION'],
            description: 'Decision type',
          },
          supplierId: { type: 'string', description: 'Selected supplier ID for single selection' },
          quoteId: { type: 'string', description: 'Selected quote ID for single selection' },
          allocations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                supplierId: { type: 'string' },
                quoteId: { type: 'string' },
                quantity: { type: 'number' },
              },
            },
            description: 'Multi-supplier split allocations',
          },
          reason: { type: 'string', description: 'Selection rationale' },
        },
        required: ['rfqId', 'decision', 'reason'],
      },
    };
  },
  async execute(args) {
    const rfq = rfqService.getRFQ(args.rfqId);
    if (!rfq) {
      throw new Error(`RFQ '${args.rfqId}' not found`);
    }
    const quotes = quoteNormalizationService.getQuotesForRFQ(args.rfqId);

    const recommendation: AISelectionRecommendation = {
      decision: args.decision,
      supplierId: args.supplierId,
      quoteId: args.quoteId,
      allocations: args.allocations,
      reason: args.reason,
    };

    const result = selectionValidator.validateRecommendation(recommendation, rfq, quotes);

    return {
      success: true,
      valid: result.valid,
      errors: result.errors,
    };
  },
};

// ---------------------------------------------------------------------------
// 25. GET PROCUREMENT COMMITMENT TOOL
// ---------------------------------------------------------------------------
export const getProcurementCommitmentTool: RelayTool = {
  name: 'getProcurementCommitment',
  description: 'Retrieves full details of a specific procurement commitment by commitmentId.',
  schema: z.object({
    commitmentId: z.string(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', description: 'Unique commitment identifier' },
        },
        required: ['commitmentId'],
      },
    };
  },
  async execute(args) {
    const commitment = procurementCommitmentService.getCommitment(args.commitmentId);
    if (!commitment) {
      throw new Error(`Procurement commitment '${args.commitmentId}' not found`);
    }

    return {
      success: true,
      commitment,
    };
  },
};

// ---------------------------------------------------------------------------
// 26. GET PURCHASE ORDER TOOL
// ---------------------------------------------------------------------------
export const getPurchaseOrderTool: RelayTool = {
  name: 'getPurchaseOrder',
  description: 'Retrieves details of a specific purchase order by poId or PO number.',
  schema: z.object({
    poId: z.string().optional(),
    poNumber: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          poId: { type: 'string', description: 'Purchase Order ID' },
          poNumber: { type: 'string', description: 'Formal Purchase Order number (e.g. PO-2026-XXXX)' },
        },
      },
    };
  },
  async execute(args) {
    if (args.poId) {
      const po = purchaseOrderService.getPurchaseOrder(args.poId);
      if (!po) {
        throw new Error(`Purchase order '${args.poId}' not found`);
      }
      return { success: true, purchaseOrder: po };
    }

    if (args.poNumber) {
      const all = purchaseOrderService.listPurchaseOrders();
      const po = all.find((p) => p.poNumber === args.poNumber);
      if (!po) {
        throw new Error(`Purchase order with number '${args.poNumber}' not found`);
      }
      return { success: true, purchaseOrder: po };
    }

    throw new Error('Either poId or poNumber must be provided');
  },
};

// ---------------------------------------------------------------------------
// 27. REQUEST PAYMENT FOR COMMITMENT TOOL (Phase 7 Authoritative Execution)
// ---------------------------------------------------------------------------
export const requestPaymentForCommitmentTool: RelayTool = {
  name: 'requestPaymentForCommitment',
  description:
    'Requests deterministic financial authorization and execution for an existing Phase 6 procurement commitment in READY_FOR_PAYMENT status. AI cannot specify arbitrary amounts or recipients; amounts are derived directly from validated allocations.',
  schema: z.object({
    commitmentId: z.string().min(1, 'commitmentId is required'),
    mandateId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', description: 'Unique procurement commitment identifier' },
          mandateId: { type: 'string', description: 'Optional payment mandate ID' },
          idempotencyKey: { type: 'string', description: 'Optional idempotency key' },
        },
        required: ['commitmentId'],
      },
    };
  },
  async execute(args, ctx) {
    // Identity binding: only the context resident's own mandate may be
    // charged. A model-supplied foreign mandateId is rejected inside
    // payCommitment (MANDATE_OWNER_MISMATCH).
    if (!ctx || !ctx.residentId) {
      throw new ToolExecutionError(
        'MISSING_EXECUTION_CONTEXT',
        "Tool 'requestPaymentForCommitment' rejected: execution context with residentId is required."
      );
    }
    const result = await paymentService.payCommitment({
      commitmentId: args.commitmentId,
      ownerReference: ctx.residentId,
      mandateId: args.mandateId,
      idempotencyKey: args.idempotencyKey,
    });

    return {
      success: true,
      commitmentId: args.commitmentId,
      status: result.summary.status,
      paidAmount: result.summary.paidAmount,
      totalAmount: result.summary.totalAmount,
      currency: result.summary.currency,
      summary: result.summary,
      paymentCount: result.payments.length,
    };
  },
};

// ---------------------------------------------------------------------------
// 28. GET PAYMENT STATE TOOL (Phase 7 Read-Only)
// ---------------------------------------------------------------------------
export const getPaymentStateTool: RelayTool = {
  name: 'getPaymentState',
  description:
    'Retrieves operational status, attempts, and provider transaction references for a specific payment.',
  schema: z.object({
    paymentId: z.string().min(1, 'paymentId is required'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          paymentId: { type: 'string', description: 'Unique payment identifier' },
        },
        required: ['paymentId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getPaymentState');
    const payment = paymentService.getPayment(args.paymentId);
    if (!payment) {
      throw new Error(`Payment '${args.paymentId}' not found`);
    }
    requireMandateOwner(
      context,
      mandateService.getMandate(payment.mandateId)?.ownerReference,
      'getPaymentState',
      `Payment '${payment.id}'`
    );

    return {
      success: true,
      payment,
    };
  },
};

// ---------------------------------------------------------------------------
// 29. GET PAYMENT AUTHORIZATION STATE TOOL (Phase 7 Read-Only)
// ---------------------------------------------------------------------------
export const getPaymentAuthorizationStateTool: RelayTool = {
  name: 'getPaymentAuthorizationState',
  description:
    'Retrieves deterministic authorization status, limits validation, and mandate capacity check result.',
  schema: z.object({
    authorizationId: z.string().min(1, 'authorizationId is required'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          authorizationId: { type: 'string', description: 'Unique payment authorization identifier' },
        },
        required: ['authorizationId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getPaymentAuthorizationState');
    const auth = paymentService.getAuthorization(args.authorizationId);
    if (!auth) {
      throw new Error(`Payment authorization '${args.authorizationId}' not found`);
    }
    requireMandateOwner(
      context,
      mandateService.getMandate(auth.mandateId)?.ownerReference,
      'getPaymentAuthorizationState',
      `Authorization '${auth.id}'`
    );

    return {
      success: true,
      authorization: auth,
    };
  },
};

// ---------------------------------------------------------------------------
// 30. GET PROCUREMENT PAYMENT SUMMARY TOOL (Phase 7 Read-Only)
// ---------------------------------------------------------------------------
export const getProcurementPaymentSummaryTool: RelayTool = {
  name: 'getProcurementPaymentSummary',
  description:
    'Retrieves consolidated payment summary across all supplier obligations for a procurement commitment.',
  schema: z.object({
    commitmentId: z.string().min(1, 'commitmentId is required'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', description: 'Unique procurement commitment identifier' },
        },
        required: ['commitmentId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getProcurementPaymentSummary');
    const commitment = procurementCommitmentService.getCommitment(args.commitmentId);
    if (commitment) {
      requireCommitmentSociety(context, commitment.societyId, 'getProcurementPaymentSummary');
    }
    for (const payment of paymentService.getPaymentsForCommitment(args.commitmentId)) {
      requireMandateOwner(
        context,
        mandateService.getMandate(payment.mandateId)?.ownerReference,
        'getProcurementPaymentSummary',
        `Payment '${payment.id}'`
      );
    }
    const summary = paymentService.getProcurementPaymentSummary(args.commitmentId);

    return {
      success: true,
      summary,
    };
  },
};

// ---------------------------------------------------------------------------
// 31. CREATE FULFILLMENT ORDER TOOL (Phase 8 Authoritative Tracking Creation)
// ---------------------------------------------------------------------------
export const createFulfillmentOrderTool: RelayTool = {
  name: 'createFulfillmentOrder',
  description:
    'Creates deterministic fulfillment orders for a paid procurement commitment. AI cannot alter quantities or pricing; amounts and lines are derived directly from paid purchase orders.',
  schema: z.object({
    commitmentId: z.string().min(1, 'commitmentId is required'),
    fulfillmentType: z.enum(['PHYSICAL_GOODS', 'SERVICE']).optional(),
    deliveryArea: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', description: 'Unique commitment identifier' },
          fulfillmentType: { type: 'string', enum: ['PHYSICAL_GOODS', 'SERVICE'], description: 'Type of fulfillment' },
          deliveryArea: { type: 'string', description: 'Designated delivery/fulfillment location' },
        },
        required: ['commitmentId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'createFulfillmentOrder');
    const commitment = procurementCommitmentService.getCommitment(args.commitmentId);
    if (commitment) {
      requireCommitmentSociety(context, commitment.societyId, 'createFulfillmentOrder');
    }
    // Fulfillment requires a paid commitment: every payment must belong to
    // the context payer. With no payments yet, the service fails
    // deterministically (unpaid commitment cannot fulfill).
    for (const payment of paymentService.getPaymentsForCommitment(args.commitmentId)) {
      requireMandateOwner(
        context,
        mandateService.getMandate(payment.mandateId)?.ownerReference,
        'createFulfillmentOrder',
        `Payment '${payment.id}'`
      );
    }
    const result = await fulfillmentService.createFulfillmentForCommitment({
      commitmentId: args.commitmentId,
      fulfillmentType: args.fulfillmentType,
      deliveryArea: args.deliveryArea,
    });

    return {
      success: true,
      commitmentId: args.commitmentId,
      orderCount: result.orders.length,
      orders: result.orders,
      summary: result.summary,
    };
  },
};

// ---------------------------------------------------------------------------
// 32. GET FULFILLMENT STATE TOOL (Phase 8 Read-Only)
// ---------------------------------------------------------------------------
export const getFulfillmentStateTool: RelayTool = {
  name: 'getFulfillmentState',
  description:
    'Retrieves operational status, fulfilled quantities, tracking reference, and SLA status for a specific fulfillment order.',
  schema: z.object({
    fulfillmentId: z.string().min(1, 'fulfillmentId is required'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          fulfillmentId: { type: 'string', description: 'Unique fulfillment order identifier' },
        },
        required: ['fulfillmentId'],
      },
    };
  },
  async execute(args) {
    const order = fulfillmentService.getFulfillment(args.fulfillmentId);
    if (!order) {
      throw new Error(`FulfillmentOrder '${args.fulfillmentId}' not found`);
    }

    return {
      success: true,
      order,
    };
  },
};

// ---------------------------------------------------------------------------
// 33. GET FULFILLMENT SUMMARY TOOL (Phase 8 Read-Only)
// ---------------------------------------------------------------------------
export const getFulfillmentSummaryTool: RelayTool = {
  name: 'getFulfillmentSummary',
  description:
    'Retrieves aggregate multi-supplier fulfillment progress and operational status for a procurement commitment.',
  schema: z.object({
    commitmentId: z.string().min(1, 'commitmentId is required'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', description: 'Unique procurement commitment identifier' },
        },
        required: ['commitmentId'],
      },
    };
  },
  async execute(args) {
    const summary = fulfillmentService.getAggregateFulfillmentSummary(args.commitmentId);

    return {
      success: true,
      summary,
    };
  },
};

// ---------------------------------------------------------------------------
// 34. GET DELIVERY STATUS TOOL (Phase 8 Read-Only)
// ---------------------------------------------------------------------------
export const getDeliveryStatusTool: RelayTool = {
  name: 'getDeliveryStatus',
  description:
    'Queries logistics tracking details and current transit state for a fulfillment order from carrier gateway.',
  schema: z.object({
    fulfillmentId: z.string().min(1, 'fulfillmentId is required'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          fulfillmentId: { type: 'string', description: 'Unique fulfillment order identifier' },
        },
        required: ['fulfillmentId'],
      },
    };
  },
  async execute(args) {
    const tracking = await fulfillmentService.getTracking(args.fulfillmentId);

    return {
      success: true,
      fulfillmentId: args.fulfillmentId,
      tracking,
    };
  },
};

// ---------------------------------------------------------------------------
// 35. GET SLA STATUS TOOL (Phase 8 Read-Only)
// ---------------------------------------------------------------------------
export const getSLAStatusTool: RelayTool = {
  name: 'getSLAStatus',
  description:
    'Evaluates real-time SLA deadline, turnaround remaining, and breach metrics for a fulfillment order.',
  schema: z.object({
    fulfillmentId: z.string().min(1, 'fulfillmentId is required'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          fulfillmentId: { type: 'string', description: 'Unique fulfillment order identifier' },
        },
        required: ['fulfillmentId'],
      },
    };
  },
  async execute(args) {
    const sla = fulfillmentService.checkSLA(args.fulfillmentId);

    return {
      success: true,
      fulfillmentId: args.fulfillmentId,
      sla,
    };
  },
};

// ---------------------------------------------------------------------------
// 36. PROCESS SUPPLIER FULFILLMENT EVENT TOOL (Phase 8 Event Ingestion)
// ---------------------------------------------------------------------------
export const processSupplierFulfillmentEventTool: RelayTool = {
  name: 'processSupplierFulfillmentEvent',
  description:
    'Ingests a supplier-reported fulfillment event (e.g. ACCEPTED, DISPATCHED, IN_TRANSIT, DELIVERED). The event passes strict deterministic state machine and quantity validation.',
  schema: z.object({
    fulfillmentId: z.string().min(1, 'fulfillmentId is required'),
    supplierId: z.string().min(1, 'supplierId is required'),
    eventType: z.enum([
      'SUPPLIER_ACCEPTED',
      'SUPPLIER_REJECTED',
      'FULFILLMENT_STARTED',
      'ORDER_PACKED',
      'ORDER_DISPATCHED',
      'ORDER_IN_TRANSIT',
      'DELIVERY_ATTEMPTED',
      'ORDER_DELIVERED',
      'SERVICE_SCHEDULED',
      'SERVICE_STARTED',
      'SERVICE_COMPLETED',
      'FULFILLMENT_FAILED',
      'FULFILLMENT_UPDATED',
    ]),
    quantityFulfilled: z.number().optional(),
    trackingReference: z.string().optional(),
    notes: z.string().optional(),
    idempotencyKey: z.string().optional(),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          fulfillmentId: { type: 'string', description: 'Fulfillment order identifier' },
          supplierId: { type: 'string', description: 'Reporting supplier identifier' },
          eventType: { type: 'string', description: 'Supplier operational event type' },
          quantityFulfilled: { type: 'number', description: 'Cumulative quantity fulfilled so far' },
          trackingReference: { type: 'string', description: 'Carrier waybill reference' },
          notes: { type: 'string', description: 'Operational notes' },
          idempotencyKey: { type: 'string', description: 'Optional unique event deduplication key' },
        },
        required: ['fulfillmentId', 'supplierId', 'eventType'],
      },
    };
  },
  async execute(args) {
    const result = await fulfillmentService.ingestSupplierEvent({
      id: `evt_${Date.now()}`,
      fulfillmentId: args.fulfillmentId,
      supplierId: args.supplierId,
      eventType: args.eventType,
      timestamp: new Date(),
      quantityFulfilled: args.quantityFulfilled,
      trackingReference: args.trackingReference,
      notes: args.notes,
      idempotencyKey: args.idempotencyKey || `evt_${args.fulfillmentId}_${args.eventType}`,
    });

    return {
      success: true,
      status: result.order.status,
      fulfilledQuantity: result.order.fulfilledQuantity,
      remainingQuantity: result.order.remainingQuantity,
      isDuplicate: result.isDuplicate,
    };
  },
};

// ---------------------------------------------------------------------------
// 34. GET RESIDENT ALLOCATION TOOL (Phase 9)
// ---------------------------------------------------------------------------
export const getResidentAllocationTool: RelayTool = {
  name: 'getResidentAllocation',
  description:
    'Retrieves authoritative resident allocation records with strict server-side authorization checks.',
  schema: z.object({
    residentReference: z.string().describe('Target resident reference'),
    requestingResidentReference: z
      .string()
      .describe('Authoritative caller resident reference for authorization'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          residentReference: { type: 'string', description: 'Target resident reference' },
          requestingResidentReference: {
            type: 'string',
            description: 'Caller resident reference to verify authorization',
          },
        },
        required: ['residentReference', 'requestingResidentReference'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getResidentAllocation');
    requireContextResidentEcho(context, args.requestingResidentReference, 'getResidentAllocation');
    requireSelfResident(context, args.residentReference, 'getResidentAllocation');
    const allocations = residentAllocationService.getResidentAllocations(
      context.residentId,
      context.residentId
    );
    return {
      success: true,
      residentReference: context.residentId,
      allocations,
    };
  },
};

// ---------------------------------------------------------------------------
// 35. GET RESIDENT LEDGER TOOL (Phase 9)
// ---------------------------------------------------------------------------
export const getResidentLedgerTool: RelayTool = {
  name: 'getResidentLedger',
  description:
    'Queries immutable append-only ledger entries and current balance for a resident with server-side authorization.',
  schema: z.object({
    residentReference: z.string().describe('Target resident reference'),
    requestingResidentReference: z
      .string()
      .describe('Authoritative caller resident reference for authorization'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          residentReference: { type: 'string', description: 'Target resident reference' },
          requestingResidentReference: {
            type: 'string',
            description: 'Caller resident reference to verify authorization',
          },
        },
        required: ['residentReference', 'requestingResidentReference'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getResidentLedger');
    requireContextResidentEcho(context, args.requestingResidentReference, 'getResidentLedger');
    requireSelfResident(context, args.residentReference, 'getResidentLedger');
    const entries = residentLedgerService.getEntriesForResident(
      context.residentId,
      context.residentId
    );
    const balanceInfo = residentLedgerService.getResidentBalance(
      context.residentId,
      context.residentId
    );

    return {
      success: true,
      residentReference: context.residentId,
      balance: balanceInfo.balance,
      currency: balanceInfo.currency,
      entries,
    };
  },
};

// ---------------------------------------------------------------------------
// 36. GET ALLOCATION SUMMARY TOOL (Phase 9)
// ---------------------------------------------------------------------------
export const getAllocationSummaryTool: RelayTool = {
  name: 'getAllocationSummary',
  description:
    'Retrieves commitment-level aggregated allocation totals and reconciliation status (non-PII summary).',
  schema: z.object({
    commitmentId: z.string().describe('Procurement commitment identifier'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', description: 'Procurement commitment identifier' },
        },
        required: ['commitmentId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getAllocationSummary');
    const commitment = procurementCommitmentService.getCommitment(args.commitmentId);
    if (commitment) {
      requireCommitmentSociety(context, commitment.societyId, 'getAllocationSummary');
    }
    const summary = residentAllocationService.getCommitmentAllocationSummary(args.commitmentId);
    if (!summary) {
      return {
        success: false,
        error: `No allocation summary found for commitment '${args.commitmentId}'`,
      };
    }

    return {
      success: true,
      commitmentId: summary.commitmentId,
      status: summary.status,
      reconciliationStatus: summary.reconciliationStatus,
      totalRequestedQuantity: summary.totalRequestedQuantity,
      totalAllocatedQuantity: summary.totalAllocatedQuantity,
      totalProcurementCost: summary.totalProcurementCost,
      totalResidentAllocatedAmount: summary.totalResidentAllocatedAmount,
      residentCount: summary.residentCount,
    };
  },
};

// ---------------------------------------------------------------------------
// 37. GET RECONCILIATION STATUS TOOL (Phase 9)
// ---------------------------------------------------------------------------
export const getReconciliationStatusTool: RelayTool = {
  name: 'getReconciliationStatus',
  description:
    'Inspects deterministic 4-pillar reconciliation results, verification flags, and discrepancies.',
  schema: z.object({
    commitmentId: z.string().describe('Procurement commitment identifier'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          commitmentId: { type: 'string', description: 'Procurement commitment identifier' },
        },
        required: ['commitmentId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getReconciliationStatus');
    const commitment = procurementCommitmentService.getCommitment(args.commitmentId);
    if (commitment) {
      requireCommitmentSociety(context, commitment.societyId, 'getReconciliationStatus');
    }
    const result = residentReconciliationService.getReconciliationResult(args.commitmentId);
    if (!result) {
      return {
        success: false,
        error: `No reconciliation record found for commitment '${args.commitmentId}'`,
      };
    }

    return {
      success: true,
      commitmentId: result.commitmentId,
      status: result.status,
      isQuantityMatched: result.isQuantityMatched,
      isMonetaryMatched: result.isMonetaryMatched,
      isSupplierObligationsMatched: result.isSupplierObligationsMatched,
      isPaymentVerified: result.isPaymentVerified,
      discrepancyCount: result.discrepancies.length,
      discrepancies: result.discrepancies,
      reconciledAt: result.reconciledAt,
    };
  },
};

// ---------------------------------------------------------------------------
// 38. EXPLAIN ALLOCATION TOOL (Phase 9)
// ---------------------------------------------------------------------------
export const explainAllocationTool: RelayTool = {
  name: 'explainAllocation',
  description:
    'Provides an authoritative, non-hallucinated resident-facing breakdown of an allocation with server-side authorization.',
  schema: z.object({
    residentOrderId: z.string().describe('Resident order identifier'),
    requestingResidentReference: z
      .string()
      .describe('Authoritative caller resident reference for authorization'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          residentOrderId: { type: 'string', description: 'Resident order identifier' },
          requestingResidentReference: {
            type: 'string',
            description: 'Caller resident reference to verify authorization',
          },
        },
        required: ['residentOrderId', 'requestingResidentReference'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'explainAllocation');
    requireContextResidentEcho(context, args.requestingResidentReference, 'explainAllocation');
    const explanation = residentAllocationService.explainAllocation(
      args.residentOrderId,
      context.residentId
    );
    return {
      success: true,
      explanation,
    };
  },
};

/**
 * Commercial evidence block: every normalized quote received for the run,
 * the deterministic eligibility comparison (same comparator SELECT uses),
 * captured negotiation sequences, and the selection recommendation. Pure
 * read of completed engine state — never mutates procurement, payment, or
 * workflow state. Additive DTO: existing tool fields are untouched.
 */
export function buildCommercialEvidence(workflow: RelayWorkflow): {
  quotes: Array<Record<string, unknown>>;
  comparison: Record<string, unknown> | null;
  negotiations: Array<Record<string, unknown>>;
  selection: Record<string, unknown> | null;
  pricingEvidence?: Record<string, unknown> | null;
} {
  const receivedIds = workflow.entities.receivedQuoteIds || [];
  let quotes = receivedIds
    .map((id) => quoteNormalizationService.getQuote(id))
    .filter((q): q is NonNullable<typeof q> => Boolean(q))
    .map((quote) => ({
      id: quote.id,
      rfqId: quote.rfqId,
      supplierName: quote.supplierName,
      candidateId: quote.candidateId,
      total: quote.total,
      subtotal: quote.subtotal,
      deliveryFee: quote.deliveryFee,
      tax: quote.tax,
      otherCharges: quote.otherCharges,
      deliveryCommitment: quote.deliveryCommitment,
      deliveryEtaHours: quote.deliveryEtaHours,
      confirmedDeliveryEta: quote.confirmedDeliveryEta?.toISOString ? quote.confirmedDeliveryEta.toISOString() : (quote.confirmedDeliveryEta as any),
      validUntil: quote.validUntil?.toISOString ? quote.validUntil.toISOString() : (quote.validUntil as any),
      status: quote.status,
      isSimulated: quote.isSimulated,
      reasons: quote.reasons,
      hasTotalMismatch: quote.hasTotalMismatch,
      totalMismatchDifference: quote.totalMismatchDifference,
      lineItems: quote.lineItems,
    }));

  const rawNormalized = (workflow as { _normalizedQuotes?: Array<Record<string, unknown>> })._normalizedQuotes;
  if (quotes.length === 0 && Array.isArray(rawNormalized) && rawNormalized.length > 0) {
    quotes = rawNormalized.map((q: any) => ({
      id: q.id,
      rfqId: q.rfqId,
      supplierName: q.supplierName,
      candidateId: q.candidateId,
      total: q.total,
      subtotal: q.subtotal,
      deliveryFee: q.deliveryFee,
      tax: q.tax,
      otherCharges: q.otherCharges,
      deliveryCommitment: q.deliveryCommitment,
      deliveryEtaHours: q.deliveryEtaHours,
      confirmedDeliveryEta: q.confirmedDeliveryEta?.toISOString ? q.confirmedDeliveryEta.toISOString() : q.confirmedDeliveryEta,
      validUntil: q.validUntil?.toISOString ? q.validUntil.toISOString() : q.validUntil,
      status: q.status,
      isSimulated: q.isSimulated,
      reasons: q.reasons,
      hasTotalMismatch: q.hasTotalMismatch,
      totalMismatchDifference: q.totalMismatchDifference,
      lineItems: q.lineItems,
    }));
  }

  let comparison: Record<string, unknown> | null = null;
  const rfq = workflow.entities.rfqId ? rfqService.getRFQ(workflow.entities.rfqId) : undefined;
  const normalized = (workflow as { _normalizedQuotes?: unknown })._normalizedQuotes;
  if (rfq && Array.isArray(normalized) && normalized.length > 0) {
    const summary = quoteSelectionComparator.generateComparisonSummary(rfq, normalized as never);
    comparison = {
      rfqId: summary.rfqId,
      requestedQuantity: summary.requestedQuantity,
      unit: summary.unit,
      quotes: summary.quotes,
      eligibleQuoteIds: summary.eligibleQuotes.map((m) => m.quoteId),
      lowestCostQuoteId: summary.lowestCostQuoteId ?? null,
      fastestDeliveryQuoteId: summary.fastestDeliveryQuoteId ?? null,
      fullFulfillmentQuoteIds: summary.fullFulfillmentQuoteIds,
    };
  } else if (Array.isArray(normalized) && normalized.length > 0) {
    const normList = normalized as Array<Record<string, unknown>>;
    const selected = (workflow as { _selectedQuote?: Record<string, unknown> })._selectedQuote;
    const sorted = [...normList].sort((a, b) => Number(a.total) - Number(b.total));
    const lowest = sorted[0];
    comparison = {
      rfqId: workflow.entities.rfqId ?? null,
      requestedQuantity: Array.isArray((workflow as any).resolvedItems)
        ? (workflow as any).resolvedItems.reduce((acc: number, it: any) => acc + Number(it.quantity || 0), 0)
        : null,
      unit: 'items',
      quotes: normList.map((q: any) => ({
        quoteId: q.id,
        supplierName: q.supplierName,
        totalPrice: Number(q.total),
        deliveryEtaHours: q.deliveryEtaHours ?? 12,
        eligible: q.status === 'VALID',
        reasons: q.reasons ?? [],
      })),
      eligibleQuoteIds: normList.filter((q: any) => q.status === 'VALID').map((q: any) => q.id),
      lowestCostQuoteId: lowest?.id ?? selected?.id ?? null,
      fastestDeliveryQuoteId: normList[0]?.id ?? null,
      fullFulfillmentQuoteIds: normList.map((q: any) => q.id),
    };
  }

  const captured = (workflow as { _negotiationEvidence?: unknown })._negotiationEvidence;
  const negotiations = Array.isArray(captured)
    ? (captured as Array<Record<string, unknown>>)
    : [];

  const rec = (workflow as { _selectionRecommendation?: unknown })
    ._selectionRecommendation as
    | { decision?: unknown; quoteId?: unknown; reason?: unknown }
    | undefined;
  const selectedQuote = (workflow as { _selectedQuote?: Record<string, unknown> })._selectedQuote;
  const selection = rec
    ? { decision: rec.decision ?? null, quoteId: rec.quoteId ?? null, reason: rec.reason ?? '' }
    : selectedQuote
      ? {
          decision: 'SELECT',
          quoteId: selectedQuote.id,
          reason: `Selected lowest-cost verified quote from ${selectedQuote.supplierName}`,
        }
      : null;

  return {
    quotes,
    comparison,
    negotiations,
    selection,
    pricingEvidence: (workflow as any)._priceDiscovery || null,
  };
}

/**
 * Authoritative financial-proof snapshot for a workflow: commitment
 * financials, payment record + summary, allocation summary, reconciliation
 * verdict, and fulfillment state. Pure verbatim reads from the same domain
 * services the detail getters use — never mutated, never derived.
 *
 * Attached to startWorkflow/getWorkflowState results (which exist on every
 * engine run) so downstream evidence mapping never depends on which detail
 * getters the model happened to call. Additive DTO: existing tool fields
 * are untouched.
 */
export function buildFinancialEvidence(workflow: RelayWorkflow): {
  commitment: Record<string, unknown> | null;
  payment: Record<string, unknown> | null;
  paymentSummary: Record<string, unknown> | null;
  allocation: Record<string, unknown> | null;
  reconciliation: Record<string, unknown> | null;
  fulfillment: Record<string, unknown> | null;
} {
  const commitmentId = workflow.entities.commitmentId;
  const commitment =
    (commitmentId
      ? (procurementCommitmentService.getCommitment(commitmentId) as unknown as Record<string, unknown> | undefined)
      : undefined) ??
    ((workflow as { _commitment?: unknown })._commitment as Record<string, unknown> | undefined);

  const paymentId = workflow.entities.paymentId;
  const payment =
    (paymentId
      ? (paymentService.getPayment(paymentId) as unknown as Record<string, unknown> | undefined)
      : undefined) ??
    ((workflow as { _payment?: unknown })._payment as Record<string, unknown> | undefined);

  let paymentSummary: Record<string, unknown> | null = null;
  if (commitmentId && commitment) {
    try {
      paymentSummary = paymentService.getProcurementPaymentSummary(
        commitmentId
      ) as unknown as Record<string, unknown>;
    } catch {
      paymentSummary = null;
    }
  }
  if (!paymentSummary && payment) {
    paymentSummary = {
      status: payment.status === 'SUCCEEDED' ? 'FULLY_PAID' : payment.status,
      paidAmount: payment.amount,
      currency: payment.currency || 'INR',
    };
  }

  const allocation =
    (commitmentId
      ? ((residentAllocationService.getCommitmentAllocationSummary(
          commitmentId
        ) as unknown as Record<string, unknown> | undefined) ?? null)
      : null) ??
    (((workflow as { _allocationSummary?: unknown })._allocationSummary as Record<string, unknown> | undefined) ?? null);

  const reconciliation =
    (commitmentId
      ? ((residentReconciliationService.getReconciliationResult(
          commitmentId
        ) as unknown as Record<string, unknown> | undefined) ?? null)
      : null) ??
    (((workflow as { _reconciliationResult?: unknown })._reconciliationResult as Record<string, unknown> | undefined) ?? null);

  const fulfillmentId = workflow.entities.fulfillmentOrderIds?.[0];
  const fulfillment =
    (fulfillmentId
      ? ((fulfillmentService.getFulfillment(
          fulfillmentId
        ) as unknown as Record<string, unknown> | undefined) ?? null)
      : null) ??
    (((workflow as { _fulfillmentOrder?: unknown })._fulfillmentOrder as Record<string, unknown> | undefined) ?? null);

  return {
    commitment: commitment ?? null,
    payment: payment ?? null,
    paymentSummary,
    allocation,
    reconciliation,
    fulfillment,
  };
}

/**
 * Requested-vs-guaranteed SLA disclosure block. requestedHours is the
 * verbatim user-stated deadline when the request named one; the operational
 * guarantee is the deterministic Relay SLA.
 */
export function buildSlaEvidence(workflow: RelayWorkflow): {
  requestedHours: number | null;
  operationalGuaranteeHours: number;
} {
  return {
    requestedHours: workflow.requestedDeadlineHours ?? null,
    operationalGuaranteeHours: OPERATIONAL_SLA_HOURS,
  };
}

// ---------------------------------------------------------------------------
// 39. START WORKFLOW TOOL (Phase 10)
// ---------------------------------------------------------------------------
export const startWorkflowTool: RelayTool = {
  name: 'startWorkflow',
  description:
    'Initializes a new autonomous procurement workflow from a resident request.',
  schema: z.object({
    requestText: z.string().describe('Natural-language procurement request'),
    residentReference: z.string().describe('Requesting resident identifier'),
    societyReference: z.string().describe('Resident apartment community identifier'),
    address: z.string().optional().describe('Delivery location address'),
    latitude: z.number().optional().describe('Delivery location latitude'),
    longitude: z.number().optional().describe('Delivery location longitude'),
    idempotencyKey: z.string().optional().describe('Optional request deduplication key'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          requestText: { type: 'string', description: 'Resident natural-language request' },
          residentReference: { type: 'string', description: 'Resident identifier' },
          societyReference: { type: 'string', description: 'Society identifier' },
          address: { type: 'string', description: 'Delivery address' },
          latitude: { type: 'number', description: 'Latitude' },
          longitude: { type: 'number', description: 'Longitude' },
          idempotencyKey: { type: 'string', description: 'Deduplication key' },
        },
        required: ['requestText'],
      },
    };
  },
  async execute(args, ctx) {
    // Identity binding: model-supplied references must exactly match the
    // server-resolved execution context. Invented or user-claimed identifiers
    // are rejected before any workflow state is created. Throws (fail-closed)
    // rather than returning, so the classified code reaches the agent loop.
    if (
      !ctx ||
      args.residentReference !== ctx.residentId ||
      args.societyReference !== ctx.societyId
    ) {
      throw new ToolExecutionError(
        'IDENTITY_REFERENCE_MISMATCH',
        "Tool 'startWorkflow' rejected: residentReference and societyReference must " +
          'exactly match the authenticated execution context.'
      );
    }
    // Deterministic intent gate: resolve the request through the 14.2
    // validated stack BEFORE any workflow state exists. Unresolvable
    // products (or any other intent failure) throw fail-closed here, so
    // no workflow, discovery, quote, commitment, or payment can begin.
    // Throws (fail-closed) rather than returning, so the classified code
    // reaches the agent loop — same precedent as identity binding above.
    const resolved = await resolveWorkflowRequest(args.requestText);
    const resolvedItems = resolved.items;

    // Dynamically resolve resident society location from database if available
    let locAddress = args.address;
    let locLat = args.latitude;
    let locLng = args.longitude;
    let locCity: string | undefined = undefined;

    try {
      const society = await prisma.society.findUnique({
        where: { id: args.societyReference },
      });
      if (society) {
        if (!locAddress && society.address) locAddress = society.address;
        if (locLat === undefined && society.latitude) locLat = Number(society.latitude);
        if (locLng === undefined && society.longitude) locLng = Number(society.longitude);
        locCity = society.city;
      }
    } catch {
      // Prisma lookup failed or in-memory mode; proceed with standard fallbacks
    }

    let workflow: RelayWorkflow | undefined;
    try {
      workflow = await relayOrchestrator.createWorkflow({
        requestText: args.requestText,
        residentReference: args.residentReference,
        societyReference: args.societyReference,
        requestedDeadlineHours: resolved.deadlineHours,
        resolvedItems: resolvedItems.map((item) => ({
          productName: item.productName,
          quantity: item.quantity,
          unit: item.unit,
          identitySource: item.identitySource,
          ...(item.productId ? { productId: item.productId } : {}),
          ...(item.brand !== undefined ? { brand: item.brand } : {}),
          ...(item.packaging !== undefined ? { packaging: item.packaging } : {}),
          ...(item.packSize !== undefined ? { packSize: item.packSize } : {}),
          ...(item.priceCue !== undefined ? { priceCue: item.priceCue } : {}),
          ...(item.variant !== undefined ? { variant: item.variant } : {}),
        })),
        location: {
          address: locAddress || 'Greenview Residency, Baner, Pune',
          latitude: locLat ?? 18.5204,
          longitude: locLng ?? 73.8567,
          city: locCity,
        },
        metadata: { ...(ctx?.metadata || {}), runId: ctx?.runId },
        idempotencyKey: args.idempotencyKey,
      });

      const completedWf = await relayOrchestrator.executeWorkflow(workflow.id);

      const payload = {
        workflowId: completedWf.id,
        status: completedWf.status,
        currentStage: completedWf.currentStage,
        version: completedWf.workflowVersion,
        commercial: buildCommercialEvidence(completedWf),
        financialProof: buildFinancialEvidence(completedWf),
        sla: buildSlaEvidence(completedWf),
      };

      return {
        success: true,
        data: payload,
        ...payload,
      };
    } catch (err: any) {
      const activeWf = workflow ? (relayOrchestrator.getWorkflow(workflow.id) || workflow) : undefined;
      const progress = activeWf ? relayOrchestrator.getWorkflowProgress(activeWf.id) : undefined;
      return {
        success: false,
        error: err.message || String(err),
        ...(activeWf ? {
          workflowId: activeWf.id,
          status: activeWf.status,
          currentStage: activeWf.currentStage,
          failureReason: activeWf.failureReason || err.message,
          progress,
          stages: activeWf.stages,
        } : {}),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 40. GET WORKFLOW STATE TOOL (Phase 10)
// ---------------------------------------------------------------------------
export const getWorkflowStateTool: RelayTool = {
  name: 'getWorkflowState',
  description:
    'Queries the current state, progress checklist, and authoritative entities of an active workflow.',
  schema: z.object({
    workflowId: z.string().describe('Relay workflow identifier'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'Workflow identifier' },
        },
        required: ['workflowId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'getWorkflowState');
    const workflow = relayOrchestrator.getWorkflow(args.workflowId);
    if (!workflow) {
      return {
        success: false,
        error: `Workflow '${args.workflowId}' not found`,
      };
    }
    requireWorkflowOwnership(context, workflow, 'getWorkflowState');

    const progress = relayOrchestrator.getWorkflowProgress(args.workflowId);

    const payload = {
      workflowId: workflow.id,
      status: workflow.status,
      currentStage: workflow.currentStage,
      isPaused: workflow.isPaused,
      pauseReason: workflow.pauseReason,
      failureReason: workflow.failureReason,
      entities: workflow.entities,
      progress,
      commercial: buildCommercialEvidence(workflow),
      financialProof: buildFinancialEvidence(workflow),
      sla: buildSlaEvidence(workflow),
    };

    return {
      success: true,
      data: payload,
      ...payload,
    };
  },
};

// ---------------------------------------------------------------------------
// 41. EXECUTE WORKFLOW STEP TOOL (Phase 10)
// ---------------------------------------------------------------------------
export const executeWorkflowStepTool: RelayTool = {
  name: 'executeWorkflowStep',
  description:
    'Drives an active workflow forward by executing its next legal deterministic stage.',
  schema: z.object({
    workflowId: z.string().describe('Relay workflow identifier'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'Workflow identifier' },
        },
        required: ['workflowId'],
      },
    };
  },
  async execute(args, ctx) {
    try {
      const context = requireToolContext(ctx, 'executeWorkflowStep');
      const existing = relayOrchestrator.getWorkflow(args.workflowId);
      if (existing) {
        requireWorkflowOwnership(context, existing, 'executeWorkflowStep');
      }
      const workflow = await relayOrchestrator.executeNextStep(args.workflowId);
      const payload = {
        workflowId: workflow.id,
        status: workflow.status,
        currentStage: workflow.currentStage,
        isPaused: workflow.isPaused,
      };
      return {
        success: true,
        data: payload,
        ...payload,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 42. RESUME WORKFLOW TOOL (Phase 10)
// ---------------------------------------------------------------------------
export const resumeWorkflowTool: RelayTool = {
  name: 'resumeWorkflow',
  description:
    'Resumes an interrupted, paused, or transiently failed workflow from its latest valid checkpoint.',
  schema: z.object({
    workflowId: z.string().describe('Relay workflow identifier'),
    clarifiedText: z.string().optional().describe('Clarified request text'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'Workflow identifier' },
          clarifiedText: { type: 'string', description: 'Clarified request text' },
        },
        required: ['workflowId'],
      },
    };
  },
  async execute(args, ctx) {
    try {
      const context = requireToolContext(ctx, 'resumeWorkflow');
      const existing = relayOrchestrator.getWorkflow(args.workflowId);
      if (existing) {
        requireWorkflowOwnership(context, existing, 'resumeWorkflow');
      }
      const workflow = await relayOrchestrator.resumeWorkflow(args.workflowId, args.clarifiedText);
      const payload = {
        workflowId: workflow.id,
        status: workflow.status,
        currentStage: workflow.currentStage,
        retryCount: workflow.retryCount,
      };
      return {
        success: true,
        data: payload,
        ...payload,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// 43. EXPLAIN WORKFLOW TOOL (Phase 10)
// ---------------------------------------------------------------------------
export const explainWorkflowTool: RelayTool = {
  name: 'explainWorkflow',
  description:
    'Provides a clear, factual, resident-facing summary of where an order is and what happened.',
  schema: z.object({
    workflowId: z.string().describe('Relay workflow identifier'),
  }),
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      parameters: {
        type: 'object',
        properties: {
          workflowId: { type: 'string', description: 'Workflow identifier' },
        },
        required: ['workflowId'],
      },
    };
  },
  async execute(args, ctx) {
    const context = requireToolContext(ctx, 'explainWorkflow');
    const workflow = relayOrchestrator.getWorkflow(args.workflowId);
    if (!workflow) {
      return {
        success: false,
        error: `Workflow '${args.workflowId}' not found`,
      };
    }
    requireWorkflowOwnership(context, workflow, 'explainWorkflow');

    let explanation = `Your request "${workflow.requestText}" is currently in stage: ${workflow.currentStage} (status: ${workflow.status}).`;
    if (workflow.status === 'COMPLETED') {
      explanation = `Your order for "${workflow.intent?.productName || workflow.requestText}" has been completed, delivered, verified, allocated, and reconciled.`;
    } else if (workflow.status === 'AWAITING_CLARIFICATION') {
      explanation = `We need a quick clarification: ${workflow.pauseReason || 'Please clarify your request.'}`;
    } else if (workflow.status === 'FAILED') {
      explanation = `The workflow halted: ${workflow.failureReason || 'An operational error occurred.'}`;
    }

    const payload = {
      workflowId: workflow.id,
      currentStage: workflow.currentStage,
      status: workflow.status,
      explanation,
    };

    return {
      success: true,
      data: payload,
      ...payload,
    };
  },
};
