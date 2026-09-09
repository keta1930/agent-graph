import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import InputArea from './InputArea';
import { I18nProvider } from '../../../i18n/I18nContext';
import api from '../../../services/api';
import { clearSession } from '../../../services/authSessionService';
import { useMCPStore } from '../../../store/mcpStore';
import { useModelStore } from '../../../store/modelStore';
import { useGraphEditorStore } from '../../../store/graphEditorStore';
import type { MCPConfigWithVersion } from '../../../types/mcp';

vi.mock('../controls/ModelSelector', () => ({ default: () => null }));
vi.mock('../controls/GraphSelector', () => ({ default: () => null }));
vi.mock('../controls/AgentPicker', () => ({ default: () => null }));
vi.mock('../controls/SystemPromptToggle', () => ({ default: () => null }));
vi.mock('../controls/SystemToolSelector', () => ({ default: () => null }));
vi.mock('../controls/PromptSelector', () => ({ default: () => null }));
vi.mock('../controls/MaxIterationsConfig', () => ({ default: () => null }));
vi.mock('../controls/FileUploadButton', () => ({ default: () => null }));
vi.mock('../controls/MCPToolSelector', () => ({ default: ({ onToggleMCPServer }: { onToggleMCPServer: (id: string, enabled: boolean) => void }) => <button onClick={() => onToggleMCPServer('added-server', true)}>Select another MCP</button> }));
const server = { args: [], autoApprove: [], disabled: false, timeout: 60, transportType: 'stdio' as const };
const knownConfig: MCPConfigWithVersion = { mcpServers: { 'known-server': server, 'added-server': server }, version: 2 };
const response = (config: InternalAxiosRequestConfig, data: unknown): AxiosResponse => ({ config, data, status: 200, statusText: 'OK', headers: new AxiosHeaders() });
const originalAdapter = api.defaults.adapter;
afterEach(() => { api.defaults.adapter = originalAdapter; });
const realFetchConfig = useMCPStore.getState().fetchConfig;
beforeEach(() => {
  clearSession();
  useMCPStore.setState({ fetchConfig: realFetchConfig });
  useModelStore.setState({ models: [], fetchModels: vi.fn().mockResolvedValue(undefined) });
  useGraphEditorStore.setState({ graphs: [], fetchGraphs: vi.fn().mockResolvedValue(undefined) });
});
function mountInput() {
  const send = vi.fn();
  const view = render(<I18nProvider><InputArea mode="agent" conversationId="A" inheritedConfig={{ selectedModel: 'model', selectedMCPServers: ['known-server'] }} onSendMessage={send} /></I18nProvider>);
  const submit = async () => {
    const textarea = view.container.querySelector('textarea')!;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    await act(async () => fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true }));
    return send.mock.calls.at(-1)?.[1];
  };
  return { ...view, submit };
}
it('preserves inherited MCP selection through an initial config failure and actual recovery', async () => {
  let failing = true;
  api.defaults.adapter = (async config => {
    if (config.url === '/mcp/config') {
      if (failing) throw new Error('config unavailable');
      return response(config, knownConfig);
    }
    return response(config, {});
  });
  const view = mountInput();
  await waitFor(() => expect(useMCPStore.getState().error).toBe('config unavailable'));
  failing = false;
  await act(async () => useMCPStore.getState().fetchConfig());
  expect(await view.submit()).toMatchObject({ mcp_servers: ['known-server'] });
});
it('prunes inherited servers only after a successful empty config response', async () => {
  api.defaults.adapter = (async config => response(config, config.url === '/mcp/config' ? { mcpServers: {}, version: 2 } : {}));
  const view = mountInput();
  await waitFor(() => expect(useMCPStore.getState().version).toBe(2));
  expect(await view.submit()).not.toHaveProperty('mcp_servers');
});
it('retains user-added servers when a refresh fails while status succeeds', async () => {
  let failing = false;
  api.defaults.adapter = (async config => {
    if (config.url === '/mcp/config') {
      if (failing) throw new Error('refresh unavailable');
      return response(config, knownConfig);
    }
    return response(config, {});
  });
  const view = mountInput();
  await waitFor(() => expect(useMCPStore.getState().version).toBe(2));
  fireEvent.click(screen.getByText('Select another MCP'));
  failing = true;
  await act(async () => { await useMCPStore.getState().fetchConfig(); await useMCPStore.getState().fetchStatus(); });
  expect(await view.submit()).toMatchObject({ mcp_servers: ['known-server', 'added-server'] });
});
it('does not treat a superseded first config request as an authoritative empty list', async () => {
  let resolve!: (value: AxiosResponse) => void;
  let configRequest!: InternalAxiosRequestConfig;
  api.defaults.adapter = (async config => {
    if (config.url === '/mcp/config') {
      configRequest = config;
      return new Promise<AxiosResponse>(yes => { resolve = yes; });
    }
    return response(config, {});
  });
  const view = mountInput();
  await waitFor(() => expect(configRequest).toBeDefined());
  // connectServer 使用真实 mutation action 使旧 config scope 失效。
  await act(async () => {
    await useMCPStore.getState().connectServer('known-server');
    resolve(response(configRequest, { mcpServers: {}, version: 2 }));
  });
  expect(await view.submit()).toMatchObject({ mcp_servers: ['known-server'] });
});
it('does not prune inherited tools when the initial config read is cancelled', async () => {
  api.defaults.adapter = async config => {
    if (config.url === '/mcp/config') throw new DOMException('request cancelled', 'AbortError');
    return response(config, {});
  };
  const view = mountInput();
  await waitFor(() => expect(useMCPStore.getState().error).toBe('request cancelled'));
  expect(await view.submit()).toMatchObject({ mcp_servers: ['known-server'] });
});
