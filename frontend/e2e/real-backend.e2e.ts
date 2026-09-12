import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

interface Credentials { user: string; password: string; model_key: string; expired_access: string }
interface Auth { access_token: string; refresh_token: string; user_id: string; role: string }
const privateConfig = JSON.parse(readFileSync(process.env.E2E_PRIVATE_CONFIG!, 'utf8')) as Credentials;
const artifacts = process.env.E2E_ARTIFACT_DIR!;
const modelName = 'E2E Model';
const agentName = 'E2E Plain Agent';
const graphName = 'E2E Graph';
let auth: Auth;
let api: APIRequestContext;

async function createAgent(name: string, mcp: string[] = []) {
  if ((await api.get('/api/agent/' + encodeURIComponent(name))).ok()) return;
  const response = await api.post('/api/agent', { data: { agent_config: {
    name, card: 'Real E2E fixture', model: modelName, instruction: 'Answer the user.',
    max_actions: 3, mcp, system_tools: [], category: 'e2e', tags: [],
  } } });
  expect(response.ok(), `Create Agent status ${response.status()}`).toBeTruthy();
}

async function chooseAgent(page: Page, name = agentName) {
  await page.goto('/chat');
  await page.locator('button').filter({ has: page.locator('svg.lucide-bot') }).click();
  await page.getByText(name, { exact: true }).click();
}

async function submit(page: Page, marker: string, endpoint = '/api/agent/run') {
  await expect(page.getByRole('button', { name: /Stop generating/ })).toHaveCount(0);
  const completeNormally = !marker.includes('E2E_ERROR') && !marker.includes('E2E_CANCEL');
  let savedConfig = false;
  const saved = completeNormally ? page.waitForResponse(item => {
    if (item.request().method() === 'PUT' && item.url().endsWith('/input-config')) { savedConfig = true; return true; }
    return false;
  }) : undefined;
  const loaded = completeNormally ? page.waitForResponse(item => savedConfig && item.request().method() === 'GET' && /\/api\/conversations\/[^/?]+$/.test(item.url())) : undefined;
  const response = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith(endpoint));
  await page.locator('textarea').fill(marker);
  await expect(page.locator('button').filter({ has: page.locator('svg.lucide-arrow-up') })).toBeEnabled();
  await page.locator('textarea').press('Control+Enter');
  expect((await response).status()).toBe(200);
  if (saved && loaded) {
    expect((await saved).ok()).toBeTruthy();
    expect((await loaded).ok()).toBeTruthy();
    await expect(page.locator('textarea')).toBeEnabled();
  }
}

async function persisted(page: Page, expected: string) {
  await expect(page).toHaveURL(/\/chat\/[^/]+$/);
  const id = page.url().split('/').pop()!;
  await expect.poll(async () => {
    const response = await api.get('/api/conversations/' + id);
    return response.ok() && JSON.stringify((await response.json()).rounds).includes(expected);
  }).toBe(true);
  return id;
}

async function evidence(page: Page, name: string) {
  await page.screenshot({ path: path.join(artifacts, name + '.png'), animations: 'disabled' });
}

test.beforeAll(async ({ playwright }) => {
  const login = await playwright.request.newContext({ baseURL: process.env.E2E_BASE_URL });
  const response = await login.post('/api/auth/login', { data: { user_id: privateConfig.user, password: privateConfig.password } });
  expect(response.ok()).toBeTruthy();
  auth = await response.json() as Auth;
  await login.dispose();
  api = await playwright.request.newContext({ baseURL: process.env.E2E_BASE_URL, extraHTTPHeaders: { Authorization: 'Bearer ' + auth.access_token } });
  if (!(await api.get('/api/models/' + encodeURIComponent(modelName))).ok()) {
  const model = await api.post('/api/models', { data: { name: modelName, base_url: 'http://127.0.0.1:20057/v1', api_key: privateConfig.model_key, model: 'e2e-deterministic', provider: 'openai', model_type: 'llm', stream: true, temperature: 0.3, max_tokens: 128 } });
  expect(model.ok()).toBeTruthy();
  }
  await createAgent(agentName);
  const graph = await api.post('/api/graphs', { data: { name: graphName, description: 'Real graph', nodes: [{ name: 'worker', agent_name: agentName, user_prompt: '{{start}}', max_iterations: null, input_nodes: ['start'], output_nodes: ['end'], mcp_servers: [], system_tools: [], output_enabled: true, position: { x: 300, y: 100 } }] } });
  expect(graph.ok(), `Create graph status ${graph.status()}`).toBeTruthy();
});

test.beforeEach(async ({ context }) => {
  await context.addInitScript(value => {
    localStorage.setItem('auth_token', value.access_token);
    localStorage.setItem('refresh_token', value.refresh_token);
    localStorage.setItem('user_info', JSON.stringify({ user_id: value.user_id, role: value.role }));
    localStorage.setItem('app_locale', 'en');
    localStorage.setItem('chat-tour-completed', 'true');
    localStorage.setItem('workspace-tour-completed', 'true');
  }, auth);
});

test.afterAll(async () => { await api?.dispose(); });

test('configured Agent: nullable wire, new/continued conversation and reload persistence', async ({ page }) => {
  await chooseAgent(page);
  const ids: string[] = [];
  for (const marker of ['E2E_PLAIN_FIRST', 'E2E_PLAIN_CONTINUATION']) {
    await submit(page, marker);
    const reply = 'REAL_E2E_RESPONSE: ' + marker;
    await expect(page.getByText(reply, { exact: true }).first()).toBeVisible();
    ids.push(await persisted(page, reply));
  }
  expect(ids[0]).toBe(ids[1]);
  await page.reload();
  for (const marker of ['E2E_PLAIN_FIRST', 'E2E_PLAIN_CONTINUATION']) {
    await expect(page.getByText('REAL_E2E_RESPONSE: ' + marker, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText(/Invalid SSE/)).toHaveCount(0);
  writeFileSync(path.join(artifacts, 'plain-conversation.json'), JSON.stringify({ id: ids[0], markers: ['E2E_PLAIN_FIRST', 'E2E_PLAIN_CONTINUATION'], reloaded: true }));
  await evidence(page, 'plain-reloaded');
});

test('manual Agent model selection preserves reasoning and text from real SSE', async ({ page }) => {
  await page.goto('/chat');
  await page.locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: modelName }).click();
  await submit(page, 'E2E_REASONING');
  await expect(page.getByText('REAL_E2E_RESPONSE: E2E_REASONING', { exact: true }).first()).toBeVisible();
  await persisted(page, 'REAL_E2E_RESPONSE: E2E_REASONING');
  const response = await api.get('/api/conversations/' + page.url().split('/').pop());
  expect(JSON.stringify((await response.json()).rounds)).toContain('reasoning_content');
  await evidence(page, 'manual-reasoning');
});

