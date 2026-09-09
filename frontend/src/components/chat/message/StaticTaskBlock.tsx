// src/components/chat/message/StaticTaskBlock.tsx
import React, { useState } from 'react';
import { Tag } from 'antd';
import { ChevronDown, ChevronRight, CheckCircle } from 'lucide-react';
import { TaskData } from '../../../types/conversation';
import SmartMarkdown from './SmartMarkdown';
import ReasoningDisplay from './ReasoningDisplay';
import ToolCallDisplay from './ToolCallDisplay';
import { useT } from '../../../i18n/hooks';
import './TaskBlock.css';

interface StaticTaskBlockProps {
  taskData: TaskData;
  toolCallId: string;
  toolResults?: Record<string, string>;
  conversationId?: string;
}

const StaticTaskBlock: React.FC<StaticTaskBlockProps> = ({
  taskData,
  toolCallId,
  toolResults = {},
  conversationId
}) => {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  // 找到对应的 round
  const currentRound = taskData.rounds.find(r => r.tool_call_id === toolCallId);
  
  if (!currentRound) {
    return null;
  }

  // 构建工具结果映射（从 round 的 messages 中）
  const roundToolResults: Record<string, string> = { ...toolResults };
  currentRound.messages.forEach(msg => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      roundToolResults[msg.tool_call_id] = msg.content || '';
    }
  });

  return (
    <div 
      className="task-block-container"
      data-task-status="completed"
      style={{ marginTop: '12px' }}
    >
      <div
        className="task-block-header"
        onClick={() => setExpanded(!expanded)}
        style={{
          borderColor: 'rgba(160, 130, 109, 0.2)',
          background: 'rgba(245, 243, 240, 0.6)'
        }}
      >
        <div className="task-block-header-left">
          <div 
            className="task-status-indicator"
            style={{ background: '#a0826d' }} 
          />
          <CheckCircle size={16} className="task-status-icon completed" />
          <span className="task-id">Task {taskData.task_id}</span>
          <Tag
            className="task-status-tag"
            style={{
              background: 'rgba(160, 130, 109, 0.08)',
              color: '#a0826d',
              border: '1px solid rgba(160, 130, 109, 0.25)'
            }}
          >
            {t('components.taskBlock.statusCompleted')}
          </Tag>
          <Tag style={{
            background: 'rgba(184, 88, 69, 0.08)',
            color: '#b85845',
            border: '1px solid rgba(184, 88, 69, 0.2)',
            borderRadius: '6px',
            fontWeight: 500,
            padding: '2px 10px',
            fontSize: '12px'
          }}>
            {taskData.agent_name}
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
          {currentRound.messages.map((message, msgIndex) => {
            // 跳过 system 和 tool 消息
            if (message.role === 'system' || message.role === 'tool') {
              return null;
            }

            return (
              <div key={msgIndex} className="task-message-block">
                {/* 思考过程 */}
                {message.reasoning_content && (
                  <ReasoningDisplay content={message.reasoning_content} />
                )}
                
                {/* 消息正文 */}
                {message.content && (
                  <div style={{
                    color: '#2d2d2d',
                    lineHeight: '1.7',
                    fontSize: '16px',
                    letterSpacing: '0.3px',
                    fontFamily: "Cambria, Georgia, 'Times New Roman', serif, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', serif"
                  }}>
                    <SmartMarkdown content={message.content} conversationId={conversationId} />
                  </div>
                )}
                
                {/* 工具调用 */}
                {message.tool_calls && message.tool_calls.length > 0 && (
                  <div>
                    {message.tool_calls.map((toolCall, index) => (
                      <ToolCallDisplay
                        key={toolCall.id || index}
                        toolCall={toolCall}
                        conversationId={conversationId}
                        result={toolCall.id ? roundToolResults[toolCall.id] : undefined}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default React.memo(StaticTaskBlock);
