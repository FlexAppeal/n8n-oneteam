import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { IExecuteFunctions } from 'n8n-workflow';
import { oneteamApiRequest } from '../nodes/Oneteam/GenericFunctions';
import { OneteamApi } from '../credentials/OneteamApi.credentials';

function context(detail?: string): IExecuteFunctions {
  return {
    getCredentials: async () => ({ baseUrl: 'https://example.invalid' }),
    getNode: () => ({ name: 'Oneteam', type: 'oneteam', typeVersion: 1, position: [0, 0], parameters: {} }),
    helpers: {
      httpRequestWithAuthentication: async () => {
        throw { statusCode: 403, error: detail ? { detail } : {} };
      },
    },
  } as unknown as IExecuteFunctions;
}

for (const path of [
  '/v1/organisations/org-1/forms',
  '/v1/organisations/org-1/forms/form-1',
  '/v1/organisations/org-1/forms/form-1/screens',
  '/v1/organisations/org-1/forms/form-1/screens/screen-1',
]) {
  test(`task writes mention tasks.create, not forms.create: ${path}`, async () => {
    await assert.rejects(oneteamApiRequest.call(context(), 'POST', path, { form_type: 'task' }),
      (error: Error) => /tasks\.create/.test(error.message) && !/forms\.create/.test(error.message));
  });
}

test('screen writes without form_type explain both definition scopes', async () => {
  await assert.rejects(oneteamApiRequest.call(context(), 'POST', '/v1/organisations/org-1/forms/form-1/screens', { question: { text: 'Done?' } }),
    /tasks\.create.*forms\.create/);
});

test('implicit task creation uses task settings for the scope hint', async () => {
  await assert.rejects(oneteamApiRequest.call(context(), 'POST', '/v1/organisations/org-1/forms', { settings: { task: { cadence: 'recurring' } } }),
    /tasks\.create/);
});

test('publishing an existing task gives type-dependent guidance without a payload type', async () => {
  await assert.rejects(oneteamApiRequest.call(context(), 'PUT', '/v1/organisations/org-1/forms/form-1', { status: 'live' }),
    /tasks\.create.*forms\.create/);
});

test('form collection POST is not described as listing', async () => {
  await assert.rejects(oneteamApiRequest.call(context(), 'POST', '/v1/organisations/org-1/forms', { title: 'Form' }),
    /forms\.create/);
});

test('form collection GET remains scope-free listing guidance', async () => {
  await assert.rejects(oneteamApiRequest.call(context(), 'GET', '/v1/organisations/org-1/forms'),
    /Listing forms and courses does not need an extra scope/);
});

for (const detail of [
  'Service account is missing the tasks.create permission.',
  'Service account is missing the forms.create permission.',
  'You do not have access to this network',
]) {
  test(`preserves authoritative API detail: ${detail}`, async () => {
    await assert.rejects(oneteamApiRequest.call(context(detail), 'PUT', '/v1/organisations/org-1/forms/form-1/screens/screen-1'),
      (error: Error) => error.message === detail);
  });
}

test('task response updates still require tasks.update', async () => {
  await assert.rejects(oneteamApiRequest.call(context(), 'PUT', '/v1/organisations/org-1/tasks/task-1/response_status'), /tasks\.update/);
});

test('form reports still require forms.view-report', async () => {
  await assert.rejects(oneteamApiRequest.call(context(), 'GET', '/v1/organisations/org-1/forms/form-1/submissions'), /forms\.view-report/);
});

test('credential hint distinguishes task definitions from standard forms', () => {
  const hint = String(new OneteamApi().properties.find((p) => p.name === 'apiToken')?.description);
  assert.match(hint, /tasks\.create for task definitions/);
  assert.match(hint, /forms\.create for standard forms/);
});
