// 消息处理工具函数
import { ConversationMessage, ConversationRound, TaskData, TaskRoundData, StreamingBlock, TaskBlock } from '../../../types/conversation';

/**
 * 构建工具调用结果映射
 * 从rounds中提取所有工具调用的结果
 */
export const buildToolResultsMap = (rounds: Pick<ConversationRound, 'messages'>[]): Record<string, string> => {
  const toolResults: Record<string, string> = {};

  if (Array.isArray(rounds)) {
    rounds.forEach(round => {
      if (round && round.messages && Array.isArray(round.messages)) {
        round.messages.forEach((msg: ConversationMessage) => {
          if (msg && msg.role === 'tool' && msg.tool_call_id) {
            toolResults[msg.tool_call_id] = msg.content || '';
          }
        });
      }
    });
  }

  return toolResults;
};

/** 每批流式块只遍历一次，任务子块保留输入顺序。 */
export const groupTaskBlocks = (blocks: StreamingBlock[]): Map<string, StreamingBlock[]> => {
  const groups = new Map<string, StreamingBlock[]>();
  for (const block of blocks) {
    if (!block.taskId || block.type === 'task') continue;
    const group = groups.get(block.taskId);
    if (group) group.push(block);
    else groups.set(block.taskId, [block]);
  }
  return groups;
};

export const isTaskBlock = (block: StreamingBlock): block is TaskBlock =>
  block.type === 'task' && block.taskId !== undefined && block.taskStatus !== undefined;

/** 工具结果来自 JSON 边界，仅接收字符串值。 */
export const parseToolResults = (content: string): Record<string, string> => {
  if (!content) return {};
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
};

/**
 * 构建task round数据映射
 * 通过tool_call_id关联task和round
 */
export const buildTaskRoundDataMap = (tasks: TaskData[] | undefined): Record<string, TaskRoundData> => {
  const taskRoundDataMap: Record<string, TaskRoundData> = {};

  if (Array.isArray(tasks)) {
    tasks.forEach(task => {
      task.rounds.forEach(round => {
        if (round.tool_call_id) {
          taskRoundDataMap[round.tool_call_id] = {
            task_id: task.task_id,
            agent_name: task.agent_name,
            round: round
          };
        }
      });
    });
  }

  return taskRoundDataMap;
};
