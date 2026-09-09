// src/store/agentStore.ts
import { create } from 'zustand';
import { createRequestScope } from '../services/requestLifecycle';
import { registerSessionReset } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
import * as agentService from '../services/agentService';
import { AgentListItem } from '../services/agentService';

interface AgentState {
  agents: AgentListItem[];
  loading: boolean;
  error?: string;

  fetchAgents: () => Promise<void>;
}

const request = createRequestScope();

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  loading: false,
  error: undefined,

  fetchAgents: () => request.run('all', async context => {
    set({ loading: true, error: undefined });
    try {
      const response = await agentService.listAllAgents(undefined, { signal: context.signal });
      if (context.isCurrent()) set({ agents: response.agents });
    } catch (error) {
      if (context.isCurrent()) set({ error: getErrorMessage(error) });
    } finally { if (context.isCurrent()) set({ loading: false }); }
  }),
}));
registerSessionReset(() => { request.invalidate(); useAgentStore.setState({ agents: [], loading: false, error: undefined }); });
