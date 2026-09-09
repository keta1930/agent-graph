import type { JsonObject, JsonValue } from './json';
// src/types/mcp.ts
export interface MCPServerConfig {
  autoApprove: string[];
  disabled: boolean;
  timeout: number;
  command?: string;
  args: string[];
  transportType: 'stdio' | 'sse' | 'streamable_http'; // 明确支持的类型
  url?: string; // SSE URL or HTTP URL
  base_url?: string;
  env?: Record<string, string>;

  // 团队共享字段
  provider_user_id?: string;     // 提供者用户ID
  created_at?: string;            // 创建时间

  [key: string]: JsonValue | undefined;
}

export interface MCPConfig {
  mcpServers: Record<string, MCPServerConfig>;
}

export interface MCPConfigWithVersion {
  mcpServers: Record<string, MCPServerConfig>;
  version: number;
  updated_at?: string;
}

export interface MCPStatus {
  [serverName: string]: {
    connected: boolean;
    init_attempted: boolean;
    tools: string[];
    error?: string;
    transport_type?: string;
  };
}

export interface MCPTools {
  [serverName: string]: Array<{
    name: string;
    description: string;
    input_schema: JsonObject;
  }>;
}
export interface MCPToolRegistration {
  folder_name: string;
  script_files: Record<string, string>;
  readme: string;
  dependencies: string;
  port?: number;
}
export interface MCPToolTestResult {
  status: 'success' | 'error';
  params: JsonObject;
  server_name: string;
  tool_name: string;
  result?: JsonValue;
  error?: string;
  execution_time?: number;
}
export interface MCPConfigUpdateResult {
  status: { version?: number; message?: string; warning?: string; error?: string };
}
export interface MCPServerMutationResult {
  status: string;
  message?: string;
  error?: string;
  new_version?: number;
}
