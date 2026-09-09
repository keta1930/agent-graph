import { useState, useRef, useEffect } from 'react';
import { App, message } from 'antd';
import { useT } from '../i18n/hooks';

interface AgentGroup {
  category: string;
  agents: Array<{
    name: string;
    tags?: string[];
  }>;
}

/**
 * 批量删除智能体的自定义 Hook
 */
export const useAgentBatchDelete = (
  filteredGroups: AgentGroup[],
  deleteAgents: (names: string[]) => Promise<{ succeededIds: string[]; failed: { id: string; message: string }[] }>
) => {
  const t = useT();
  const { modal } = App.useApp();
  const [visible, setVisible] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  /**
   * 打开批量删除抽屉
   */
  const openDrawer = () => {
    setVisible(true);
  };

  /**
   * 关闭批量删除抽屉
   */
  const closeDrawer = () => {
    setVisible(false);
    setSelectedAgents([]);
  };

  /**
   * 切换选中状态
   */
  const toggleSelection = (agentName: string) => {
    setSelectedAgents(prev =>
      prev.includes(agentName)
        ? prev.filter(name => name !== agentName)
        : [...prev, agentName]
    );
  };

  /**
   * 全选/取消全选
   */
  const toggleSelectAll = () => {
    const allAgentNames = filteredGroups.flatMap(group => 
      group.agents.map(agent => agent.name)
    );
    if (selectedAgents.length === allAgentNames.length && allAgentNames.length > 0) {
      setSelectedAgents([]);
    } else {
      setSelectedAgents(allAgentNames);
    }
  };

  /**
   * 执行批量删除
   */
  const confirmDelete = async () => {
    if (selectedAgents.length === 0) {
      message.warning(t('pages.agentManager.batchDelete.selectWarning'));
      return;
    }

    modal.confirm({
      title: t('pages.agentManager.batchDelete.confirmTitle'),
      content: t('pages.agentManager.batchDelete.confirmMessage', { 
        count: selectedAgents.length 
      }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (pending.current) return;
        pending.current = true;
        setDeleting(true);
        try {
          const result = await deleteAgents(selectedAgents);
          if (!mounted.current) return;
          setSelectedAgents(current => current.filter(name => !result.succeededIds.includes(name)));
          if (!result.failed.length) setVisible(false);
          if (result.failed.length === 0) {
            message.success(t('pages.agentManager.batchDelete.success', { count: result.succeededIds.length }));
          } else {
            message.warning(t('pages.agentManager.batchDelete.partial', { success: result.succeededIds.length, failed: result.failed.length }));
          }
        } catch {
          if (mounted.current) message.warning(t('pages.agentManager.batchDelete.partial', { success: 0, failed: selectedAgents.length }));
        } finally {
          pending.current = false;
          if (mounted.current) setDeleting(false);
        }
      }
    });
  };

  return {
    visible,
    selectedAgents,
    deleting,
    openDrawer,
    closeDrawer,
    toggleSelection,
    toggleSelectAll,
    confirmDelete
  };
};
