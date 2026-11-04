import { apiClient } from './client';
import { AgentRunRequest, AgentRunResponse } from '@/types';
import type { ProcurementRun } from '../workflow/types';

export async function runAgent(payload: AgentRunRequest): Promise<AgentRunResponse> {
  return apiClient<AgentRunResponse>('/api/agent/run', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 120000,
  });
}

export async function fetchWorkflowRun(id: string): Promise<ProcurementRun> {
  const res = await apiClient<{ success: boolean; data: ProcurementRun }>(
    `/api/agent/workflow/${encodeURIComponent(id)}`,
    {
      method: 'GET',
    }
  );
  return res.data;
}
