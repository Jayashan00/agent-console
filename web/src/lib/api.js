const BASE = import.meta.env.VITE_API_BASE || '';

async function request(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export const api = {
  meta: () => request('GET', '/meta'),
  listRuns: () => request('GET', '/runs'),
  getRun: (id) => request('GET', `/runs/${id}`),
  createRun: (goal) => request('POST', '/runs', { goal }),
  deleteRun: (id) => request('DELETE', `/runs/${id}`),
  pause: (id) => request('POST', `/runs/${id}/pause`),
  resume: (id, payload = {}) => request('POST', `/runs/${id}/resume`, payload),
  instruct: (id, instruction) => request('POST', `/runs/${id}/instruct`, { instruction }),
  savePlan: (id, plan) => request('POST', `/runs/${id}/plan`, { plan }),
  abandon: (id) => request('POST', `/runs/${id}/abandon`),
  rollback: (id, stepIndex) => request('POST', `/runs/${id}/rollback`, { stepIndex }),
};

export const streamUrl = (id, from) => `${BASE}/api/runs/${id}/stream${from ? `?from=${from}` : ''}`;
