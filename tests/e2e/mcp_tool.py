from fastmcp import FastMCP

server = FastMCP("E2E deterministic tools")


@server.tool()
def e2e_add(a: int, b: int) -> int:
    """执行真实MCP调用并返回两个测试整数之和。"""
    return a + b


if __name__ == "__main__":
    server.run(transport="stdio")
