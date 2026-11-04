import { randomUUID } from 'crypto';
import { WorkflowCheckpointService, workflowCheckpointService } from './WorkflowCheckpointService';
import { WorkflowEventService, workflowEventService } from './WorkflowEventService';
import { WorkflowExecutor, workflowExecutor } from './WorkflowExecutor';
import { WorkflowPlanner, workflowPlanner } from './WorkflowPlanner';
import { WorkflowRecoveryService, workflowRecoveryService } from './WorkflowRecoveryService';
import { WorkflowPersistenceService, workflowPersistenceService } from './WorkflowPersistenceService';
import {
  CreateWorkflowInput,
  RelayWorkflow,
  WorkflowLocation,
  WorkflowStage,
  WorkflowStageProgress,
  WorkflowStatus,
} from './types';
import { validateCreateWorkflowInput } from './validation';
import { transitionWorkflowStatus } from './stateMachine';

const DEFAULT_STAGES: { stage: WorkflowStage; label: string }[] = [
  { stage: 'UNDERSTAND', label: 'Intent Understanding & Demand Creation' },
  { stage: 'DISCOVER', label: 'Geographic Supplier Discovery' },
  { stage: 'QUALIFY', label: 'Deterministic Supplier Qualification' },
  { stage: 'QUOTE', label: 'RFQ Dispatch & Quote Ingestion' },
  { stage: 'NEGOTIATE', label: 'Autonomous Price & SLA Negotiation' },
  { stage: 'SELECT', label: 'Quote Selection & Allocation Decision' },
  { stage: 'COMMIT', label: 'Procurement Commitment & PO Creation' },
  { stage: 'PAY', label: 'Mandate Check & Authorized Payment Execution' },
  { stage: 'FULFILL', label: 'Order Acceptance, Packing & Carrier Dispatch' },
  { stage: 'VERIFY', label: 'Delivery Evidence Verification' },
  { stage: 'ALLOCATE', label: 'Resident Demand & Monetary Allocation' },
  { stage: 'RECONCILE', label: '4-Pillar Financial & Quantity Reconciliation' },
  { stage: 'COMPLETE', label: 'Workflow Terminal Completion' },
];

export class RelayOrchestrator {
  private workflows = new Map<string, RelayWorkflow>();
  private idempotencyStore = new Map<string, RelayWorkflow>();
  private mutexes = new Map<string, Promise<void>>();

  constructor(
    private readonly planner: WorkflowPlanner = workflowPlanner,
    private readonly executor: WorkflowExecutor = workflowExecutor,
    private readonly checkpointService: WorkflowCheckpointService = workflowCheckpointService,
    private readonly eventService: WorkflowEventService = workflowEventService,
    private readonly recoveryService: WorkflowRecoveryService = workflowRecoveryService,
    private readonly persistenceService: WorkflowPersistenceService = workflowPersistenceService
  ) {}

