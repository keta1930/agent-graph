import { getErrorMessage } from '../utils/errors';
import { getSessionGeneration, isCurrentSession } from '../utils/authSession';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { App } from 'antd';
import {
  listAllAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgent,
  listCategories,
  AgentConfig,
  AgentListItem,
  AgentCategoryItem
} from '../services/agentService';
import { getModels } from '../services/modelService';
import { listSystemTools, ToolCategory } from '../services/systemToolsService';
import { getMCPConfig } from '../services/mcpService';
import { useT } from '../i18n/hooks';

interface CategoryGroup {
  category: string;
  agents: AgentListItem[];
}

/**
 * Agent Manager 数据管理 Hook
 * 封装所有数据加载、CRUD 操作和搜索过滤逻辑
 */
export const useAgentManager = () => {
  const t = useT();
  const { message } = App.useApp();

  // 状态管理
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState('');

  // 可选项数据
  const [models, setModels] = useState<string[]>([]);
  const [systemTools, setSystemTools] = useState<string[]>([]);
  const [systemToolCategories, setSystemToolCategories] = useState<ToolCategory[]>([]);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [categories, setCategories] = useState<AgentCategoryItem[]>([]);

  // 分组数据
  const request = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current += 1; listController.current?.abort(); }; }, []);

  /**
   * 按分类分组 Agents
   */
  const groupAgentsByCategory = useCallback((agentList: AgentListItem[]): CategoryGroup[] => {
    const groupMap = new Map<string, CategoryGroup>();

    agentList.forEach(agent => {
      const category = agent.category || '';
      if (!groupMap.has(category)) {
        groupMap.set(category, {
          category,
          agents: []
        });
      }
      groupMap.get(category)!.agents.push(agent);
    });

    return Array.from(groupMap.values()).sort((a, b) => a.category.localeCompare(b.category));
  }, []);

  /**
   * 加载 Agents 列表
   */
  const loadAgents = useCallback(async () => {
    const owner = ++request.current;
    listController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    const session = getSessionGeneration();
    const isCurrent = () => mounted.current && owner === request.current && isCurrentSession(session) && !controller.signal.aborted;
    setLoading(true);
    try {
      const response = await listAllAgents(undefined, { signal: controller.signal });
      if (!isCurrent()) return;
      setAgents(response.agents || []);
    } catch (error) {
      if (!isCurrent()) return;
      const errorDetail = getErrorMessage(error, t('errors.serverError'));
      message.error(t('pages.agentManager.loadFailed', { error: errorDetail }));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [t, message]);

  /**
   * 加载所有选项数据（模型、工具、MCP服务器、分类）
   */
  const loadOptions = useCallback(async () => {
    try {
      const [modelResponse, toolsResponse, mcpResponse, categoriesResponse] = await Promise.all([
        getModels(),
        listSystemTools(),
        getMCPConfig(),
        listCategories()
      ]);

      if (!mounted.current) return;
      setModels(modelResponse.map(m => m.name));
      const allTools = toolsResponse.categories.flatMap(cat => cat.tools.map(tool => tool.name));
      setSystemTools(allTools);
      setSystemToolCategories(toolsResponse.categories || []);
      setMcpServers(Object.keys(mcpResponse.mcpServers || {}));
      setCategories(categoriesResponse.categories || []);
    } catch (error) {
      console.error('加载选项失败:', error);
    }
  }, []);

  /**
   * 创建 Agent
   */
  const handleCreateAgent = useCallback(async (agentConfig: AgentConfig) => {
    try {
      await createAgent(agentConfig);
      if (!mounted.current) return false;
      message.success(t('pages.agentManager.createSuccess', { name: agentConfig.name }));
      await loadAgents();
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      const errorDetail = getErrorMessage(error, t('errors.serverError'));
      message.error(t('pages.agentManager.operationFailed', { error: errorDetail }));
      return false;
    }
  }, [t, message, loadAgents]);

  /**
   * 更新 Agent
   */
  const handleUpdateAgent = useCallback(async (agentName: string, agentConfig: AgentConfig) => {
    try {
      await updateAgent(agentName, agentConfig);
      if (!mounted.current) return false;
      message.success(t('pages.agentManager.updateSuccess', { name: agentName }));
      await loadAgents();
      return true;
    } catch (error) {
      const errorDetail = getErrorMessage(error, t('errors.serverError'));
      message.error(t('pages.agentManager.operationFailed', { error: errorDetail }));
      return false;
    }
  }, [t, message, loadAgents]);

  /**
   * 删除 Agent
   */
  const handleDeleteAgent = useCallback(async (agentName: string) => {
    try {
      await deleteAgent(agentName);
      if (!mounted.current) return false;
      message.success(t('pages.agentManager.deleteSuccess', { name: agentName }));
      await loadAgents();
      return true;
    } catch (error) {
      const errorDetail = getErrorMessage(error, t('errors.serverError'));
      message.error(t('pages.agentManager.deleteFailed', { error: errorDetail }));
      return false;
    }
  }, [t, message, loadAgents]);

  /**
   * 获取 Agent 详情
   */
  const fetchAgentDetail = useCallback(async (agentName: string) => {
    try {
      const response = await getAgent(agentName);
      if (!mounted.current) return null;
      return response.agent;
    } catch (error) {
      const errorDetail = getErrorMessage(error, t('errors.serverError'));
      message.error(t('pages.agentManager.loadDetailFailed', { error: errorDetail }));
      return null;
    }
  }, [t, message]);

  // 初始化加载
  useEffect(() => {
    loadAgents();
    loadOptions();
  }, [loadAgents, loadOptions]);

  const groupedAgents = useMemo(() => groupAgentsByCategory(agents), [agents, groupAgentsByCategory]);
  const filteredGroups = useMemo(() => {
    const keyword = searchText.trim().toLowerCase();
    return groupedAgents.map(group => ({
      ...group,
      agents: group.agents.filter(agent => agent.name.toLowerCase().includes(keyword)
        || agent.category.toLowerCase().includes(keyword)
        || agent.tags?.some(tag => tag.toLowerCase().includes(keyword))),
    })).filter(group => group.agents.length > 0);
  }, [groupedAgents, searchText]);

  const handleBatchDelete = useCallback(async (names: string[]) => {
    const succeededIds: string[] = [];
    const failed: { id: string; message: string }[] = [];
    for (const name of names) {
      if (!mounted.current) break;
      try { await deleteAgent(name); succeededIds.push(name); }
      catch (error) { failed.push({ id: name, message: getErrorMessage(error) }); }
    }
    if (mounted.current && succeededIds.length) {
      setAgents(current => current.filter(agent => !succeededIds.includes(agent.name)));
      await loadAgents();
    }
    return { succeededIds, failed };
  }, [loadAgents]);

  return {
    // 状态
    agents,
    loading,
    searchText,
    filteredGroups,

    // 选项数据
    models,
    systemTools,
    systemToolCategories,
    mcpServers,
    categories,

    // 操作方法
    setSearchText,
    loadAgents,
    handleCreateAgent,
    handleUpdateAgent,
    handleDeleteAgent,
    handleBatchDelete,
    fetchAgentDetail,
  };
};
