import { memo, useMemo } from 'react';
import type { ConversationDetail, EnhancedStreamingState } from '../../../types/conversation';
import HistoryMessages from './HistoryMessages';
import GraphSummary from './GraphSummary';
import MessageItem from './MessageItem';
import StreamingMessages from './StreamingMessages';
import { buildToolResultsMap, buildTaskRoundDataMap } from './messageUtils';
import './MessageDisplay.css';

interface MessageDisplayProps {
  conversation: ConversationDetail;
  enhancedStreamingState?: EnhancedStreamingState;
  pendingUserMessage?: string | null;
  currentMode?: string;
  agentType?: string;
}

/** 按历史和流式数据的引用分别更新消息。 */
const MessageDisplay = memo(function MessageDisplay({ conversation, enhancedStreamingState, pendingUserMessage, currentMode }: MessageDisplayProps) {
  const renderingMode = currentMode === 'agent' || currentMode === 'graph' ? currentMode : conversation.type;
  const toolResults = useMemo(() => buildToolResultsMap(conversation.rounds), [conversation.rounds]);
  const taskRoundDataMap = useMemo(() => buildTaskRoundDataMap(conversation.tasks), [conversation.tasks]);
  const pendingMessage = useMemo(() => ({ role: 'user' as const, content: pendingUserMessage ?? '' }), [pendingUserMessage]);

  return (
    <div className="message-display" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(139, 115, 85, 0.3) transparent' }}>
      <div className="messages-container">
        <HistoryMessages
          key={conversation.conversation_id}
          rounds={conversation.rounds}
          toolResults={toolResults}
          taskRoundDataMap={taskRoundDataMap}
          renderingMode={renderingMode}
          conversationId={conversation.conversation_id}
        />
        {pendingUserMessage && renderingMode !== 'graph' && (
          <div className="pending-user-message">
            <MessageItem message={pendingMessage} isFirstMessageInRound renderingMode={renderingMode} conversationId={conversation.conversation_id} />
          </div>
        )}
        {enhancedStreamingState && (
          <StreamingMessages state={enhancedStreamingState} renderingMode={renderingMode} toolResults={toolResults} conversationId={conversation.conversation_id} />
        )}
        {renderingMode === 'graph' && <GraphSummary executionChain={conversation.execution_chain} finalResult={conversation.final_result} />}
      </div>
    </div>
  );
});

export default MessageDisplay;