test('real MCP tool executes and nullable tool increment is accepted', async ({ page }) => {
  const current = await (await api.get('/api/mcp/config')).json() as { version: number };
  const tool = fileURLToPath(new URL('../../tests/e2e/mcp_tool.py', import.meta.url));
  const config = await api.post('/api/mcp/config', { data: { config: { mcpServers: { e2e: { command: process.env.E2E_PYTHON, args: [tool], transportType: 'stdio' } } }, version: current.version } });
  expect(config.ok(), `MCP config status ${config.status()}`).toBeTruthy();
  const connected = await api.post('/api/mcp/connect/e2e');
  expect(connected.ok(), `MCP connect status ${connected.status()}`).toBeTruthy();
  await createAgent('E2E Tool Agent', ['e2e']);
  await chooseAgent(page, 'E2E Tool Agent');
  await submit(page, 'E2E_TOOL');
  await expect(page.getByText(/REAL_E2E_TOOL_RESULT:/).first()).toBeVisible();
  const id = await persisted(page, 'REAL_E2E_TOOL_RESULT:');
  const conversation = await (await api.get('/api/conversations/' + id)).json();
  const rounds = JSON.stringify(conversation.rounds);
  expect(rounds).toContain('e2e_add');
  expect(rounds).toContain('"role":"tool"');
  const toolResults = (conversation.rounds as { messages: { role: string; tool_call_id?: string; content?: string }[] }[])
    .flatMap(round => round.messages).filter(message => message.role === 'tool' && message.tool_call_id === 'call_e2e_add');
  expect(toolResults).toHaveLength(1);
  expect(toolResults[0].content).toContain('执行成功');
  expect(toolResults[0].content).toContain('"text": "5"');
  await page.reload();
  await expect(page.getByText(/REAL_E2E_TOOL_RESULT:/).first()).toBeVisible();
  await evidence(page, 'tool-reloaded');
});

test('model edit reads actual envelope and persists advanced setting under original name', async ({ page }) => {
  await page.goto('/workspace/model-manager');
  await page.locator('#root').getByText('Edit', { exact: true }).click();
  await expect(page.locator('#modelForm_name')).toHaveValue(modelName);
  await expect(page.locator('#modelForm_base_url')).toHaveValue('http://127.0.0.1:20057/v1');
  await expect(page.locator('#modelForm_model')).toHaveValue('e2e-deterministic');
  await expect(page.locator('#modelForm_api_key')).toHaveValue('');
  await page.getByText('Advanced Configuration', { exact: true }).click();
  await expect(page.locator('#modelForm_temperature')).toHaveValue('0.30');
  await page.locator('#modelForm_temperature').fill('0.7');
  const saving = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes('/api/models/'));
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  const saved = await saving;
  const saveBody = await saved.json() as { detail?: unknown };
  writeFileSync(path.join(artifacts, 'model-update-http.json'), JSON.stringify({
    status: saved.status(), path: decodeURIComponent(saved.url()).split('/api/')[1],
    request: saved.request().postDataJSON() as unknown, response: saveBody,
  }, null, 2));
  expect(saved.ok()).toBeTruthy();
  expect(decodeURIComponent(saved.url()).endsWith('/api/models/' + modelName)).toBeTruthy();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.locator('#root').getByText('Edit', { exact: true }).click();
  await page.getByText('Advanced Configuration', { exact: true }).click();
  await expect(page.locator('#modelForm_temperature')).toHaveValue('0.70');
  await evidence(page, 'model-edit-persisted');
});

test('controlled upstream error releases input and next real conversation succeeds', async ({ page }) => {
  const diagnostics = {
    pageErrors: [] as string[], consoleErrors: [] as string[],
    scriptFailures: [] as { path: string; error: string }[],
    scriptResponses: [] as { path: string; status: number }[],
  };
  page.on('pageerror', error => diagnostics.pageErrors.push(error.message));
  page.on('console', event => {
    if (event.type() === 'error') diagnostics.consoleErrors.push(event.text());
  });
  page.on('requestfailed', request => {
    if (request.resourceType() === 'script') diagnostics.scriptFailures.push({ path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? '' });
  });
  page.on('response', response => {
    if (response.request().resourceType() === 'script' && response.status() >= 400) diagnostics.scriptResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  try {
    await chooseAgent(page);
    await submit(page, 'E2E_ERROR');
    await expect(page.getByText(/E2E controlled model error/).first()).toBeVisible();
    await chooseAgent(page);
    await submit(page, 'E2E_AFTER_ERROR');
    await expect(page.getByText('REAL_E2E_RESPONSE: E2E_AFTER_ERROR', { exact: true }).first()).toBeVisible();
    await persisted(page, 'REAL_E2E_RESPONSE: E2E_AFTER_ERROR');
    await evidence(page, 'error-recovered');
  } finally {
    writeFileSync(path.join(artifacts, 'error-recovery-browser-diagnostics.json'), JSON.stringify(diagnostics, null, 2));
  }
});

test('cancelling active real stream allows another conversation without late writes', async ({ page }) => {
  await chooseAgent(page);
  await submit(page, 'E2E_CANCEL');
  await expect(page.getByText(/E2E slow token/).first()).toBeVisible();
  const cancelledId = page.url().split('/').pop()!;
  await page.getByRole('button', { name: /Stop generating/ }).click();
  await expect.poll(() => {
    const file = path.join(artifacts, 'model-disconnects.jsonl');
    return existsSync(file) && readFileSync(file, 'utf8').split('\n').some(line => line && (JSON.parse(line) as { prompt: string }).prompt.includes('E2E_CANCEL'));
  }).toBe(true);
  const stopped = await api.get('/api/conversations/' + cancelledId);
  expect(stopped.ok()).toBeTruthy();
  expect(JSON.stringify((await stopped.json()).rounds)).not.toContain('E2E slow token 99');
  await chooseAgent(page);
  await submit(page, 'E2E_AFTER_CANCEL');
  await expect(page.getByText('REAL_E2E_RESPONSE: E2E_AFTER_CANCEL', { exact: true }).first()).toBeVisible();
  await persisted(page, 'REAL_E2E_RESPONSE: E2E_AFTER_CANCEL');
  await expect(page.getByText(/E2E slow token/)).toHaveCount(0);
  await evidence(page, 'cancel-recovered');
});

test('Graph new and continued execution crosses real executor and reload persistence', async ({ page }) => {
  await page.goto('/chat');
  await page.getByText('Graph', { exact: true }).click();
  await page.locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: graphName }).click();
  const ids: string[] = [];
  for (const marker of ['E2E_GRAPH_FIRST', 'E2E_GRAPH_CONTINUATION']) {
    await submit(page, marker, '/api/graphs/execute');
    await expect(page.getByText(new RegExp('REAL_E2E_RESPONSE:.*' + marker)).first()).toBeVisible();
    ids.push(await persisted(page, 'REAL_E2E_RESPONSE: ' + marker));
  }
  expect(ids[0]).toBe(ids[1]);
  await page.reload();
  await expect(page.getByText(/REAL_E2E_RESPONSE:.*E2E_GRAPH_CONTINUATION/).first()).toBeVisible();
  await evidence(page, 'graph-reloaded');
});

