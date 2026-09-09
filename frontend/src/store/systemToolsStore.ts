// src/store/systemToolsStore.ts
import { create } from 'zustand';
import { createRequestScope } from '../services/requestLifecycle';
import { registerSessionReset } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
import * as systemToolsService from '../services/systemToolsService';

interface SystemToolsState {
  systemTools: string[];
  loading: boolean;
  error?: string;

  fetchSystemTools: () => Promise<void>;
}

const request = createRequestScope();

export const useSystemToolsStore = create<SystemToolsState>((set) => ({
  systemTools: [],
  loading: false,
  error: undefined,

  fetchSystemTools: () => request.run('all', async context => {
    set({ loading: true, error: undefined });
    try {
      const response = await systemToolsService.listSystemTools({ signal: context.signal });
      if (context.isCurrent()) set({ systemTools: response.categories.flatMap(category => category.tools.map(tool => tool.name)) });
    } catch (error) {
      if (context.isCurrent()) set({ error: getErrorMessage(error) });
    } finally { if (context.isCurrent()) set({ loading: false }); }
  }),
}));
registerSessionReset(() => { request.invalidate(); useSystemToolsStore.setState({ systemTools: [], loading: false, error: undefined }); });
