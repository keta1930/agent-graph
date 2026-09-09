import { memo, useMemo } from 'react';
import type { EnhancedStreamingState, StreamingBlock } from '../../../types/conversation';
import TaskBlock from './TaskBlock';
import StreamingBlockDisplay from './StreamingBlockDisplay';
import { groupTaskBlocks, isTaskBlock } from './messageUtils';

const emptyBlocks: StreamingBlock[] = [];
interface StreamingMessagesProps {
  state: EnhancedStreamingState;
  renderingMode: 'agent' | 'graph';
  toolResults: Record<string, string>;
  conversationId: string;
}

const StreamingMessages = memo(function StreamingMessages({ state, renderingMode, toolResults, conversationId }: StreamingMessagesProps) {
  const taskGroups = useMemo(() => groupTaskBlocks(state.blocks), [state.blocks]);
  if (!state.isStreaming && state.blocks.length === 0) return null;
  return (
    <div style={{
      marginBottom: '24px',
      color: '#2d2d2d',
      lineHeight: '1.7',
      fontSize: '16px',
      letterSpacing: '0.3px',
      fontFamily: "Cambria, Georgia, 'Times New Roman', serif, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', serif"
    }}>
      {/* 呼吸灯指示器 */}
      {renderingMode !== 'graph' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          marginBottom: '10px',
          gap: '8px'
        }}>
          <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: '#b85845',
            boxShadow: '0 0 0 0 rgba(184, 88, 69, 0.4)',
            animation: state.isStreaming ? 'inkDotPulse 2s ease-in-out infinite' : 'none'
          }} />
          <span style={{
            fontSize: '13px',
            fontWeight: 500,
            color: 'rgba(45, 45, 45, 0.65)',
            letterSpacing: '0.3px'
          }}>
            {renderingMode === 'agent' ? 'Agent' : 'Assistant'}
          </span>
        </div>
      )}

      {/* 分块内容 */}
      {state.blocks.map((block: StreamingBlock) => {
        if (isTaskBlock(block)) {
          const taskBlock = block;
          const taskBlocks = taskGroups.get(taskBlock.taskId) ?? emptyBlocks;

          return (
            <div key={block.id} className="streaming-block task-block">
              <TaskBlock
                taskBlock={taskBlock}
                blocks={taskBlocks}
                renderingMode={renderingMode}
                toolResults={toolResults}
                conversationId={conversationId}
              />
            </div>
          );
        }

        if (block.taskId) {
          return null;
        }

        return (
          <div key={block.id} className={`streaming-block ${block.type}-block`}>
            <StreamingBlockDisplay
              block={block}
              renderingMode={renderingMode}
              toolResults={toolResults}
              conversationId={conversationId}
            />
          </div>
        );
      })}
    </div>
  );
});

export default StreamingMessages;