  /**
   * Initializes a new autonomous procurement workflow from a resident natural-language request.
   */
  public async submitRequest(input: CreateWorkflowInput): Promise<RelayWorkflow> {
    const residentReference = input.residentReference || `res_${randomUUID().slice(0, 8)}`;
    const societyReference = input.societyReference || 'soc_greenview_pune';
    const dedupeKey = input.idempotencyKey || `wf_req_${residentReference}_${input.requestText}`;

    // 1. Idempotency Check
    if (this.idempotencyStore.has(dedupeKey)) {
      return this.idempotencyStore.get(dedupeKey)!;
    }

    validateCreateWorkflowInput(input);

    const now = new Date();
    const workflowId = `wf_${randomUUID().slice(0, 10)}`;

    const location: WorkflowLocation = {
      address: input.location?.address || 'Tower 4, Greenview Residency, Pune',
      latitude: input.location?.latitude ?? 18.5204,
      longitude: input.location?.longitude ?? 73.8567,
      city: input.location?.city,
      radiusMeters: input.location?.radiusMeters ?? 10000,
    };

    const stages: WorkflowStageProgress[] = DEFAULT_STAGES.map((s) => ({
      stage: s.stage,
      label: s.label,
      status: 'PENDING',
    }));

    const workflow: RelayWorkflow = {
      id: workflowId,
      residentReference,
      societyReference,
      requestText: input.requestText,
      resolvedItems: input.resolvedItems,
      requestedDeadlineHours: input.requestedDeadlineHours,
      location,
      status: 'DRAFT',
      currentStage: 'UNDERSTAND',
      workflowVersion: 1,
      entities: {
        residentReference,
        societyReference,
        supplierCandidateIds: [],
        qualifiedSupplierIds: [],
        receivedQuoteIds: [],
        negotiatedQuoteIds: [],
        purchaseOrderIds: [],
        fulfillmentOrderIds: [],
        deliveryTrackingCodes: [],
      },
      stages,
      retryCount: 0,
      isPaused: false,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    this.workflows.set(workflow.id, workflow);
    this.idempotencyStore.set(dedupeKey, workflow);

    // Durable first: the workflow row must exist before checkpoint/event
    // rows reference it (FK), and before any crash can lose the mission.
    await this.persistenceService.persistWorkflowSnapshot(workflow);

    this.checkpointService.saveCheckpoint(workflow);

    this.eventService.emit('WORKFLOW_CREATED', workflow.id, 'UNDERSTAND', {
      residentReference: workflow.residentReference,
      societyReference: workflow.societyReference,
      requestText: workflow.requestText,
    });

    return workflow;
  }

  /**
   * Convenience alias: creates workflow and initializes stages.
   */
  public async createWorkflow(input: CreateWorkflowInput): Promise<RelayWorkflow> {
    return this.submitRequest(input);
  }

  /**
   * Starts a new workflow and drives it autonomously to completion or pause.
   */
  public async startWorkflow(input: CreateWorkflowInput): Promise<RelayWorkflow> {
    const workflow = await this.submitRequest(input);
    return this.executeWorkflow(workflow.id);
  }

  /**
   * Drives the autonomous loop end-to-end through all stages until completion or pause.
   */
  public async executeWorkflow(workflowId: string): Promise<RelayWorkflow> {
    await this.acquireMutex(workflowId);

    try {
      const workflow = this.workflows.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow '${workflowId}' not found`);
      }

      const stageOrder: WorkflowStage[] = [
        'UNDERSTAND',
        'DISCOVER',
        'QUALIFY',
        'QUOTE',
        'NEGOTIATE',
        'SELECT',
        'COMMIT',
        'PAY',
        'FULFILL',
        'VERIFY',
        'ALLOCATE',
        'RECONCILE',
        'COMPLETE',
      ];

      // Identify starting stage
      const currentIndex = stageOrder.indexOf(workflow.currentStage);
      const startIndex = currentIndex >= 0 ? currentIndex : 0;

      for (let i = startIndex; i < stageOrder.length; i++) {
        const stage = stageOrder[i];

        // Halt if workflow is paused (e.g. clarification needed) or terminal
        const statusBefore = workflow.status as WorkflowStatus;
        if (
          workflow.isPaused ||
          statusBefore === 'BLOCKED' ||
          statusBefore === 'FAILED' ||
          statusBefore === 'COMPLETED' ||
          statusBefore === 'CANCELLED'
        ) {
          break;
        }

        // Single choke: execute + honest outcome + durable snapshot, so the
        // autonomous loop and single-step paths persist identically.
        await this.runStage(workflow, stage);

        const statusAfter = workflow.status as WorkflowStatus;
        if (
          workflow.isPaused ||
          statusAfter === 'AWAITING_CLARIFICATION' ||
          statusAfter === 'BLOCKED' ||
          statusAfter === 'FAILED' ||
          statusAfter === 'COMPLETED' ||
          statusAfter === 'CANCELLED'
        ) {
          break;
        }
      }

      return workflow;
    } finally {
      this.releaseMutex(workflowId);
    }
  }

  /**
   * Drives single stage execution for granular step-by-step control.
   */
  public async executeNextStep(workflowId: string): Promise<RelayWorkflow> {
    await this.acquireMutex(workflowId);

    try {
      const workflow = this.workflows.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow '${workflowId}' not found`);
      }

      if (workflow.status === 'COMPLETED' || workflow.status === 'CANCELLED') {
        return workflow;
      }

      const stageOrder: WorkflowStage[] = [
        'UNDERSTAND',
        'DISCOVER',
        'QUALIFY',
        'QUOTE',
        'NEGOTIATE',
        'SELECT',
        'COMMIT',
        'PAY',
        'FULFILL',
        'VERIFY',
        'ALLOCATE',
        'RECONCILE',
        'COMPLETE',
      ];

      // If in DRAFT or RECEIVED, start at UNDERSTAND
      let targetStage = workflow.currentStage;
      if (workflow.status === 'DRAFT' || workflow.status === 'RECEIVED') {
        targetStage = 'UNDERSTAND';
      } else {
        const currentIdx = stageOrder.indexOf(workflow.currentStage);
        if (currentIdx >= 0 && currentIdx < stageOrder.length - 1) {
          targetStage = stageOrder[currentIdx + 1];
        }
      }

      await this.runStage(workflow, targetStage);

      return workflow;
    } finally {
      this.releaseMutex(workflowId);
    }
  }

  /**
   * Convenience alias: executes single step.
   */
  public async executeWorkflowStep(workflowId: string): Promise<RelayWorkflow> {
    return this.executeNextStep(workflowId);
  }

  /**
   * The single choke point for stage execution: runs the stage, records the
   * honest outcome, and persists the durable snapshot — on success AND on
   * failure, so a crash or restart resumes from the latest honest status,
   * never a stale one. Both the autonomous loop and single-step execution
   * funnel through here.
   */
  private async runStage(workflow: RelayWorkflow, stage: WorkflowStage): Promise<void> {
    try {
      await this.executor.executeStage(workflow, stage);
    } finally {
      this.markStageOutcome(workflow, stage);
      await this.persistenceService.persistWorkflowSnapshot(workflow);
    }
  }

  /**
   * Records the honest outcome of a stage execution on the workflow's
   * checklist: COMPLETED only when the stage finished without halting the
   * workflow, FAILED on failure/block, IN_PROGRESS when paused for
   * clarification (the stage will re-run on resume).
   */
  private markStageOutcome(workflow: RelayWorkflow, stage: WorkflowStage): void {
    const stageItem = workflow.stages.find((s) => s.stage === stage);
    if (!stageItem) return;
    if (workflow.status === 'FAILED' || workflow.status === 'BLOCKED') {
      stageItem.status = 'FAILED';
      (stageItem as any).completed = false;
      stageItem.completedAt = undefined;
    } else if (workflow.status === 'AWAITING_CLARIFICATION' || workflow.isPaused) {
      stageItem.status = 'IN_PROGRESS';
      (stageItem as any).completed = false;
      stageItem.completedAt = undefined;
    } else {
      stageItem.status = 'COMPLETED';
      (stageItem as any).completed = true;
      stageItem.completedAt = new Date();
    }
  }

  /**
   * Resumes a paused, interrupted, or failed workflow from the latest valid checkpoint.
   */
  public async resumeWorkflow(workflowId: string, clarifiedText?: string): Promise<RelayWorkflow> {
    await this.acquireMutex(workflowId);

    try {
      const workflow = this.workflows.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow '${workflowId}' not found`);
      }

      if (clarifiedText) {
        workflow.requestText = clarifiedText;
        const newIntent = this.planner.parseIntent(clarifiedText);
        workflow.intent = newIntent;
        workflow.isPaused = false;
        workflow.pauseReason = undefined;
        if (!newIntent.isAmbiguous) {
          // Route back to UNDERSTANDING: the executor re-runs understand on
          // the amended text and produces DEMAND_CREATED authoritatively.
          transitionWorkflowStatus(workflow, 'UNDERSTANDING');
        }
        // The amended request supersedes the stale submit-time checkpoint:
        // capture it as a new checkpoint generation so recovery resumes from
        // the clarified state instead of regressing the workflow to DRAFT.
        workflow.workflowVersion += 1;
        this.checkpointService.saveCheckpoint(workflow);
      } else {
        workflow.isPaused = false;
        workflow.pauseReason = undefined;
      }

      this.recoveryService.resumeWorkflow(workflow);
    } finally {
      this.releaseMutex(workflowId);
    }

    return this.executeWorkflow(workflowId);
  }

  /**
   * Pauses an active workflow explicitly.
   */
  public pauseWorkflow(workflowId: string, reason?: string): RelayWorkflow {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow '${workflowId}' not found`);
    }

    workflow.isPaused = true;
    workflow.pauseReason = reason || 'Manual pause requested';
    workflow.updatedAt = new Date();

    this.checkpointService.saveCheckpoint(workflow);
    this.eventService.emit('WORKFLOW_PAUSED', workflow.id, workflow.currentStage, {
      reason: workflow.pauseReason,
    });
    // Sync path: fire-and-forget is safe — snapshot writes never throw.
    void this.persistenceService.persistWorkflowSnapshot(workflow);

    return workflow;
  }

  /**
   * Cancels an active in-flight workflow.
   */
  public cancelWorkflow(workflowId: string, reason?: string): RelayWorkflow {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw new Error(`Workflow '${workflowId}' not found`);
    }

    if (workflow.status === 'COMPLETED' || workflow.status === 'CANCELLED') {
      throw new Error(`Cannot cancel workflow in '${workflow.status}' status`);
    }

    transitionWorkflowStatus(workflow, 'CANCELLED');
    workflow.failureReason = reason || 'Workflow cancelled';
    workflow.updatedAt = new Date();

    this.checkpointService.saveCheckpoint(workflow);
    this.eventService.emit('WORKFLOW_CANCELLED', workflow.id, workflow.currentStage, {
      reason: workflow.failureReason,
    });
    // Sync path: fire-and-forget is safe — snapshot writes never throw.
    void this.persistenceService.persistWorkflowSnapshot(workflow);

    return workflow;
  }

  /**
   * Restores a workflow into this orchestrator from its durable record.
   * Returns the live workflow (already-registered instances are returned
   * as-is), or null when no durable record exists. Corrupt snapshots and
   * database errors throw — restores fail loudly, never resume wrong state.
   *
   * Known boundary: custom submit-time idempotency keys are not part of the
   * durable snapshot, so a restored workflow re-registers under the default
   * key form (`wf_req_<resident>_<requestText>`). Default-key resubmits
   * still dedupe after a restart; custom-key callers must track their own
   * keys across restarts.
   */
  public async restoreWorkflow(workflowId: string): Promise<RelayWorkflow | null> {
    const live = this.workflows.get(workflowId);
    if (live) {
      return live;
    }
    const restored = await this.persistenceService.loadWorkflowSnapshot(workflowId);
    if (!restored) {
      return null;
    }
    this.workflows.set(restored.id, restored);
    this.idempotencyStore.set(
      `wf_req_${restored.residentReference}_${restored.requestText}`,
      restored
    );
    return restored;
  }

  /**
   * Retrieves workflow by ID.
   */
  public getWorkflow(workflowId: string): RelayWorkflow | undefined {
    return this.workflows.get(workflowId);
  }

  /**
   * Convenience alias: retrieves workflow state.
   */
  public getWorkflowState(workflowId: string): RelayWorkflow | undefined {
    return this.getWorkflow(workflowId);
  }

  /**
   * Lists all managed workflows.
   */
  public listWorkflows(): RelayWorkflow[] {
    return Array.from(this.workflows.values());
  }

  /**
   * Returns milestone checklist progress for resident/frontend tracking.
   */
  public getWorkflowProgress(workflowId: string): WorkflowStageProgress[] {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return [];

    const checkpoints = this.checkpointService.getCheckpoints(workflowId);
    const checkpointMap = new Map<string, Date>();
    for (const c of checkpoints) {
      checkpointMap.set(c.stage, c.timestamp);
    }

    const stageOrder: WorkflowStage[] = [
      'UNDERSTAND',
      'DISCOVER',
      'QUALIFY',
      'QUOTE',
      'NEGOTIATE',
      'SELECT',
      'COMMIT',
      'PAY',
      'FULFILL',
      'VERIFY',
      'ALLOCATE',
      'RECONCILE',
      'COMPLETE',
    ];

    const currentStageIdx = stageOrder.indexOf(workflow.currentStage);

    return DEFAULT_STAGES.map((s, idx) => {
      let status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' = 'PENDING';

      const existingStage = workflow.stages?.find((item) => item.stage === s.stage);
      if (existingStage && (existingStage.status === 'COMPLETED' || existingStage.status === 'FAILED')) {
        status = existingStage.status;
      } else if (workflow.status === 'COMPLETED') {
        status = 'COMPLETED';
      } else if (
        (workflow.status === 'FAILED' || workflow.status === 'BLOCKED') &&
        (idx === currentStageIdx || s.stage === workflow.currentStage)
      ) {
        status = 'FAILED';
      } else if (idx < currentStageIdx) {
        status = 'COMPLETED';
      } else if (idx === currentStageIdx) {
        status =
          workflow.isPaused ||
          workflow.status === 'AWAITING_CLARIFICATION' ||
          workflow.status === 'CANCELLED'
            ? 'PENDING'
            : 'IN_PROGRESS';
      }

      return {
        stage: s.stage,
        label: s.label,
        status,
        completedAt: checkpointMap.get(s.stage) || existingStage?.completedAt,
      };
    });
  }

  private async acquireMutex(key: string): Promise<void> {
    while (this.mutexes.has(key)) {
      await this.mutexes.get(key);
    }
    let resolver: () => void;
    const promise = new Promise<void>((resolve) => {
      resolver = resolve;
    });
    (promise as any)._resolver = resolver!;
    this.mutexes.set(key, promise);
  }

  private releaseMutex(key: string): void {
    const promise = this.mutexes.get(key);
    if (promise) {
      this.mutexes.delete(key);
      const resolver = (promise as any)._resolver;
      if (resolver) resolver();
    }
  }
}

export const relayOrchestrator = new RelayOrchestrator();
