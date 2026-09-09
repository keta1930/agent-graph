// src/components/chat/message/TaskBlock.tsx
import React, { useState, useEffect } from 'react';
import { Tag } from 'antd';
import { ChevronDown, ChevronRight, CheckCircle, XCircle, Loader } from 'lucide-react';
import { TaskBlock as TaskBlockType, StreamingBlock } from '../../../types/conversation';
import StreamingBlockDisplay from './StreamingBlockDisplay';
import { useT } from '../../../i18n/hooks';
import './TaskBlock.css';

interface TaskBlockProps {
  taskBlock: TaskBlockType;
  blocks: StreamingBlock[];
  renderingMode: 'agent' | 'graph';
  toolResults?: Record<string, string>;
  conversationId?: string;
}

const TaskBlock: React.FC<TaskBlockProps> = ({
  taskBlock,
  blocks,
  renderingMode,
  toolResults = {},
  conversationId
}) => {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [showCompletionFeedback, setShowCompletionFeedback] = useState(false);

  // 终态反馈独立计时，不改变用户的展开选择。
  useEffect(() => {
    if (taskBlock.taskStatus === 'completed' || taskBlock.taskStatus === 'failed') {
      setShowCompletionFeedback(true);

      const timer = setTimeout(() => {
        setShowCompletionFeedback(false);
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [taskBlock.taskStatus]);

  const getStatusIcon = () => {
    switch (taskBlock.taskStatus) {
      case 'running':
        return <Loader size={16} className="task-status-icon running" />;
      case 'completed':
        return <CheckCircle size={16} className="task-status-icon completed" />;
      case 'failed':
        return <XCircle size={16} className="task-status-icon failed" />;
    }
  };

  const getStatusColor = () => {
    switch (taskBlock.taskStatus) {
      case 'running':
        return '#b85845';
      case 'completed':
        return '#a0826d';
      case 'failed':
        return '#d4574d';
    }
  };

  const getStatusText = () => {
    switch (taskBlock.taskStatus) {
      case 'running':
        return t('components.taskBlock.statusRunning');
      case 'completed':
        return t('components.taskBlock.statusCompleted');
      case 'failed':
        return t('components.taskBlock.statusFailed');
    }
  };

  return (
    <div
      className={`task-block-container ${showCompletionFeedback ? 'task-completed-feedback' : ''}`}
      data-task-status={taskBlock.taskStatus}
    >
      <div
        className="task-block-header"
        onClick={() => setExpanded(!expanded)}
        style={{
          borderColor: `rgba(${taskBlock.taskStatus === 'running' ? '184, 88, 69' : taskBlock.taskStatus === 'completed' ? '160, 130, 109' : '212, 87, 77'}, 0.2)`,
          background: showCompletionFeedback
            ? taskBlock.taskStatus === 'completed'
              ? 'rgba(160, 130, 109, 0.12)'
              : 'rgba(212, 87, 77, 0.12)'
            : 'rgba(245, 243, 240, 0.6)'
        }}
      >
        <div className="task-block-header-left">
          <div
            className={`task-status-indicator ${taskBlock.taskStatus === 'running' ? 'running' : ''}`}
            style={{ background: getStatusColor() }}
          />
          {getStatusIcon()}
          <span className="task-id">{t('components.taskBlock.taskLabel')} {taskBlock.taskId}</span>
          <Tag
            className="task-status-tag"
            style={{
              background: `rgba(${taskBlock.taskStatus === 'running' ? '184, 88, 69' : taskBlock.taskStatus === 'completed' ? '160, 130, 109' : '212, 87, 77'}, 0.08)`,
              color: getStatusColor(),
              border: `1px solid rgba(${taskBlock.taskStatus === 'running' ? '184, 88, 69' : taskBlock.taskStatus === 'completed' ? '160, 130, 109' : '212, 87, 77'}, 0.25)`
            }}
          >
            {getStatusText()}
          </Tag>
        </div>
        <div className="task-block-header-right">
          {expanded ? (
            <ChevronDown size={18} strokeWidth={1.5} style={{ color: '#8b7355' }} />
          ) : (
            <ChevronRight size={18} strokeWidth={1.5} style={{ color: '#8b7355' }} />
          )}
        </div>
      </div>

      {expanded && (
        <div className="task-block-content">
          {taskBlock.taskStatus === 'failed' && taskBlock.content && blocks.length > 0 && (
            <div role="alert" className="task-empty-state">{taskBlock.content}</div>
          )}
          {blocks.length > 0 ? (
            blocks.map((block) => (
              <div key={block.id} className="task-message-block">
                <StreamingBlockDisplay block={block} renderingMode={renderingMode} toolResults={toolResults} conversationId={conversationId} />
              </div>
            ))
          ) : (
            <div className="task-empty-state">
              {taskBlock.taskStatus === 'running' ? t('components.taskBlock.executing') : taskBlock.content || t('components.taskBlock.noContent')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default React.memo(TaskBlock);
