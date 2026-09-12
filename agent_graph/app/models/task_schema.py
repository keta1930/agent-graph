from pydantic import BaseModel, Field, field_validator
from typing import Dict, List, Any, Optional
from datetime import datetime
from enum import Enum


def local_datetime(value: datetime) -> datetime:
    """将有时区的时间转换为服务器本地时间，兼容已有无时区记录。"""
    return value.astimezone().replace(tzinfo=None) if value.tzinfo else value


class ScheduleType(str, Enum):
    SINGLE = "single"
    RECURRING = "recurring"


class TaskStatus(str, Enum):
    ACTIVE = "active"
    PAUSED = "paused"
    COMPLETED = "completed"
    ERROR = "error"


class ScheduleConfig(BaseModel):
    execute_at: Optional[datetime] = Field(None, description="单次执行时间（本地时间）")
    cron_expression: Optional[str] = Field(None, description="周期执行Cron表达式")

    @field_validator('execute_at')
    @classmethod
    def normalize_execute_at(cls, value: Optional[datetime]) -> Optional[datetime]:
        return local_datetime(value) if value is not None else None


class TaskCreate(BaseModel):
    task_name: str = Field(..., description="任务名称")
    graph_name: str = Field(..., description="要执行的图名称")
    input_text: str = Field(..., description="图的输入文本")
    execution_count: int = Field(1, ge=1, description="每次触发时并发执行的数量")
    schedule_type: ScheduleType = Field(..., description="调度类型")
    schedule_config: ScheduleConfig = Field(..., description="调度配置")
    user_id: str = Field("default_user", description="用户ID")


class TaskExecution(BaseModel):
    conversation_id: str = Field(..., description="会话ID")


class TaskExecutionHistory(BaseModel):
    executed_at: datetime = Field(..., description="触发时间")
    executions: List[TaskExecution] = Field(..., description="执行实例列表")


class ExecutionStats(BaseModel):
    """执行统计信息"""
    total_triggers: int = Field(0, description="总触发次数")
    last_executed_at: Optional[TaskExecutionHistory] = Field(None, description="最后执行信息")


class ExecutionStatsSummary(BaseModel):
    total_triggers: int = Field(0, description="总触发次数")
    last_executed_at: Optional[TaskExecutionHistory] = Field(None, description="最后一次执行信息（包含executed_at与executions）")


class Task(BaseModel):
    id: str = Field(..., description="任务ID")
    user_id: str = Field(..., description="用户ID")
    task_name: str = Field(..., description="任务名称")
    graph_name: str = Field(..., description="要执行的图名称")
    input_text: str = Field(..., description="图的输入文本")
    execution_count: int = Field(..., description="每次触发时并发执行的数量")
    schedule_type: ScheduleType = Field(..., description="调度类型")
    schedule_config: ScheduleConfig = Field(..., description="调度配置")
    status: TaskStatus = Field(TaskStatus.ACTIVE, description="任务状态")
    created_at: datetime = Field(default_factory=datetime.now, description="创建时间")
    updated_at: datetime = Field(default_factory=datetime.now, description="更新时间")
    execution_history: List[TaskExecutionHistory] = Field(default_factory=list, description="执行历史")
    execution_stats: ExecutionStats = Field(default_factory=ExecutionStats, description="执行统计")


class TaskSummary(BaseModel):
    id: str = Field(..., description="任务ID")
    user_id: str = Field(..., description="用户ID")
    task_name: str = Field(..., description="任务名称")
    graph_name: str = Field(..., description="要执行的图名称")
    input_text: str = Field(..., description="图的输入文本")
    execution_count: int = Field(..., description="每次触发时并发执行的数量")
    schedule_type: ScheduleType = Field(..., description="调度类型")
    schedule_config: ScheduleConfig = Field(..., description="调度配置")
    status: TaskStatus = Field(TaskStatus.ACTIVE, description="任务状态")
    created_at: datetime = Field(default_factory=datetime.now, description="创建时间")
    updated_at: datetime = Field(default_factory=datetime.now, description="更新时间")
    execution_stats: ExecutionStatsSummary = Field(default_factory=ExecutionStatsSummary, description="执行统计概览")


class TaskExecutionRecord(BaseModel):
    id: str = Field(..., description="记录ID，使用task_id作为_id")
    task_id: str = Field(..., description="任务ID")
    task_name: str = Field(..., description="任务名称")
    execution_history: List[TaskExecutionHistory] = Field(default_factory=list, description="执行历史")
    execution_stats: Optional[ExecutionStats] = Field(None, description="执行统计")


class TaskStatusUpdate(BaseModel):
    status: TaskStatus = Field(..., description="新的任务状态")


class TaskResponse(BaseModel):
    status: str = Field(..., description="响应状态")
    message: str = Field(..., description="响应消息")
    data: Optional[Dict[str, Any]] = Field(None, description="响应数据")