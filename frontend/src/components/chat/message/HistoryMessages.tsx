import { memo } from 'react';
import { Tag } from 'antd';
import type { ConversationRound, ConversationMessage, TaskRoundData } from '../../../types/conversation';
import MessageItem from './MessageItem';
import NodeExecutionInfo from './NodeExecutionInfo';

interface HistoryMessagesProps {
  rounds: ConversationRound[];
  toolResults: Record<string, string>;
  taskRoundDataMap: Record<string, TaskRoundData>;
  renderingMode: 'agent' | 'graph';
  conversationId: string;
}

/** 历史数据保持引用时跳过流式增量产生的更新。 */
const HistoryMessages = memo(function HistoryMessages({ rounds, toolResults, taskRoundDataMap, renderingMode, conversationId }: HistoryMessagesProps) {
  // 渲染Graph执行模式的round
  const renderGraphRound = (round: ConversationRound, roundIndex: number) => {
    const nodeInfo = {
      nodeName: round.node_name || `节点${roundIndex + 1}`,
      level: round.level || 0,
      outputEnabled: round.output_enabled,
      mcpServers: round.mcp_servers,
      status: 'completed' as const
    };

    const isStartNode = nodeInfo.nodeName === 'start';
    const userMessages = round.messages?.filter((msg: ConversationMessage) => msg.role === 'user') || [];
    const nonUserMessages = round.messages?.filter((msg: ConversationMessage) => msg.role !== 'user') || [];

    return (
      <div key={roundIndex} className="node-round">
        {isStartNode && userMessages.length > 0 ? (
          userMessages.map((message: ConversationMessage, msgIndex: number) => (
            <MessageItem
              key={`${roundIndex}-user-${msgIndex}`}
              message={message}
              toolResults={toolResults}
              taskRoundDataMap={taskRoundDataMap}
              nodeInfo={nodeInfo}
              isGraphMode={true}
              renderingMode={renderingMode}
              conversationId={conversationId}
            />
          ))
        ) : (
          <NodeExecutionInfo {...nodeInfo} />
        )}

        {nonUserMessages.map((message: ConversationMessage, msgIndex: number) => (
          <MessageItem
            key={`${roundIndex}-${msgIndex}`}
            message={message}
            toolResults={toolResults}
            taskRoundDataMap={taskRoundDataMap}
            nodeInfo={undefined}
            isGraphMode={true}
            renderingMode={renderingMode}
            conversationId={conversationId}
          />
        ))}
      </div>
    );
  };

  // 渲染Chat/Agent模式的round
  const renderChatRound = (round: ConversationRound, roundIndex: number) => {
    const displayedRoles = new Set<ConversationMessage['role']>();
    return (
      <div key={roundIndex} className="conversation-round">
        {round.messages?.map((message: ConversationMessage, msgIndex: number) => {
          const isFirstMessageOfRole = message.role !== 'system' && message.role !== 'tool' && !displayedRoles.has(message.role);
          displayedRoles.add(message.role);

          return (
            <MessageItem
              key={`${roundIndex}-${msgIndex}`}
              message={message}
              toolResults={toolResults}
              taskRoundDataMap={taskRoundDataMap}
              isFirstMessageInRound={isFirstMessageOfRole}
              renderingMode={renderingMode}
              conversationId={conversationId}
            />
          );
        })}

        {/* Agent 元信息展示 */}
        {renderingMode === 'agent' && (round.agent_name || round.model || round.prompt_tokens !== undefined) && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            marginTop: '12px',
            flexWrap: 'wrap'
          }}>
            {round.agent_name && (
              <Tag style={{
                background: 'rgba(184, 88, 69, 0.08)',
                color: '#b85845',
                border: '1px solid rgba(184, 88, 69, 0.2)',
                borderRadius: '6px',
                fontWeight: 500,
                padding: '4px 12px',
                fontSize: '12px',
                margin: 0
              }}>
                Agent: {round.agent_name}
              </Tag>
            )}
            {round.model && (
              <Tag style={{
                background: 'rgba(160, 130, 109, 0.08)',
                color: '#a0826d',
                border: '1px solid rgba(160, 130, 109, 0.2)',
                borderRadius: '6px',
                fontWeight: 500,
                padding: '4px 12px',
                fontSize: '12px',
                margin: 0
              }}>
                Model: {round.model}
              </Tag>
            )}
            {round.prompt_tokens !== undefined && round.completion_tokens !== undefined && (
              <Tag style={{
                background: 'rgba(139, 115, 85, 0.08)',
                color: '#8b7355',
                border: '1px solid rgba(139, 115, 85, 0.2)',
                borderRadius: '6px',
                fontWeight: 500,
                padding: '4px 12px',
                fontSize: '12px',
                margin: 0
              }}>
                Tokens: {round.prompt_tokens} / {round.completion_tokens}
              </Tag>
            )}
          </div>
        )}
      </div>
    );
  };
  return <>{rounds.map((round, index) => renderingMode === 'graph' ? renderGraphRound(round, index) : renderChatRound(round, index))}</>;
});

export default HistoryMessages;