test('Graph editor preserves inherited null and saves explicit iteration override', async ({ page }) => {
  await page.goto('/workspace/graph-editor');
  await page.getByText(graphName, { exact: true }).click();
  await page.locator('#root').getByText('Edit', { exact: true }).click();
  await page.locator('.react-flow__node').filter({ hasText: 'worker' }).click();
  await expect(page.locator('#max_iterations')).toHaveValue('');
  await page.locator('#description').fill('Edited while preserving inheritance');
  const save = async () => {
    await page.locator('.ant-drawer-close').click();
    const response = page.waitForResponse(item => item.request().method() === 'POST' && item.url().endsWith('/api/graphs'));
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await response).ok()).toBeTruthy();
  };
  await save();
  let config = await (await api.get('/api/graphs/' + encodeURIComponent(graphName))).json();
  expect(config.nodes.find((node: { name: string }) => node.name === 'worker').max_iterations).toBeNull();
  await page.locator('.react-flow__node').filter({ hasText: 'worker' }).click();
  await page.locator('#max_iterations').fill('8');
  await save();
  config = await (await api.get('/api/graphs/' + encodeURIComponent(graphName))).json();
  expect(config.nodes.find((node: { name: string }) => node.name === 'worker').max_iterations).toBe(8);
  await page.reload();
  await page.locator('#root').getByText('Edit', { exact: true }).click();
  await page.locator('.react-flow__node').filter({ hasText: 'worker' }).click();
  await expect(page.locator('#max_iterations')).toHaveValue('8');
  await evidence(page, 'graph-override-reloaded');
});

test('project files use real MinIO content/version/delete and browser listing', async ({ page }) => {
  const created = await api.post('/api/projects', { data: { name: 'E2E Project', instruction: 'Isolated project' } });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  const id = project.project_id ?? project.project?.project_id;
  expect(typeof id).toBe('string');
  const files = '/api/projects/' + id + '/files';
  const made = await api.post(files, { data: { filename: 'note.txt', summary: 'E2E file', content: 'E2E_MINIO_V1', log: 'create' } });
  expect(made.ok()).toBeTruthy();
  const first = await (await api.get(files + '/note.txt')).json();
  expect(first.file.content).toBe('E2E_MINIO_V1');
  expect((await api.put(files + '/note.txt', { data: { summary: 'E2E file', content: 'E2E_MINIO_V2', log: 'update' } })).ok()).toBeTruthy();
  const latest = await (await api.get(files + '/note.txt')).json();
  expect(latest.file.content).toBe('E2E_MINIO_V2');
  expect(latest.file.versions.length).toBe(2);
  const detail = await (await api.get('/api/projects/' + id)).json();
  const listed = await (await api.get(files)).json();
  writeFileSync(path.join(artifacts, 'project-detail-http.json'), JSON.stringify({ detail, listed, latest }, null, 2));
  await page.goto('/workspace/projects/' + id);
  await expect(page.getByText('E2E Project', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('note.txt', { exact: true }).first()).toBeVisible();
  await evidence(page, 'project-real-files');
  expect((await api.delete(files + '/note.txt')).ok()).toBeTruthy();
  expect((await (await api.get(files)).json()).files).toEqual([]);
  expect((await api.delete('/api/projects/' + id)).ok()).toBeTruthy();
});

test('smoke: prompt, memory, task, admin and system-tool pages consume real data', async ({ page }) => {
  test.setTimeout(90_000);
  expect((await api.post('/api/prompt/create', { data: { name: 'E2E Prompt', content: 'E2E_PROMPT_CONTENT', category: 'e2e' } })).ok()).toBeTruthy();
  expect((await api.post('/api/memory/add', { data: { owner_type: 'user', owner_id: privateConfig.user, category: 'e2e', content: 'E2E_MEMORY_CONTENT' } })).ok()).toBeTruthy();
  const createdTask = await api.post('/api/tasks', { data: { task_name: 'E2E Future Task', graph_name: graphName, input_text: 'E2E_TASK_INPUT', schedule_type: 'single', schedule_config: { execute_at: '2099-01-01T12:00:00' } } });
  expect(createdTask.ok(), `Create task status ${createdTask.status()}`).toBeTruthy();
  const taskId = (await createdTask.json()).data.task_id as string;
  expect((await api.put('/api/tasks/' + taskId + '/status', { data: { status: 'paused' } })).ok()).toBeTruthy();
  const pages: { path: string; endpoint: string; rendered: string }[] = [];
  let cleanupError: unknown;
  const visit = async (route: string, endpoint: string, rendered: string) => {
    const response = page.waitForResponse(item => new URL(item.url()).pathname === endpoint && item.request().method() === 'GET');
    await page.goto(route);
    expect((await response).ok()).toBeTruthy();
    if (route === '/workspace/prompt-manager') await page.getByRole('button', { name: /^e2e / }).click();
    await expect(page.getByText(rendered, { exact: true }).first()).toBeVisible();
    pages.push({ path: route, endpoint, rendered });
  };
  try {
    await visit('/workspace/prompt-manager', '/api/prompt/list', 'E2E Prompt');
    await page.locator('svg.lucide-square-pen').first().click();
    await expect(page.locator('textarea').first()).toHaveValue('E2E_PROMPT_CONTENT');
    await evidence(page, 'management-prompt');
    await visit('/workspace/memory-manager', '/api/memory', privateConfig.user);
    await page.locator('.ant-card').filter({ has: page.getByText(privateConfig.user, { exact: true }) }).getByTitle('Edit', { exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^e2e / }).click();
    await expect(page.getByText('E2E_MEMORY_CONTENT', { exact: true }).first()).toBeVisible();
    await evidence(page, 'management-memory');
    await visit('/tasks', '/api/tasks', 'E2E Future Task');
    await page.getByText('E2E Future Task', { exact: true }).click();
    await expect(page.getByText('E2E_TASK_INPUT', { exact: true }).first()).toBeVisible();
    await evidence(page, 'management-task');
    await visit('/admin', '/api/admin/users', privateConfig.user);
    await expect(page.getByRole('row').filter({ hasText: privateConfig.user })).toHaveCount(1);
    await evidence(page, 'management-admin');
    const toolList = await (await api.get('/api/system-tools/list')).json() as { categories: { category: string; tools: { name: string }[] }[] };
    const category = toolList.categories.find(item => item.tools.length > 0)!;
    expect(category).toBeTruthy();
    await page.goto('/workspace/system-tools');
    await page.getByPlaceholder(/Search/).fill(category.tools[0].name);
    await page.locator('svg.lucide-chevron-right').first().click();
    await expect(page.getByText(category.tools[0].name, { exact: true }).first()).toBeVisible();
    pages.push({ path: '/workspace/system-tools', endpoint: '/api/system-tools/list', rendered: category.tools[0].name });
    await evidence(page, 'management-system-tools');
    writeFileSync(path.join(artifacts, 'management-smoke.json'), JSON.stringify(pages, null, 2));
  } finally {
    try { expect((await api.delete('/api/tasks/' + taskId)).ok()).toBeTruthy(); }
    catch (error) {
      cleanupError = error;
      writeFileSync(path.join(artifacts, 'task-cleanup-deferred.json'), JSON.stringify({ isolatedEnvironmentCleanupRequired: true }));
    }
  }
  if (cleanupError) throw cleanupError;
});

test('smoke: 201 real Agents include final API page in manager search and picker', async ({ page }) => {
  test.setTimeout(120_000);
  const names = Array.from({ length: 201 }, (_, index) => 'E2E Page ' + String(index).padStart(3, '0'));
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < names.length) await createAgent(names[cursor++]);
  }));
  const firstPage = await (await api.get('/api/agent/list?limit=200&skip=0')).json() as { agents: { name: string }[] };
  const lastPage = await (await api.get('/api/agent/list?limit=200&skip=200')).json() as { agents: { name: string }[] };
  const seeded = [...firstPage.agents, ...lastPage.agents].filter(agent => names.includes(agent.name));
  expect(new Set(seeded.map(agent => agent.name)).size).toBe(201);
  const target = lastPage.agents.find(agent => names.includes(agent.name))!.name;
  expect(target).toBeTruthy();
  const pages: { skip: string | null; status: number }[] = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/agent/list') pages.push({ skip: url.searchParams.get('skip'), status: response.status() });
  });
  await page.goto('/workspace/agent-manager');
  await page.getByPlaceholder(/Search/).fill(target);
  await page.getByRole('button', { name: /^e2e / }).click();
  await expect(page.getByText(target, { exact: true }).first()).toBeVisible();
  await expect.poll(() => pages.some(item => Number(item.skip) >= 200 && item.status === 200)).toBe(true);
  await evidence(page, 'agents-final-page-search');
  await chooseAgent(page, target);
  await submit(page, 'E2E_PAGE_PICKER');
  const id = await persisted(page, 'REAL_E2E_RESPONSE: E2E_PAGE_PICKER');
  const conversation = await (await api.get('/api/conversations/' + id)).json();
  expect(conversation.rounds[0].agent_name).toBe(target);
  writeFileSync(path.join(artifacts, 'agent-pagination.json'), JSON.stringify({ created: names.length, selected: target, backendLastPage: lastPage.agents.map(agent => agent.name), pages }, null, 2));
});

