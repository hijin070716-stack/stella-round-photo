const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

function config(env) {
  const url = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw new Error('Cloudflare Pages 환경 변수 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY를 설정해 주세요.');
  return { url, key };
}

async function db(env, path, options = {}) {
  const { url, key } = config(env);
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) {
    const error = new Error(body?.message || body?.hint || `Database error ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function getState(env) {
  const rows = await db(env, 'app_state?id=eq.1&select=payload');
  return rows?.length ? rows[0].payload : null;
}

async function requireAdmin(env, password) {
  const expected = String(env.ADMIN_PASSWORD || '');
  if (!expected) throw new Error('Cloudflare Pages 환경 변수 ADMIN_PASSWORD를 먼저 설정해 주세요.');
  if (!password || password !== expected) {
    const error = new Error('관리자 비밀번호가 맞지 않아요.');
    error.status = 401;
    throw error;
  }
}

async function storageUploadTicket(env, fileName, contentType, size) {
  const { url, key } = config(env);
  const bucket = 'stella-media';
  if (!Number.isFinite(size) || size <= 0 || size > 20 * 1024 * 1024) {
    const error = new Error('사진과 GIF는 각각 최대 20MB까지 업로드할 수 있어요.'); error.status = 413; throw error;
  }
  if (!String(contentType || '').startsWith('image/')) {
    const error = new Error('이미지 파일만 업로드할 수 있어요.'); error.status = 400; throw error;
  }
  const auth = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const listResponse = await fetch(`${url}/storage/v1/bucket`, { headers: auth });
  if (!listResponse.ok) {
    const detail = await listResponse.text().catch(() => '');
    throw new Error(`Supabase Storage 목록 확인 실패 (${listResponse.status})${detail ? ': ' + detail.slice(0, 300) : ''}`);
  }
  const buckets = await listResponse.json().catch(() => []);
  const exists = Array.isArray(buckets) && buckets.some(item => item.id === bucket || item.name === bucket);
  if (!exists) {
    const createResponse = await fetch(`${url}/storage/v1/bucket`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ id: bucket, name: bucket, public: true, fileSizeLimit: 20971520, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] }),
    });
    if (!createResponse.ok && createResponse.status !== 409) {
      const detail = await createResponse.text();
      throw new Error(`Supabase Storage 버킷 생성 실패 (${createResponse.status}): ${detail.slice(0, 350)}`);
    }
  }
  const safeName = String(fileName || 'upload.gif').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'upload.gif';
  const path = `entries/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const signResponse = await fetch(`${url}/storage/v1/object/upload/sign/${bucket}/${encodedPath}`, {
    method: 'POST', headers: auth, body: JSON.stringify({ upsert: true }),
  });
  const signText = await signResponse.text();
  let signed = {}; try { signed = signText ? JSON.parse(signText) : {}; } catch {}
  if (!signResponse.ok || !signed.token) throw new Error(signed.message || signed.error || `업로드 주소 생성 실패 (${signResponse.status})`);
  return {
    uploadUrl: `${url}/storage/v1/object/upload/sign/${bucket}/${encodedPath}?token=${encodeURIComponent(signed.token)}`,
    publicUrl: `${url}/storage/v1/object/public/${bucket}/${encodedPath}`,
    path, bucket,
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    if (request.method === 'GET') return json({ data: await getState(env) });
    if (request.method !== 'POST') return json({ error: '지원하지 않는 요청이에요.' }, 405);
    let body;
    try { body = await request.json(); } catch { return json({ error: '요청 데이터 형식이 올바르지 않아요.' }, 400); }

    if (body.action === 'adminLogin') {
      await requireAdmin(env, body.password);
      let current = await getState(env);
      if (!current) {
        current = body.data;
        if (!current || !current.settings) throw new Error('초기 데이터가 올바르지 않아요.');
        await db(env, 'app_state', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ id: 1, payload: current }) });
      }
      return json({ ok: true, data: await getState(env) });
    }
    if (body.action === 'createUpload') {
      await requireAdmin(env, body.password);
      return json(await storageUploadTicket(env, body.fileName, body.contentType, Number(body.size)));
    }
    if (body.action === 'adminSave') {
      await requireAdmin(env, body.password);
      const next = body.data;
      if (!next || !Array.isArray(next.trainees) || !next.settings) return json({ error: '저장할 데이터 형식이 올바르지 않아요.' }, 400);
      await db(env, 'app_state', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify({ id: 1, payload: next }) });
      return json({ data: await getState(env) });
    }
    return json({ error: '알 수 없는 요청이에요.' }, 400);
  } catch (error) {
    console.error('stella-api:', error);
    return json({ error: error.message || '서버 오류가 발생했어요.' }, error.status || 500);
  }
}
