import { create } from 'zustand';
import type { ModelConfig } from '../types/model';
import * as modelService from '../services/modelService';
import { createRequestScope } from '../services/requestLifecycle';
import { assertSession, captureSession } from '../services/authSessionService';
import { isCurrentSession, registerSessionReset } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
interface ModelState {
  models: ModelConfig[];
  loading: boolean;
  error?: string;
  fetchModels: () => Promise<void>;
  addModel: (model: ModelConfig) => Promise<void>;
  updateModel: (modelName: string, model: ModelConfig) => Promise<void>;
  deleteModel: (modelName: string) => Promise<void>;
}
const request = createRequestScope();
let mutations = 0;
export const useModelStore = create<ModelState>((set, get) => {
  const mutate = async (operation: () => Promise<unknown>) => {
    const { generation } = captureSession();
    mutations += 1;
    request.invalidate();
    set({ loading: true, error: undefined });
    try {
      await operation();
      assertSession(generation);
      request.invalidate();
      await get().fetchModels();
    } catch (error) {
      if (isCurrentSession(generation)) set({ error: getErrorMessage(error) });
      throw error;
    } finally {
      if (isCurrentSession(generation)) { mutations -= 1; set({ loading: mutations > 0 }); }
    }
  };
  return {
    models: [], loading: false, error: undefined,
    fetchModels: () => request.run('all', async context => {
      set({ loading: true, error: undefined });
      try {
        const models = await modelService.getModels({ signal: context.signal });
        if (context.isCurrent()) set({ models });
      } catch (error) {
        if (context.isCurrent()) set({ error: getErrorMessage(error, 'Failed to fetch models') });
      } finally { if (context.isCurrent()) set({ loading: mutations > 0 }); }
    }),
    addModel: model => mutate(() => modelService.addModel(model)),
    updateModel: (name, model) => mutate(() => modelService.updateModel(name, model)),
    deleteModel: name => mutate(() => modelService.deleteModel(name)),
  };
});
registerSessionReset(() => { request.invalidate(); mutations = 0; useModelStore.setState({ models: [], loading: false, error: undefined }); });