test('smoke: anonymous share renders real content and downloads exact files and ZIP', async ({ page, browser }) => {
  await chooseAgent(page);
  await submit(page, 'E2E_SHARED_CONTENT');
  const id = await persisted(page, 'REAL_E2E_RESPONSE: E2E_SHARED_CONTENT');
  const expectedFiles = { 'note.txt': 'E2E_SHARED_NOTE', 'folder/第二份.txt': 'E2E_SHARED_UNICODE' };
  for (const [filename, content] of Object.entries(expectedFiles)) {
    expect((await api.post('/api/conversations/' + id + '/files', { data: { filename, content, summary: 'E2E shared file', log: 'create' } })).ok()).toBeTruthy();
  }
  const shareResponse = await api.post('/api/conversations/' + id + '/share');
  expect(shareResponse.ok()).toBeTruthy();
  const shareId = (await shareResponse.json()).share_id as string;
  const anonymous = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  try {
    await anonymous.addInitScript(() => localStorage.setItem('app_locale', 'en'));
    const publicPage = await anonymous.newPage();
    const requests: { path: string; authenticated: boolean }[] = [];
    publicPage.on('request', request => {
      if (request.url().includes('/api/share/')) requests.push({ path: new URL(request.url()).pathname, authenticated: Boolean(request.headers().authorization) });
    });
    await publicPage.goto('/share/' + shareId);
    await expect(publicPage.getByText('REAL_E2E_RESPONSE: E2E_SHARED_CONTENT', { exact: true }).first()).toBeVisible();
    await publicPage.getByRole('button', { name: /Files/ }).click();
    for (const filename of Object.keys(expectedFiles)) await expect(publicPage.getByText(filename, { exact: true })).toBeVisible();
    await evidence(publicPage, 'anonymous-share-files');
    for (const [filename, content] of Object.entries(expectedFiles)) {
      const file = await anonymous.request.get('/api/share/' + shareId + '/file/' + encodeURIComponent(filename));
      expect(file.ok()).toBeTruthy();
      expect(await file.text()).toBe(content);
    }
    const publicZip = await anonymous.request.get('/api/share/' + shareId + '/batch');
    expect(publicZip.ok()).toBeTruthy();
    writeFileSync(path.join(artifacts, 'public-share.zip'), await publicZip.body());
    const privateZip = await api.get('/api/conversations/' + id + '/files/download-all');
    expect(privateZip.ok()).toBeTruthy();
    writeFileSync(path.join(artifacts, 'authenticated-files.zip'), await privateZip.body());
    expect((await anonymous.request.get('/api/share/e2e-missing-share')).status()).toBe(404);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => !request.authenticated)).toBeTruthy();
    writeFileSync(path.join(artifacts, 'share-verification.json'), JSON.stringify({ expectedFiles, requests }, null, 2));
  } finally {
    await anonymous.close();
  }
});

test('smoke: expired JWT refreshes once and real second-user login clears old identity', async ({ browser }) => {
  test.setTimeout(90_000);
  const invited = await api.post('/api/admin/invite-codes', { data: { max_uses: 1, description: 'E2E isolated identity' } });
  expect(invited.ok()).toBeTruthy();
  const code = (await invited.json()).code as string;
  const secretFile = path.join(path.dirname(process.env.E2E_PRIVATE_CONFIG!), 'extra-secrets.json');
  writeFileSync(secretFile + '.tmp', JSON.stringify([code]), { mode: 0o600 });
  renameSync(secretFile + '.tmp', secretFile);
  const secondUser = 'e2e-second-user';
  const registered = await api.post('/api/auth/register', { data: { user_id: secondUser, password: privateConfig.password, invite_code: code, language: 'en' } });
  expect(registered.ok()).toBeTruthy();
  const isolated = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  try {
    await isolated.addInitScript(value => {
      if (!localStorage.getItem('auth_token') && !sessionStorage.getItem('e2e-initialized')) {
        localStorage.setItem('auth_token', value.expired);
        localStorage.setItem('refresh_token', value.refresh);
        localStorage.setItem('user_info', JSON.stringify({ user_id: value.user, role: 'super_admin' }));
      }
      sessionStorage.setItem('e2e-initialized', 'true');
      localStorage.setItem('app_locale', 'en');
      localStorage.setItem('chat-tour-completed', 'true');
      localStorage.setItem('workspace-tour-completed', 'true');
    }, { expired: privateConfig.expired_access, refresh: auth.refresh_token, user: privateConfig.user });
    const first = await isolated.newPage();
    const statuses: { path: string; status: number }[] = [];
    first.on('response', response => {
      if (response.url().includes('/api/')) statuses.push({ path: new URL(response.url()).pathname, status: response.status() });
    });
    await chooseAgent(first);
    await submit(first, 'E2E_AUTH_OWNER');
    const id = await persisted(first, 'REAL_E2E_RESPONSE: E2E_AUTH_OWNER');
    expect(statuses.filter(row => row.path === '/api/auth/refresh')).toEqual([{ path: '/api/auth/refresh', status: 200 }]);
    expect(statuses.some(row => row.status === 401)).toBeTruthy();
    const second = await isolated.newPage();
    await second.goto('/chat');
    await second.evaluate(() => { localStorage.removeItem('auth_token'); localStorage.removeItem('refresh_token'); localStorage.removeItem('user_info'); });
    await expect(first).toHaveURL(/\/login$/);
    await expect(first.getByText('REAL_E2E_RESPONSE: E2E_AUTH_OWNER', { exact: true })).toHaveCount(0);
    await second.goto('/login');
    await second.locator('input').first().fill(secondUser);
    await second.locator('input[type="password"]').fill(privateConfig.password);
    const loggingIn = second.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
    await second.getByRole('button', { name: /Log in|Login|Sign in/i }).click();
    const loginResponse = await loggingIn;
    expect(loginResponse.ok()).toBeTruthy();
    const secondAuth = await loginResponse.json() as Auth;
    await first.goto('/workspace/agent-manager');
    await expect(first.getByText(agentName, { exact: true })).toHaveCount(0);
    await expect.poll(() => first.evaluate(() => JSON.parse(localStorage.getItem('user_info') ?? '{}').user_id as string)).toBe(secondUser);
    const denied = await isolated.request.get('/api/conversations/' + id, { headers: { Authorization: 'Bearer ' + secondAuth.access_token } });
    expect(denied.status()).toBe(403);
    await evidence(first, 'auth-second-user-cleared');
    writeFileSync(path.join(artifacts, 'auth-refresh-switch.json'), JSON.stringify({ statuses, secondIdentity: secondUser, oldConversationStatus: denied.status() }, null, 2));
  } finally {
    await isolated.close();
  }
});

