# Task

Schedule and automatically execute Graphs.

## What is a Task

Tasks allow you to automatically run Graphs on a time schedule. Supports single execution or recurring cron-based execution.

## Task Management

Users can manage tasks through the interface:

| Operation | Purpose | Effect |
|-----------|---------|--------|
| **View List** | View all tasks with status, schedule, and execution statistics | Monitor automation globally |
| **View Details** | View complete execution history and timestamps | Audit workflow run records |
| **Pause Task** | Temporarily stop execution | Task won't run until resumed |
| **Resume Task** | Restart paused task | Continue execution on schedule |
| **Delete Task** | Permanently remove task | Will no longer execute |

**Task Status:**

| Status | Meaning |
|--------|---------|
| Active | Task is scheduled and will execute |
| Paused | Task exists but won't execute until resumed |
| Completed | A single task successfully started at least one Graph instance |
| Error | Scheduling failed, the single execution time expired, or no instance could be started for a single task |


## Execution Details

**Concurrent Instances:** Set `execution_count` to a positive integer to start multiple Graph instances on each trigger, each with its own `conversation_id`.

**Background Mode:** Tasks always execute in the background, view results in conversation history.

**History Tracking:** Successful launches record their timestamp and `conversation_id`s. A completed single task does not mean every Graph finished successfully; open its conversations to check the results.

## How to Use

**Create Task:** Go to task management page, click "Create Task", select Graph, set schedule and input.

**View Tasks:** Task list displays all tasks with status, next run time, and execution history.

**Manage Status:** Use status dropdown to pause, resume, or complete tasks.

**View Results:** Click execution history to view conversation results for each trigger.

## Notes

- Times without an offset use the server local timezone. API timestamps with `Z` or an offset are converted to server local time.
- Single execution times must be in the future; recurring schedules use a valid five-field cron expression.
- A single task that cannot start any instance becomes `error`. A failed trigger of a recurring task does not automatically cancel later triggers.
- Tasks explicitly set to `error` or `completed` are no longer scheduled.
- Input text is fixed at creation time and cannot be dynamically modified
- Active tasks automatically reload on restart
- To modify a task, delete and recreate it

## Related Documentation

- [Task Manager](../tools/task-manager.md) - Create scheduled tasks through AI interactive conversation
