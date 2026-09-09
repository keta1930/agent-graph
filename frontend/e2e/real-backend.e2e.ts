import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
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
  await chooseAgent(page);
  await submit(page, 'E2E_ERROR');
  await expect(page.getByText(/E2E controlled model error/).first()).toBeVisible();
  await chooseAgent(page);
  await submit(page, 'E2E_AFTER_ERROR');
  await expect(page.getByText('REAL_E2E_RESPONSE: E2E_AFTER_ERROR', { exact: true }).first()).toBeVisible();
  await persisted(page, 'REAL_E2E_RESPONSE: E2E_AFTER_ERROR');
  await evidence(page, 'error-recovered');
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
