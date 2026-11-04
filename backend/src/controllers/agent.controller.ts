import { Request, Response, NextFunction } from 'express';
import { relayAgent } from '../agent';
import { membershipService, procurementIdentityService } from '../identity';
import { relayOrchestrator } from '../orchestration';
import { paymentService } from '../payment';
import { prisma } from '../config/prisma';
import {
  buildCommercialEvidence,
  buildFinancialEvidence,
  buildSlaEvidence,
} from '../agent/tools/definitions';

/**
 * Terminal run codes that mean "Relay understood enough to know it needs
 * clarification" rather than a server failure. Served as HTTP 200 with
 * success:false so blocked-run artifacts reach the client intact.
 */
const CLARIFICATION_ERROR_CODES = new Set([
  'UNMAPPABLE_PRODUCT',
  'AMBIGUOUS_REFERENCE',
  'MISSING_QUANTITY',
  'MISSING_UNIT',
  'NEGATIVE_QUANTITY',
  'UNSUPPORTED_UNIT',
  'SCHEMA_VIOLATION',
  'PROMPT_INJECTION_DETECTED',
  'NO_TOOL_CALL',
  'NO_TOOL_CALLS',
  'EMPTY_REQUEST',
  'INTENT_RESOLUTION_FAILED',
  'INTENT_RESOLUTION_MISMATCH',
  // Business-blocked outcomes: Relay understood the request and a
  // deterministic check refused it. Also HTTP 200 with success:false.
  'MANDATE_LIMIT_EXCEEDED',
  'MANDATE_CUMULATIVE_LIMIT_EXCEEDED',
  'MANDATE_NOT_FOUND',
  'MISSING_ORDER_EVIDENCE',
  'MISSING_SUPPLIER_EVIDENCE',
  'MISSING_PRICE_EVIDENCE',
]);

