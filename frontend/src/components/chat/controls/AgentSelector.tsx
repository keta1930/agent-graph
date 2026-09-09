// src/components/chat/controls/AgentSelector.tsx
import React, { useState, useEffect } from 'react';
import { Spin, message } from 'antd';
import { AgentListItem, AgentCategoryItem } from '../../../services/agentService';
import { listAllAgents, listCategories } from '../../../services/agentService';
import AgentList from './AgentList';
import { getSessionGeneration, isCurrentSession } from '../../../utils/authSession';

/**
 * Agent 选择器组件属性
 */
interface AgentSelectorProps {
  /** 当前选中的 Agent 名称 */
  selectedAgent?: string | null;
  /** Agent 选择回调 */
  onAgentSelect: (agentName: string | null) => void;
}

/**
 * Agent 选择器组件
 * 
 * 从列表中选择预配置的 Agent
 */
const AgentSelector: React.FC<AgentSelectorProps> = ({
  selectedAgent,
  onAgentSelect
}) => {
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [categories, setCategories] = useState<AgentCategoryItem[]>([]);
  const [loading, setLoading] = useState(false);

  // 加载 Agent 列表和分类
  useEffect(() => {
    const controller = new AbortController();
    const session = getSessionGeneration();
    const isCurrent = () => !controller.signal.aborted && isCurrentSession(session);
    const loadData = async () => {
      setLoading(true);
      try {
        const [agentsResponse, categoriesResponse] = await Promise.all([
          listAllAgents(undefined, { signal: controller.signal }),
          listCategories({ signal: controller.signal })
        ]);
        if (!isCurrent()) return;
        setAgents(agentsResponse.agents);
        setCategories(categoriesResponse.categories);
      } catch (error) {
        if (!isCurrent()) return;
        console.error('加载 Agent 数据失败:', error);
        message.error('加载 Agent 列表失败');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };
    void loadData();
    return () => controller.abort();
  }, []);

  return (
    <div style={{ 
      width: '100%', 
      height: '100%', 
      display: 'flex', 
      flexDirection: 'column',
      background: '#faf8f5'
    }}>
      {loading ? (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '300px',
          gap: '12px'
        }}>
          <Spin size="large" />
          <div style={{
            fontSize: '13px',
            color: 'rgba(45, 45, 45, 0.65)',
            letterSpacing: '0.3px'
          }}>
            加载中...
          </div>
        </div>
      ) : (
        <div style={{ 
          height: '100%', 
          overflowY: 'auto',
          padding: '16px'
        }}>
          <AgentList
            agents={agents}
            categories={categories}
            selectedAgent={selectedAgent}
            onSelect={onAgentSelect}
          />
        </div>
      )}
    </div>
  );
};

export default AgentSelector;