test('smoke: invalid real refresh ends the browser identity', async ({ browser }) => {
  const isolated = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  try {
    await isolated.addInitScript(expired => {
      if (!sessionStorage.getItem('e2e-initialized')) {
        localStorage.setItem('auth_token', expired);
        localStorage.setItem('refresh_token', 'e2e-invalid-refresh');
        localStorage.setItem('user_info', JSON.stringify({ user_id: 'e2e-user', role: 'super_admin' }));
      }
      sessionStorage.setItem('e2e-initialized', 'true');
      localStorage.setItem('app_locale', 'en');
      localStorage.setItem('chat-tour-completed', 'true');
    }, privateConfig.expired_access);
    const page = await isolated.newPage();
    const refresh = page.waitForResponse(response => response.url().endsWith('/api/auth/refresh'));
    await page.goto('/chat');
    expect((await refresh).status()).toBe(401);
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('auth_token'))).toBeNull();
    await evidence(page, 'auth-invalid-refresh');
  } finally { await isolated.close(); }
});

test('Graph early next-round draft survives server-ID route commitment', async ({ page }) => {
  test.setTimeout(120_000);
  const observations: { iteration: number; conversation: string; draftPreserved: boolean; secondStatus: number }[] = [];
  for (let iteration = 0; iteration < 12; iteration++) {
    await page.goto('/chat');
    await page.getByText('Graph', { exact: true }).click();
    await page.locator('.ant-select-selector').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: graphName }).click();
    const firstMarker = 'E2E_EARLY_FIRST_' + iteration;
    const nextMarker = 'E2E_EARLY_NEXT_' + iteration;
    const firstResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/graphs/execute'));
    await page.locator('textarea').fill(firstMarker);
    await page.locator('textarea').press('Control+Enter');
    expect((await firstResponse).status()).toBe(200);
    await expect(page.getByText('REAL_E2E_RESPONSE: ' + firstMarker, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /Stop generating/ })).toHaveCount(0);
    // 不等待首轮配置写入或详情重载；可编辑期间输入的草稿必须保留。
    await page.locator('textarea').fill(nextMarker);
    const send = page.locator('button').filter({ has: page.locator('svg.lucide-arrow-up') });
    await expect(send).toBeEnabled();
    await expect(page.locator('textarea')).toHaveValue(nextMarker);
    const secondResponse = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/graphs/execute'));
    const saved = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/input-config'));
    await send.click();
    const status = (await secondResponse).status();
    expect(status).toBe(200);
    expect((await saved).ok()).toBeTruthy();
    const id = await persisted(page, 'REAL_E2E_RESPONSE: ' + nextMarker);
    observations.push({ iteration, conversation: id, draftPreserved: true, secondStatus: status });
    writeFileSync(path.join(artifacts, 'graph-early-draft.json'), JSON.stringify(observations, null, 2));
  }
  await evidence(page, 'graph-early-draft-preserved');
});

test('math: real streaming reasoning recovers, code survives and shared formulas scroll locally', async ({ page, context, browser }) => {
  const pageErrors: string[] = [];
  const failedFonts: string[] = [];
  const untrustedRequests: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfailed', request => {
    if (request.resourceType() === 'font') failedFonts.push(new URL(request.url()).pathname);
  });
  page.on('request', request => {
    if (request.url().includes('invalid.example')) untrustedRequests.push(request.url());
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await chooseAgent(page);
  const submission = submit(page, 'E2E_MATH_AGENT');
  // 先观察真实模型流中的残缺阶段，再等待 submit 完成持久化。
  await page.getByText('AI Thinking', { exact: true }).click();
  const reasoning = page.locator('.reasoning-scrollbar');
  await expect(reasoning.locator('.katex-error')).toBeVisible();
  await expect(reasoning.locator('.katex')).toBeVisible();
  await expect(reasoning.locator('.katex-error')).toHaveCount(0);
  const answer = page.locator('.markdown-content').filter({ has: page.getByText('MATH_ANSWER', { exact: true }) });
  await expect(answer.locator('.katex-error')).toBeVisible();
  await submission;
  await expect(answer.getByText('MATH_DONE', { exact: true })).toBeVisible();
  await expect(answer.locator('.katex-display')).toHaveCount(3);
  await expect(answer.locator('.katex-error')).toHaveCount(1);
  await expect(answer.locator('.katex-error')).toContainText('\\frac{1}{');
  await expect(answer.locator('math')).not.toHaveCount(0);
  await expect(answer.getByText('Currency: $5 and $10.', { exact: true })).toBeVisible();
  await expect(answer.locator('a, img')).toHaveCount(0);
  await expect(answer.locator('code').filter({ hasText: '$literal$' })).toContainText('$literal$');
  const code = answer.locator('.code-block-scrollbar');
  await expect(code).toContainText("const formula = '$x$';");
  await expect(code.locator('.katex')).toHaveCount(0);
  await answer.getByText('js', { exact: true }).click();
  await expect(code).toHaveCount(0);
  await answer.getByText('js', { exact: true }).click();
  await expect(code).toContainText("const formula = '$x$';");
  await answer.locator('[aria-label="copy"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("const formula = '$x$';");
  const id = await persisted(page, 'MATH_DONE');
  await page.reload();
  await expect(answer.locator('.katex-display')).toHaveCount(3);
  await page.evaluate(() => document.fonts.ready);
  const fonts = await page.evaluate(() => {
    const loaded: string[] = [];
    document.fonts.forEach(font => {
      if (font.family.startsWith('KaTeX') && font.status === 'loaded') loaded.push(font.family);
    });
    return loaded;
  });
  expect(fonts).toContain('KaTeX_Main');
  expect(fonts).toContain('KaTeX_Math');
  const matrix = await answer.locator('.katex-display').nth(1).evaluate(element => {
    const outer = element.getBoundingClientRect();
    const inner = element.querySelector('.katex-html')!.getBoundingClientRect();
    return { outerTop: outer.top, outerBottom: outer.bottom, innerTop: inner.top, innerBottom: inner.bottom };
  });
  expect(matrix.innerTop).toBeGreaterThanOrEqual(matrix.outerTop - 1);
  expect(matrix.innerBottom).toBeLessThanOrEqual(matrix.outerBottom + 1);
  await evidence(page, 'math-agent-desktop');
  await page.locator('button').filter({ has: page.locator('svg.lucide-chevron-left') }).click();
  await page.setViewportSize({ width: 360, height: 800 });
  const block = answer.locator('.katex-display').nth(2);
  const inline = answer.locator('p').filter({ hasText: /^Long inline:/ }).locator('.katex');
  const widths = [];
  for (const formula of [block, inline]) {
    widths.push(await formula.evaluate(element => {
      const node = element as HTMLElement;
      node.scrollLeft = 100;
      return { client: node.clientWidth, scroll: node.scrollWidth, offset: node.scrollLeft, overflow: getComputedStyle(node).overflowX };
    }));
  }
  writeFileSync(path.join(artifacts, 'math-mobile-widths.json'), JSON.stringify(widths, null, 2));
  for (const width of widths) {
    expect(width.scroll).toBeGreaterThan(width.client);
    expect(width.offset).toBeGreaterThan(0);
    expect(width.overflow).toBe('auto');
  }
  const pageWidth = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.width);
  await block.scrollIntoViewIfNeeded();
  await evidence(page, 'math-agent-mobile');
  const shared = await api.post('/api/conversations/' + id + '/share');
  expect(shared.ok()).toBeTruthy();
  const shareId = (await shared.json()).share_id as string;
  const anonymous = await browser.newContext({ baseURL: process.env.E2E_BASE_URL, viewport: { width: 360, height: 800 } });
  try {
    const publicPage = await anonymous.newPage();
    await publicPage.goto('/share/' + shareId);
    const sharedAnswer = publicPage.locator('.markdown-content').filter({ has: publicPage.getByText('MATH_ANSWER', { exact: true }) });
    await expect(sharedAnswer.locator('.katex-display')).toHaveCount(3);
    await expect(sharedAnswer.locator('.katex-error')).toHaveCount(1);
    const sharedWidth = await publicPage.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    expect(sharedWidth.scroll).toBeLessThanOrEqual(sharedWidth.width);
    await sharedAnswer.locator('.katex-display').nth(2).scrollIntoViewIfNeeded();
    await evidence(publicPage, 'math-share-mobile');
  } finally {
    await anonymous.close();
  }
  expect(pageErrors).toEqual([]);
  expect(failedFonts).toEqual([]);
  expect(untrustedRequests).toEqual([]);
  writeFileSync(path.join(artifacts, 'math-rendering.json'), JSON.stringify({ id, fonts, matrix, widths, pageWidth, pageErrors, failedFonts, untrustedRequests, reasoningRecovered: true, contentRecovered: true, copiedCode: true }, null, 2));
});

