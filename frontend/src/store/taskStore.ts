import { create } from 'zustand';
import { taskService } from '../services/taskService';
import type { Task, TaskSummary, TaskCreate, TaskStatus, TaskQueryParams, ScheduledJob, TaskResponse } from '../types/task';
import { createRequestScope, type RequestContext } from '../services/requestLifecycle';
import { captureSession, assertSession } from '../services/authSessionService';
import { registerSessionReset, isCurrentSession } from '../utils/authSession';
import { getErrorMessage } from '../utils/errors';
interface TaskStore {
  tasks: TaskSummary[];
  currentTask: Task | null;
  scheduledJobs: ScheduledJob[];
  loading: boolean;
  error: string | null;
  queryParams: TaskQueryParams;
  setQueryParams: (params: Partial<TaskQueryParams>) => void;
  loadTasks: () => Promise<void>;
  loadTask: (taskId: string) => Promise<void>;
  createTask: (taskData: TaskCreate) => Promise<{ success: boolean; taskId?: string; message?: string }>;
  updateTaskStatus: (taskId: string, status: TaskStatus) => Promise<boolean>;
  deleteTask: (taskId: string) => Promise<boolean>;
  loadScheduledJobs: () => Promise<void>;
  reloadScheduler: () => Promise<boolean>;
  clearError: () => void;
  clearCurrentTask: () => void;
  getTaskNextRunTime: (taskId: string) => string | null;
}
const listRequest = createRequestScope(), detailRequest = createRequestScope(), jobsRequest = createRequestScope();
const busy = new Set<symbol>();
const initialState = () => ({ tasks: [], currentTask: null, scheduledJobs: [], loading: false, error: null, queryParams: { limit: 20, offset: 0, sort_by: 'created_at', sort_order: 'desc' as const } });
export const useTaskStore = create<TaskStore>((set, get) => {
  const begin = (signal?: AbortSignal) => {
    const { generation } = captureSession();
    const token = Symbol(); busy.add(token); set({ loading: true, error: null });
    const finish = () => {
      signal?.removeEventListener('abort', finish);
      if (isCurrentSession(generation) && busy.delete(token)) set({ loading: busy.size > 0 });
    };
    signal?.addEventListener('abort', finish, { once: true });
    return finish;
  };
  const read = async (context: RequestContext, operation: () => Promise<Partial<TaskStore>>) => {
    const finish = begin(context.signal);
    try { const state = await operation(); if (context.isCurrent()) set(state); }
    catch (error) { if (context.isCurrent()) set({ error: getErrorMessage(error) }); }
    finally { finish(); }
  };
  const mutate = async (operation: () => Promise<TaskResponse>, apply: () => Promise<void> | void) => {
    const { generation } = captureSession(); const finish = begin();
    try {
      const response = await operation(); assertSession(generation);
      if (response.status !== 'success') throw new Error(response.message);
      listRequest.invalidate();
      await apply();
      return response;
    } catch (error) { if (isCurrentSession(generation)) set({ error: getErrorMessage(error) }); throw error; }
    finally { finish(); }
  };
  return {
    ...initialState(),
    setQueryParams: params => { listRequest.invalidate(); detailRequest.invalidate(); set(state => ({ queryParams: { ...state.queryParams, ...params } })); },
    loadTasks: () => {
      const query = { ...get().queryParams };
      const key = JSON.stringify(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));
      return listRequest.run(key, context => read(context, async () => ({ tasks: await taskService.getTaskSummaries(query, { signal: context.signal }) })));
    },
    loadTask: id => detailRequest.run(id, context => read(context, async () => ({ currentTask: await taskService.getTask(id, { signal: context.signal }) }))),
    createTask: async data => {
      const result = await mutate(() => taskService.createTask(data), () => get().loadTasks());
      return { success: true, taskId: result.data?.task_id, message: result.message };
    },
    updateTaskStatus: async (id, status) => {
      await mutate(() => taskService.updateTaskStatus(id, { status }), () => {
        if (get().currentTask?.id === id) detailRequest.invalidate();
        set(state => ({ tasks: state.tasks.map(task => task.id === id ? { ...task, status } : task), currentTask: state.currentTask?.id === id ? { ...state.currentTask, status } : state.currentTask }));
      });
      return true;
    },
    deleteTask: async id => {
      await mutate(() => taskService.deleteTask(id), () => {
        if (get().currentTask?.id === id) get().clearCurrentTask();
        set(state => ({ tasks: state.tasks.filter(task => task.id !== id) }));
      });
      return true;
    },
    loadScheduledJobs: () => jobsRequest.run('jobs', context => read(context, async () => ({ scheduledJobs: await taskService.getScheduledJobs({ signal: context.signal }) }))),
    reloadScheduler: async () => {
      await mutate(() => taskService.reloadScheduler(), () => { jobsRequest.invalidate(); return get().loadScheduledJobs(); });
      return true;
    },
    clearError: () => set({ error: null }),
    clearCurrentTask: () => { detailRequest.invalidate(); set({ currentTask: null }); },
    getTaskNextRunTime: id => get().scheduledJobs.find(job => job.id === id)?.next_run_time ?? null,
  };
});
registerSessionReset(() => { listRequest.invalidate(); detailRequest.invalidate(); jobsRequest.invalidate(); busy.clear(); useTaskStore.setState(initialState()); });
