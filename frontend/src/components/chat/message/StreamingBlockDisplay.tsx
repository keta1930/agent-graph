// 流式块显示组件
import React from 'react';
import { StreamingBlock } from '../../../types/conversation';
import ReasoningDisplay from './ReasoningDisplay';
import SmartMarkdown from './SmartMarkdown';
import ToolCallDisplay from './ToolCallDisplay';
import NodeExecutionInfo from './NodeExecutionInfo';
import { parseToolResults } from './messageUtils';

interface StreamingBlockDisplayProps {
  block: StreamingBlock;
  renderingMode: 'agent' | 'graph';
  toolResults?: Record<string, string>;
  conversationId?: string;
}

/**
 * 流式块显示组件
 * 根据块类型渲染不同的内容
 */
const StreamingBlockDisplay: React.FC<StreamingBlockDisplayProps> = ({
  block,
  toolResults = {},
  conversationId
}) => {
  switch (block.type) {
    case 'reasoning':
      return <ReasoningDisplay content={block.content} isStreaming={!block.isComplete} conversationId={conversationId} />;

    case 'content':
      return (
        <div>
          <div style={{ position: 'relative' }}>
            <SmartMarkdown
              content={block.content}
              isStreaming={!block.isComplete}
              conversationId={conversationId}
            />
            {!block.isComplete && (
              <span style={{
                marginLeft: '2px',
                color: '#b85845',
                fontWeight: 'bold',
                animation: 'typingCursor 1s infinite'
              }}>▋</span>
            )}
          </div>
        </div>
      );

    case 'tool_calls': {
      const combinedToolResults = { ...toolResults, ...parseToolResults(block.content) };

      return (
        <div className="tool-calls-block">
          {block.toolCalls?.map((toolCall, index) => (
            <ToolCallDisplay
              key={toolCall.id || index}
              toolCall={toolCall}
              result={toolCall.id ? combinedToolResults[toolCall.id] : undefined}
              conversationId={conversationId}
              isStreaming={!block.isComplete}
            />
          ))}
        </div>
      );

    }
    case 'node_start':
      // 渲染节点信息
      if (block.nodeInfo) {
        return (
          <NodeExecutionInfo
            nodeName={block.nodeInfo.nodeName}
            level={block.nodeInfo.level}
            status={block.nodeInfo.status}
          />
        );
      }
      return null;

    case 'task':
      // 任务容器由父级根据 taskId 分组展示。
      return null;
  }
};

export default React.memo(StreamingBlockDisplay);