test('math: Graph node and final result use the same formulas after reload', async ({ page }) => {
  await page.goto('/chat');
  await page.getByText('Graph', { exact: true }).click();
  await page.locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: graphName }).click();
  await submit(page, 'E2E_MATH_GRAPH', '/api/graphs/execute');
  await persisted(page, 'MATH_DONE');
  await page.reload();
  const summary = page.getByText('Final Result:', { exact: true }).locator('..').locator('.markdown-content');
  await expect(summary.locator('.katex-display')).toHaveCount(3);
  await expect(summary.locator('.katex-error')).toHaveCount(1);
  const answers = page.locator('.markdown-content').filter({ has: page.getByText('MATH_ANSWER', { exact: true }) });
  await expect(answers).toHaveCount(2);
  for (const answer of await answers.all()) {
    await expect(answer.locator('.katex-display')).toHaveCount(3);
    await expect(answer.locator('.code-block-scrollbar')).toContainText("const formula = '$x$';");
  }
  await summary.scrollIntoViewIfNeeded();
  await evidence(page, 'math-graph-final-result');
});

test('math: file split preview and prompt editor constrain long formulas', async ({ page }) => {
  const longFormula = Array.from({ length: 60 }, (_, index) => `x_{${index}}`).join(' + ');
  const content = `MATH_PREVIEW\n\nInline $x^2$.\n\n$$\n${longFormula}\n$$\n\n\`$literal$\`\n\n\`\`\`js\nconst formula = '$x$';\n\`\`\``;
  const created = await api.post('/api/projects', { data: { name: 'E2E Math Preview', instruction: 'Isolated math preview' } });
  expect(created.ok()).toBeTruthy();
  const project = await created.json();
  const id = (project.project_id ?? project.project?.project_id) as string;
  const made = await api.post('/api/projects/' + id + '/files', { data: { filename: 'math.md', summary: 'Math preview', content, log: 'create' } });
  expect(made.ok()).toBeTruthy();
  await page.goto('/workspace/projects/' + id);
  await page.locator('.ant-list-item').filter({ hasText: 'math.md' }).getByRole('button', { name: 'Open', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const preview = dialog.locator('.markdown-content');
  await expect(preview.locator('.katex-display')).toHaveCount(1);
  await expect(preview.locator('pre')).toContainText("const formula = '$x$';");
  await dialog.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(dialog.locator('textarea')).toHaveValue(content);
  const measurements = [];
  for (const viewport of [{ width: 1440, height: 1100 }, { width: 360, height: 800 }]) {
    await page.setViewportSize(viewport);
    const sizes = await preview.evaluate(element => {
      const dialog = element.closest('[role="dialog"]')!;
      const bounds = element.getBoundingClientRect();
      const dialogBounds = dialog.getBoundingClientRect();
      const formula = element.querySelector('.katex-display') as HTMLElement;
      formula.scrollLeft = 100;
      return { viewport: innerWidth, width: bounds.width, right: bounds.right, dialogWidth: dialogBounds.width, dialogRight: dialogBounds.right, formulaWidth: formula.clientWidth, formulaScroll: formula.scrollWidth, scrollLeft: formula.scrollLeft };
    });
    measurements.push(sizes);
    writeFileSync(path.join(artifacts, 'math-preview-widths.json'), JSON.stringify(measurements, null, 2));
    expect(sizes.width).toBeLessThan(sizes.dialogWidth);
    expect(sizes.right).toBeLessThanOrEqual(sizes.dialogRight);
    expect(sizes.formulaScroll).toBeGreaterThan(sizes.formulaWidth);
    expect(sizes.scrollLeft).toBeGreaterThan(0);
    await evidence(page, 'math-file-split-' + viewport.width);
  }
  await dialog.getByRole('button', { name: 'Close', exact: true }).first().click();
  expect((await api.delete('/api/projects/' + id)).ok()).toBeTruthy();
  await page.setViewportSize({ width: 1440, height: 1100 });
  expect((await api.post('/api/prompt/create', { data: { name: 'E2E Math Prompt', category: 'math', content } })).ok()).toBeTruthy();
  await page.goto('/workspace/prompt-manager');
  await page.getByRole('button', { name: /^math / }).click();
  await page.locator('.ant-card').filter({ hasText: 'E2E Math Prompt' }).locator('svg.lucide-pen, svg.lucide-pen-line, svg.lucide-square-pen').click();
  await expect(dialog.locator('.katex-display')).toHaveCount(1);
  await expect(dialog.locator('textarea')).toHaveValue(content);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => dialog.evaluate(element => element.getAnimations().length)).toBe(0);
  const promptSizes = await dialog.locator('.markdown-content').evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const dialogBounds = element.closest('[role="dialog"]')!.getBoundingClientRect();
    const formula = element.querySelector('.katex-display') as HTMLElement;
    formula.scrollLeft = 100;
    return { width: bounds.width, right: bounds.right, dialogWidth: dialogBounds.width, dialogRight: dialogBounds.right, scrollLeft: formula.scrollLeft };
  });
  expect(promptSizes.width).toBeLessThan(promptSizes.dialogWidth);
  expect(promptSizes.right).toBeLessThanOrEqual(promptSizes.dialogRight);
  expect(promptSizes.scrollLeft).toBeGreaterThan(0);
  writeFileSync(path.join(artifacts, 'math-prompt-widths.json'), JSON.stringify(promptSizes, null, 2));
  await evidence(page, 'math-prompt-mobile');
});

