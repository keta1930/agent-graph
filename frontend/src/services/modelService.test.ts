import { afterEach, expect, it } from 'vitest';
import api from './api';
import { getModelForEdit, updateModel } from './modelService';

const adapter = api.defaults.adapter;
afterEach(() => { api.defaults.adapter = adapter; });

it('unwraps the backend model detail envelope and retains the model identity for saving', async () => {
  const model = {
    name: 'provider/model%23中文', base_url: 'https://example.test/v1', model: 'model-id',
    provider: 'openai', model_type: 'llm', temperature: 0.4, max_tokens: 100,
    extra_body: { reasoning: { enabled: true } }, extra_headers: { 'X-Mode': 'test' },
  };
  const requests: { method?: string; url?: string; data: unknown }[] = [];
  api.defaults.adapter = async config => {
    requests.push({ method: config.method, url: config.url, data: config.data });
    return {
      config, headers: {}, status: 200, statusText: 'OK',
      // model_routes.get_model_for_edit 返回 status/data，列表接口才直接返回配置。
      data: config.method === 'get' ? { status: 'success', data: model } : { status: 'success' },
    };
  };

  const editing = await getModelForEdit(model.name);
  expect(editing).toEqual(model);
  await updateModel(editing.name, { ...editing, temperature: 0.8 });
  expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
    { method: 'get', url: `/models/${encodeURIComponent(model.name)}` },
    { method: 'put', url: `/models/${encodeURIComponent(model.name)}` },
  ]);
  expect(JSON.parse(String(requests[1].data))).toEqual({ ...model, temperature: 0.8 });
});

it.each([
  { status: 'error', message: 'model unavailable' },
  { status: 'success' },
  { status: 'success', data: null },
])('rejects an unusable model detail envelope: %j', async data => {
  api.defaults.adapter = async config => ({ config, headers: {}, status: 200, statusText: 'OK', data });
  await expect(getModelForEdit('model')).rejects.toThrow('Invalid model detail response');
});