export class AgentController {
  /**
   * POST /api/agent/run
   * Triggers the autonomous agent loop to fulfill a procurement request.
   */
  public async run(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const {
        message,
        requestId,
        metadata,
      } = req.body;

      // IDOR Defense: an authenticated caller cannot spoof another resident.
      if (req.residentId && req.body.residentId && req.body.residentId !== req.residentId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: You cannot initiate procurement for another resident',
          },
        });
        return;
      }

      // Pure input validation runs before identity resolution so malformed
      // requests fail as 400 regardless of onboarding state.
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: "Field 'message' is required and must not be empty.",
          },
        });
        return;
      }

      if (message.length > 5000) {
        res.status(400).json({
          success: false,
          error: {
            code: 'REQUEST_TOO_LARGE',
            message: "Field 'message' exceeds maximum allowed length of 5000 characters.",
          },
        });
        return;
      }

      // Identity is derived ONLY from the validated session. There is no
      // anonymous or seed fallback: an unauthenticated caller is rejected by
      // requireAuth before reaching this handler.
      const residentId = req.residentId;
      if (!residentId || !req.user) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required.' },
        });
        return;
      }

      let societyId = req.body.societyId;
      const mem = await membershipService.getMembershipByUserId(req.user.id);
      const membershipSocietyId = mem?.societyId;
      if (!societyId && membershipSocietyId) {
        societyId = membershipSocietyId;
      }
      // IDOR Defense: a member cannot procure for another society.
      if (societyId && membershipSocietyId && societyId !== membershipSocietyId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: You cannot initiate procurement for another society',
          },
        });
        return;
      }

      // P0 identity bridge: persist the authenticated session's canonical
      // society/resident/mandate rows (same soc_*/res_*/mandate_* ids) so the
      // Prisma-backed procurement engine resolves them. Throws a controlled
      // 422 ONBOARDING_INCOMPLETE when membership/society is unresolvable.
      await procurementIdentityService.ensureCanonicalIdentities(req.user.id);
      if (!societyId) {
        societyId = membershipSocietyId;
      }

      const result = await relayAgent.run({
        residentId,
        societyId,
        message,
        requestId,
        metadata,
      });

      // Blocked-clarification codes stay HTTP 200 with success:false: the
      // API call itself succeeded and the run artifacts (steps, honest
      // message) must reach the client intact. A 4xx/5xx here would make the
      // frontend API client throw the body away and lose the blocked-run
      // evidence. Mirrors the frontend CLARIFICATION_CODES set.
      const errCode = result.error?.code;
      const isClarification =
        errCode !== undefined && CLARIFICATION_ERROR_CODES.has(errCode);
      const statusCode =
        result.success || isClarification
          ? 200
          : errCode === 'AGENT_STEP_LIMIT_EXCEEDED'
            ? 429
            : 500;
      res.status(statusCode).json(result);
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/agent/workflow/:id/cancel
   * Cancels an in-flight mission owned by the session resident. Cancellation
   * is refused once a payment has SUCCEEDED (money moved cannot be recalled
   * by abandoning the record) and for terminal missions.
   */
  public async cancelWorkflow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const workflow = relayOrchestrator.getWorkflow(req.params.id);
      if (!workflow) {
        res.status(404).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_FOUND', message: `Workflow '${req.params.id}' not found` },
        });
        return;
      }
      if (workflow.residentReference !== req.residentId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: workflow belongs to another resident',
          },
        });
        return;
      }
      if (workflow.entities.paymentId) {
        const payment = paymentService.getPayment(workflow.entities.paymentId);
        if (payment && payment.status === 'SUCCEEDED') {
          res.status(409).json({
            success: false,
            error: {
              code: 'CANCELLATION_REJECTED_AFTER_PAYMENT',
              message: 'Cannot cancel: payment already executed for this mission',
            },
          });
          return;
        }
      }
      try {
        const cancelled = relayOrchestrator.cancelWorkflow(
          workflow.id,
          typeof req.body?.reason === 'string' ? req.body.reason : 'Resident requested cancellation'
        );
        res.status(200).json({
          success: true,
          data: {
            workflowId: cancelled.id,
            status: cancelled.status,
            currentStage: cancelled.currentStage,
          },
        });
      } catch (err: any) {
        res.status(409).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_CANCELLABLE', message: err.message },
        });
        return;
      }
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/agent/workflow/:id/restore
   * Restores a mission owned by the session resident from its durable
   * record (e.g. after a backend restart evicted the in-memory registry).
   * Ownership is checked against the DURABLE record, so a restart never
   * widens access: a resident can only restore their own missions.
   */
  public async restoreWorkflow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const restored = await relayOrchestrator.restoreWorkflow(req.params.id);
      if (!restored) {
        res.status(404).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_FOUND', message: `Workflow '${req.params.id}' not found` },
        });
        return;
      }
      if (restored.residentReference !== req.residentId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: workflow belongs to another resident',
          },
        });
        return;
      }
      res.status(200).json({
        success: true,
        data: {
          workflowId: restored.id,
          status: restored.status,
          currentStage: restored.currentStage,
          workflowVersion: restored.workflowVersion,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/agent/workflow/:id
   * GET /api/agent/runs/:id
   * Retrieves an authoritative persisted or active mission snapshot for the session resident.
   * Cross-resident and cross-society access is strictly rejected with 403.
   */
  public async getWorkflow(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = req.params.id;
      if (!rawId || typeof rawId !== 'string') {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_ID', message: 'Missing mission or workflow identifier' },
        });
        return;
      }

      const residentId = req.residentId;
      if (!residentId) {
        res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
        return;
      }

      // Try finding the workflow:
      // 1. Direct in-memory lookup
      let workflow = relayOrchestrator.getWorkflow(rawId);

      // 2. Search in-memory workflows by metadata.runId, workflowId, or prefix
      if (!workflow) {
        const cleanRaw = rawId.toLowerCase();
        const unPrefixed = cleanRaw.startsWith('run-') ? cleanRaw.slice(4) : cleanRaw;
        workflow = relayOrchestrator.listWorkflows().find((w) => {
          const wId = w.id.toLowerCase();
          const wUnprefixed = wId.startsWith('wf_') ? wId.slice(3) : wId;
          if (
            wId === cleanRaw ||
            wId.startsWith(cleanRaw) ||
            wUnprefixed.startsWith(unPrefixed) ||
            wId.includes(unPrefixed)
          ) {
            return true;
          }
          const metaRunId = String(w.metadata?.runId || '').toLowerCase();
          const metaUnprefixed = metaRunId.startsWith('run-') ? metaRunId.slice(4) : metaRunId;
          return (
            metaRunId === cleanRaw ||
            metaRunId.startsWith(cleanRaw) ||
            metaUnprefixed === unPrefixed ||
            metaUnprefixed.startsWith(unPrefixed)
          );
        });
      }

      // 3. If not found in memory, restore from durable PostgreSQL storage
      if (!workflow) {
        try {
          workflow = (await relayOrchestrator.restoreWorkflow(rawId)) ?? undefined;
        } catch {
          // If restore by direct ID failed, try resolving via Prisma metadata/ID
        }
      }

      if (!workflow) {
        try {
          const cleanRaw = rawId.toLowerCase();
          const unPrefixed = cleanRaw.startsWith('run-') ? cleanRaw.slice(4) : cleanRaw;
          const rows = await prisma.relayWorkflow.findMany({
            where: {
              OR: [
                { id: { startsWith: cleanRaw } },
                { id: { startsWith: `wf_${unPrefixed}` } },
                { residentReference: residentId },
              ],
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
          });
          const match = rows.find((r) => {
            const rowId = r.id.toLowerCase();
            const rowUnprefixed = rowId.startsWith('wf_') ? rowId.slice(3) : rowId;
            if (
              rowId === cleanRaw ||
              rowId.startsWith(cleanRaw) ||
              rowUnprefixed.startsWith(unPrefixed)
            ) {
              return true;
            }
            const meta = r.metadata as Record<string, unknown> | null;
            const runId = String(meta?.runId || '').toLowerCase();
            const metaUnprefixed = runId.startsWith('run-') ? runId.slice(4) : runId;
            return (
              runId === cleanRaw ||
              runId.startsWith(cleanRaw) ||
              metaUnprefixed === unPrefixed ||
              metaUnprefixed.startsWith(unPrefixed)
            );
          });
          if (match) {
            workflow = (await relayOrchestrator.restoreWorkflow(match.id)) ?? undefined;
          }
        } catch {
          // Prisma query fallback ignored
        }
      }

      if (!workflow) {
        res.status(404).json({
          success: false,
          error: { code: 'WORKFLOW_NOT_FOUND', message: `Mission '${rawId}' not found` },
        });
        return;
      }

      // Authorization guard: verify resident ownership or society membership
      const isOwner = workflow.residentReference === residentId;
      const mem = req.user ? await membershipService.getMembershipByUserId(req.user.id) : null;
      const isSocietyMember = mem && mem.societyId === workflow.societyReference;

      if (!isOwner && !isSocietyMember) {
        res.status(403).json({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'Access denied: mission belongs to another resident or society',
          },
        });
        return;
      }

      const runId = (workflow.metadata?.runId as string) || workflow.id;
      const commercial = buildCommercialEvidence(workflow);
      const financialProof = buildFinancialEvidence(workflow);
      const sla = buildSlaEvidence(workflow);
      const progress = relayOrchestrator.getWorkflowProgress(workflow.id);
      const discoveredCandidates = (workflow as { _discoveredCandidates?: unknown[] })._discoveredCandidates || [];
      const qualifiedCandidates = (workflow as { _qualifiedCandidates?: unknown[] })._qualifiedCandidates || [];

      const workflowPayload = {
        workflowId: workflow.id,
        status: workflow.status,
        currentStage: workflow.currentStage,
        version: workflow.workflowVersion,
        entities: workflow.entities,
        discoveredCandidates,
        qualifiedCandidates,
        stages: workflow.stages,
        progress,
        commercial,
        financialProof,
        sla,
      };

      // Construct canonical agentResponse so frontend stageEvidence & runEvidence map correctly
      const synthesizedAgentResponse = {
        success: workflow.status === 'COMPLETED',
        completed: workflow.status === 'COMPLETED',
        runId,
        totalSteps: 2,
        response:
          workflow.status === 'COMPLETED'
            ? 'Autonomous procurement complete and verified.'
            : workflow.failureReason || 'Procurement mission halted.',
        steps: [
          {
            step: 1,
            toolCall: {
              name: 'startWorkflow',
              args: { requestText: workflow.requestText },
              result: {
                success: workflow.status === 'COMPLETED',
                data: workflowPayload,
                ...workflowPayload,
              },
            },
          },
          {
            step: 2,
            toolCall: {
              name: 'getWorkflowState',
              args: { workflowId: workflow.id },
              result: {
                success: true,
                data: workflowPayload,
                ...workflowPayload,
              },
            },
          },
        ],
        error:
          workflow.status === 'FAILED'
            ? {
                code: workflow.failureReason?.split(':')[0] || 'WORKFLOW_FAILED',
                message: workflow.failureReason || 'Mission failed',
              }
            : undefined,
      };

      const runResult = {
        status:
          workflow.status === 'COMPLETED'
            ? 'complete'
            : workflow.status === 'FAILED'
              ? 'failed'
              : 'processing',
        prompt: workflow.requestText,
        agentResponse: synthesizedAgentResponse,
        fullCycle: null,
        residentOrderId: workflow.entities.residentOrderId || null,
        communityOrderId:
          (workflow.entities as unknown as Record<string, unknown>).communityOrderId
            ? String((workflow.entities as unknown as Record<string, unknown>).communityOrderId)
            : workflow.entities.commitmentId || null,
        error:
          workflow.status === 'FAILED'
            ? {
                code: workflow.failureReason?.split(':')[0] || 'WORKFLOW_FAILED',
                message: workflow.failureReason || 'Mission failed',
                timedOut: false,
                unauthorized: false,
              }
            : null,
        startedAt: workflow.startedAt?.toISOString() || null,
        finishedAt: workflow.completedAt?.toISOString() || null,
      };

      res.status(200).json({
        success: true,
        data: runResult,
      });
    } catch (err) {
      next(err);
    }
  }
}

export const agentController = new AgentController();
