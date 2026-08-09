import pytest
from pydantic import ValidationError

from agent_graph.app.models.graph_schema import AgentNode


def test_regular_node_requires_agent_or_model():
    with pytest.raises(ValidationError, match="agent_name 或 model_name"):
        AgentNode(name="node")


def test_subgraph_node_does_not_require_model():
    node = AgentNode(
        name="subgraph",
        is_subgraph=True,
        subgraph_name="child-graph",
    )

    assert node.model_name is None


def test_model_name_is_normalized():
    node = AgentNode(name="node", model_name="  gpt-test  ")

    assert node.model_name == "gpt-test"