async function expectBellmanMath(content: Locator) {
  await expect(content.locator('.katex')).toHaveCount(25);
  await expect(content.locator('.katex-display')).toHaveCount(4);
  await expect(content.locator('.katex-error, em')).toHaveCount(0);
  const formulas = await content.locator('annotation[encoding="application/x-tex"]').allTextContents();
  expect(formulas).toContain('V');
  expect(formulas.some(formula => formula.includes("V^*(s) = \\max_a") && formula.includes("V^*(s')"))).toBe(true);
  expect(formulas.some(formula => formula.includes('Q^*(s, a)') && formula.includes("Q^*(s', a')"))).toBe(true);
  return formulas;
}

test('math delimiters: exact Bellman output persists and renders in chat, share and Graph', async ({ page, browser }) => {
  const sourceSha256 = 'eb4be2240800d1ce249d34316cb70d5f3dbff2dba8b89d64f2d1f70ec6865393';
  const prefix = '贝尔曼方程的数学公式根据具体场景略有不同';
  await chooseAgent(page);
  await submit(page, 'E2E_MATH_DELIMITERS_EXACT');
  const id = await persisted(page, prefix);
  const response = await api.get('/api/conversations/' + id);
  const conversation = await response.json() as { rounds: { messages: { role: string; content?: string }[] }[] };
  const original = conversation.rounds.flatMap(round => round.messages)
    .find(message => message.role === 'assistant' && message.content?.startsWith(prefix))?.content;
  expect(original).toBeDefined();
  const persistedSha256 = createHash('sha256').update(original!).digest('hex');
  expect(persistedSha256).toBe(sourceSha256);
  const answer = page.locator('.markdown-content').filter({ hasText: prefix });
  const formulas = await expectBellmanMath(answer);
  await page.reload();
  await expectBellmanMath(answer);
  await answer.locator('.katex-display').first().scrollIntoViewIfNeeded();
  await evidence(page, 'delimiters-bellman-chat');
  await page.locator('button').filter({ has: page.locator('svg.lucide-chevron-left') }).click();
  await page.setViewportSize({ width: 360, height: 800 });
  const widths = await answer.locator('.katex-display').evaluateAll(elements => elements.map(element => {
    const node = element as HTMLElement;
    node.scrollLeft = 100;
    return { client: node.clientWidth, scroll: node.scrollWidth, offset: node.scrollLeft };
  }));
  const pageWidth = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(pageWidth.scroll).toBeLessThanOrEqual(pageWidth.viewport);
  expect(widths.some(width => width.scroll > width.client && width.offset > 0)).toBe(true);
  await answer.locator('.katex-display').first().scrollIntoViewIfNeeded();
  await evidence(page, 'delimiters-bellman-mobile');
  const shared = await api.post('/api/conversations/' + id + '/share');
  expect(shared.ok()).toBeTruthy();
  const shareId = (await shared.json()).share_id as string;
  const anonymous = await browser.newContext({ baseURL: process.env.E2E_BASE_URL });
  try {
    const publicPage = await anonymous.newPage();
    await publicPage.goto('/share/' + shareId);
    await expectBellmanMath(publicPage.locator('.markdown-content').filter({ hasText: prefix }));
    await evidence(publicPage, 'delimiters-bellman-share');
  } finally {
    await anonymous.close();
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/chat');
  await page.getByText('Graph', { exact: true }).click();
  await page.locator('.ant-select-selector').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content').filter({ hasText: graphName }).click();
  await submit(page, 'E2E_MATH_DELIMITERS_EXACT_GRAPH', '/api/graphs/execute');
  await persisted(page, prefix);
  await page.reload();
  const summary = page.getByText('Final Result:', { exact: true }).locator('..').locator('.markdown-content');
  await expectBellmanMath(summary);
  const graphAnswers = page.locator('.markdown-content').filter({ hasText: prefix });
  await expect(graphAnswers).toHaveCount(2);
  for (const content of await graphAnswers.all()) await expectBellmanMath(content);
  await summary.scrollIntoViewIfNeeded();
  await evidence(page, 'delimiters-bellman-graph');
  writeFileSync(path.join(artifacts, 'delimiters-bellman.json'), JSON.stringify({ sourceSha256, persistedSha256, formulaCount: formulas.length, blockCount: 4, formulas, widths, pageWidth }, null, 2));
});

test('math delimiters: split SSE delimiters preserve reasoning and later fenced code positions', async ({ page, context }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await chooseAgent(page);
  const submission = submit(page, 'E2E_MATH_DELIMITERS_STREAM');
  await page.getByText('AI Thinking', { exact: true }).click();
  const reasoning = page.locator('.reasoning-scrollbar');
  await expect(reasoning).toContainText('\\frac{3}{');
  await expect(reasoning.locator('.katex')).toHaveCount(1);
  await expect(reasoning.locator('annotation')).toHaveText('\\frac{3}{4}');
  const answer = page.locator('.markdown-content').filter({ has: page.getByText('DELIMITER_ANSWER', { exact: true }) });
  await expect(answer.locator('.katex')).toHaveCount(1);
  await expect(answer).toContainText('\\frac{1}{');
  await expect(answer.locator('.katex-display')).toHaveCount(1);
  await expect(answer.locator('.code-block-scrollbar')).toContainText('\\(literal\\)');
  await expect(answer.locator('.preview-button')).toHaveCount(0);
  await answer.getByText('html', { exact: true }).click();
  await expect(answer.locator('.code-block-scrollbar')).toHaveCount(0);
  await expect(answer.getByText('DELIMITER_CODE_CLOSED', { exact: true })).toBeVisible();
  await expect(answer.locator('.preview-button')).toBeVisible();
  await expect(answer.locator('.code-block-scrollbar')).toHaveCount(0);
  await answer.getByText('html', { exact: true }).click();
  const expectedCode = '<p>\\(literal\\) \\[literal\\] $literal$</p>';
  await expect(answer.locator('.code-block-scrollbar')).toHaveText(expectedCode);
  await answer.locator('[aria-label="copy"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedCode);
  await submission;
  await expect(answer.locator('.katex')).toHaveCount(2);
  await expect(answer.locator('.katex-error, .code-block-scrollbar .katex')).toHaveCount(0);
  await expect(answer.getByText('Ordinary (V) and [V].', { exact: true })).toBeVisible();
  await expect(answer.getByRole('link', { name: 'Link', exact: true })).toHaveAttribute('href', 'https://example.com/');
  await expect(answer.locator('code').filter({ hasText: '\\(code\\)' })).toHaveText('\\(code\\)');
  await expect(answer.locator('code').filter({ hasText: '\\[block\\]' })).toHaveText('\\[block\\]');
  await persisted(page, 'DELIMITER_DONE');
  await answer.scrollIntoViewIfNeeded();
  await evidence(page, 'delimiters-stream-code');
  expect(pageErrors).toEqual([]);
  writeFileSync(path.join(artifacts, 'delimiters-stream.json'), JSON.stringify({ reasoningRecovered: true, bodyRecovered: true, splitClosingFence: true, collapsePreserved: true, codeCopied: expectedCode, pageErrors }, null, 2));
});

test('backend quality: Graph upstream failure has one error and no success terminal', async () => {
  const response = await api.post('/api/graphs/execute', { data: { graph_name: graphName, input_text: 'E2E_ERROR_GRAPH_QUALITY' } });
  expect(response.status()).toBe(200);
  const body = await response.text();
  const events = body.split('\n\n').filter(frame => frame.startsWith('data: ') && frame.trim() !== 'data: [DONE]').map(frame => JSON.parse(frame.slice(6)) as { type?: string; error?: unknown; conversation_id?: string });
  expect(events.filter(event => event.error)).toHaveLength(1);
  expect(events.some(event => event.type === 'graph_complete')).toBe(false);
  expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
  const id = events.find(event => event.type === 'conversation_created')?.conversation_id;
  expect(id).toBeTruthy();
  const saved = await api.get('/api/conversations/' + id);
  expect(saved.ok()).toBeTruthy();
  const conversation = await saved.json() as { rounds: { node_name?: string }[]; final_result?: string };
  expect(conversation.rounds.some(round => round.node_name === 'worker')).toBe(false);
  expect(conversation.final_result).toBeFalsy();
  writeFileSync(path.join(artifacts, 'graph-quality-failure.json'), JSON.stringify({ events, persistedRounds: conversation.rounds.length }, null, 2));
});

test('backend quality: Graph ZIP download and multipart import preserve nullable configuration', async () => {
  const name = 'E2E Archive Quality';
  const endpoint = '/api/graphs/' + encodeURIComponent(name);
  const config = { name, description: 'ZIP roundtrip', nodes: [{ name: 'archive-worker', model_name: modelName, user_prompt: '{{start}}', input_nodes: ['start'], output_nodes: ['end'] }] };
  expect((await api.post('/api/graphs', { data: config })).ok()).toBeTruthy();
  try {
    const original = await (await api.get(endpoint)).json() as { name: string; nodes: unknown[]; readme: string };
    const download = await api.get(endpoint + '/export');
    expect(download.ok()).toBeTruthy();
    expect(download.headers()['content-type']).toContain('application/zip');
    const zip = await download.body();
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    writeFileSync(path.join(artifacts, 'graph-quality-roundtrip.zip'), zip);
    expect((await api.delete(endpoint)).ok()).toBeTruthy();
    const imported = await api.post('/api/graphs/import_package_from_file', { multipart: { file: { name: 'graph.zip', mimeType: 'application/zip', buffer: zip } } });
    expect(imported.ok(), `ZIP import status ${imported.status()}`).toBeTruthy();
    expect((await imported.json()).status).toBe('success');
    const restored = await (await api.get(endpoint)).json() as typeof original;
    expect(restored.name).toBe(original.name);
    expect(restored.nodes).toEqual(original.nodes);
    expect(restored.readme).toBe(original.readme);
  } finally {
    await api.delete(endpoint);
  }
});

test('backend quality: a real refresh token has one winner under concurrent rotation', async () => {
  const login = await api.post('/api/auth/login', { data: { user_id: privateConfig.user, password: privateConfig.password } });
  expect(login.ok()).toBeTruthy();
  const fresh = await login.json() as Auth;
  const responses = await Promise.all([
    api.post('/api/auth/refresh', { data: { refresh_token: fresh.refresh_token } }),
    api.post('/api/auth/refresh', { data: { refresh_token: fresh.refresh_token } }),
  ]);
  const statuses = responses.map(response => response.status()).sort((a, b) => a - b);
  expect(statuses).toEqual([200, 401]);
  const replay = await api.post('/api/auth/refresh', { data: { refresh_token: fresh.refresh_token } });
  expect(replay.status()).toBe(401);
  writeFileSync(path.join(artifacts, 'refresh-quality-concurrency.json'), JSON.stringify({ statuses, replayStatus: replay.status() }, null, 2));
});

test('backend quality: conversation file saves update metadata and retain readable versions', async () => {
  const run = await api.post('/api/agent/run', { multipart: { user_prompt: 'E2E_FILE_VERSION_OWNER', model_name: modelName, stream: 'false' } });
  expect(run.ok()).toBeTruthy();
  const id = (await run.json()).conversation_id as string;
  expect(id).toBeTruthy();
  const files = '/api/conversations/' + id + '/files';
  const filename = 'history/note.txt';
  const endpoint = files + '/' + encodeURIComponent(filename);
  try {
    const made = await api.post(files, { data: { filename, summary: 'First summary', content: 'E2E_CONVERSATION_V1', log: 'create' } });
    expect(made.ok()).toBeTruthy();
    const first = (await (await api.get(endpoint)).json()).file as { current_version_id: string; content: string };
    expect(first.content).toBe('E2E_CONVERSATION_V1');
    const saved = await api.put(endpoint, { data: { summary: 'Updated summary', content: 'E2E_CONVERSATION_V2', log: 'save second version' } });
    expect(saved.ok(), `Conversation save status ${saved.status()}`).toBeTruthy();
    const latest = (await (await api.get(endpoint)).json()).file as { current_version_id: string; content: string; summary: string; versions: unknown[] };
    expect(latest.content).toBe('E2E_CONVERSATION_V2');
    expect(latest.summary).toBe('Updated summary');
    expect(latest.current_version_id).not.toBe(first.current_version_id);
    expect(latest.versions).toHaveLength(2);
    const historical = await api.get(endpoint + '/versions/' + encodeURIComponent(first.current_version_id));
    expect(historical.ok()).toBeTruthy();
    const previous = (await historical.json()).file as { content: string; is_current: boolean };
    expect(previous.content).toBe('E2E_CONVERSATION_V1');
    expect(previous.is_current).toBe(false);
    const listed = await (await api.get(files)).json() as { files: string[] };
    expect(listed.files).toContain(filename);
    writeFileSync(path.join(artifacts, 'conversation-quality-versions.json'), JSON.stringify({ latest, previous, listed }, null, 2));
  } finally {
    await api.delete('/api/conversations/' + id);
  }
});
