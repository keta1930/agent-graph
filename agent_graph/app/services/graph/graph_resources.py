"""图配置所引用的组件与 README 装配。"""
from functools import partial
from agent_graph.app.infrastructure.database.mongodb import mongodb_client
from agent_graph.app.services.model.model_service import model_service
from agent_graph.app.services.conversation.document_archive import run_archive_io
from agent_graph.app.templates.flow_diagram import FlowDiagram


async def collect_graph_resources(config, user_id):
    """一次读取组件集合，兼容配置中可空的工具列表。"""
    servers = set()
    models = set()
    for node in config.get("nodes", []):
        servers.update(node.get("mcp_servers") or [])
        if node.get("model_name"):
            models.add(node["model_name"])
    stored = await mongodb_client.get_mcp_config()
    available = (stored or {}).get("config", {}).get("mcpServers", {})
    mcp = {"mcpServers": {name: available[name].copy() for name in sorted(servers) if name in available}}
    configurations = await model_service.get_all_models(user_id=user_id)
    return mcp, [model for model in configurations if model["name"] in models]


async def add_graph_readme(config, user_id):
    """装配图说明，磁盘无关的较大模板渲染也在线程内执行。"""
    mcp, models = await collect_graph_resources(config, user_id)
    config["readme"] = await run_archive_io(partial(FlowDiagram.generate_graph_readme, config, mcp, models))
    return config
