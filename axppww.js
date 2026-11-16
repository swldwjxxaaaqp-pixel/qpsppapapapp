/*
 * Cinema Plus Control Worker
 * Cloudflare Workers (JavaScript module)
 * Required binding: KV namespace named CONTROL_KV
 * Required secret: ADMIN_TOKEN (generate at least 32 random characters)
 * Optional variable: ALLOWED_ORIGIN, defaults to https://cee.buzz
 *
 * This Worker stores control settings and announcements. It does not execute shell
 * commands and does not push code to users' devices. The app/site client must call
 * /api/public/config and render the returned maintenance/notices state.
 */

const STATE_KEY = "cinema-plus-control:state:v1";
const DEFAULT_ORIGIN = "https://cee.buzz";
const MAX_BODY_CHARS = 12_000;
const MAX_NOTICES = 25;
const DEFAULT_MAINTENANCE_MESSAGE = "الخدمة متوقفة مؤقتاً للصيانة. نعود إليكم قريباً.";

const ADMIN_HTML = String.raw`<!doctype html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>لوحة تحكم سينما بلس</title>
  <style>
    :root{color-scheme:dark;--bg:#10071c;--panel:#1b0d2b;--line:#493064;--gold:#ffd166;--purple:#a928ff;--text:#fff;--muted:#d2c4e2;--danger:#b92d58;--green:#1f9b70}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at top,#32105a 0,#10071c 48%,#09050e 100%);color:var(--text);font-family:system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;padding:22px}
    main{max-width:920px;margin:auto}.hero,.card{background:linear-gradient(145deg,rgba(43,20,66,.96),rgba(19,10,31,.98));border:1px solid var(--line);border-radius:22px;box-shadow:0 18px 50px #0007}
    .hero{padding:24px;margin-bottom:18px;border-color:#a77b35}.brand{color:var(--gold);font-weight:800;letter-spacing:.3px}.hero h1{font-size:clamp(25px,5vw,36px);margin:7px 0}.hero p,.muted,small{color:var(--muted);line-height:1.7}
    .card{padding:20px;margin:16px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:16px}.card h2{margin:0 0 12px;font-size:21px;color:#ffe7ae}.status{display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;background:#ffffff12;border:1px solid var(--line);font-weight:700}.status.on{color:#ffd5df;border-color:#b94267;background:#72173355}.status.off{color:#baf5d8;border-color:#287653;background:#14573f55}
    label{display:block;font-weight:700;margin:12px 0 6px}input,textarea{width:100%;border:1px solid #644982;border-radius:12px;background:#0d0715;color:#fff;padding:12px 14px;font:inherit;outline:none}input:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 3px #ffd16622}textarea{min-height:95px;resize:vertical}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}button{border:0;border-radius:12px;padding:12px 17px;font:inherit;font-weight:800;cursor:pointer;color:#fff;background:linear-gradient(100deg,#a928ff,#6720b5);box-shadow:0 6px 18px #0004}button:hover{filter:brightness(1.12)}button:focus-visible{outline:3px solid var(--gold);outline-offset:2px}.gold{background:linear-gradient(100deg,#ffe394,#e7a528);color:#241332}.danger{background:linear-gradient(100deg,#c33c67,#8e1e49)}.quiet{background:#ffffff13;border:1px solid var(--line);box-shadow:none}
    .notice{border:1px solid #604379;background:#11091d;border-radius:14px;padding:14px;margin-top:12px}.notice h3{margin:0 0 6px;color:var(--gold)}.notice p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 9px;line-height:1.65}.notice small{display:block;margin-bottom:8px}.msg{padding:11px 14px;border-radius:12px;margin:10px 0;display:none}.msg.show{display:block}.msg.error{background:#72173388;border:1px solid #d65378}.msg.ok{background:#14573f88;border:1px solid #2dbb83}.hidden{display:none!important}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.empty{padding:14px;color:var(--muted);text-align:center;border:1px dashed var(--line);border-radius:12px}
    @media(max-width:520px){body{padding:12px}.hero,.card{padding:16px;border-radius:17px}.actions button{flex:1}}
  </style>
</head>
<body>
<main>
  <header class="hero"><div class="brand">سينما بلس</div><h1>لوحة التحكم</h1><p>إدارة وضع الصيانة والرسائل المعلنة داخل التطبيق.</p></header>
  <div id="noticeMsg" class="msg" role="status" aria-live="polite"></div>
  <section id="login" class="card">
    <h2>دخول المدير</h2>
    <p class="muted">أدخل رمز الإدارة الذي خزّنته كسِرّ باسم ADMIN_TOKEN في إعدادات Worker.</p>
    <label for="token">رمز الإدارة</label><input id="token" type="password" autocomplete="current-password" spellcheck="false">
    <div class="actions"><button id="loginBtn" class="gold">دخول آمن</button></div>
  </section>
  <section id="panel" class="hidden">
    <div class="grid">
      <article class="card">
        <div class="toolbar"><h2>حالة الخدمة</h2><span id="status" class="status">جارٍ التحميل…</span></div>
        <label for="maintenanceMessage">رسالة الصيانة</label><textarea id="maintenanceMessage" maxlength="1000" placeholder="اكتب ما يظهر للمستخدم عند تفعيل الصيانة"></textarea>
        <div class="actions"><button id="enableMaintenance" class="danger">تفعيل الصيانة</button><button id="disableMaintenance" class="gold">إلغاء الصيانة</button></div>
      </article>
      <article class="card">
        <h2>إذاعة رسالة داخل التطبيق</h2>
        <label for="title">عنوان الرسالة</label><input id="title" maxlength="120" placeholder="مثال: إعلان جديد">
        <label for="message">نص الرسالة</label><textarea id="message" maxlength="1000" placeholder="اكتب الرسالة التي ستظهر للمستخدمين"></textarea>
        <label for="expiresHours">مدة ظهور الرسالة (بالساعات)</label><input id="expiresHours" type="number" min="1" max="720" value="168">
        <div class="actions"><button id="publish" class="gold">إذاعة الرسالة</button></div>
        <small>ستصل الرسالة عند اتصال التطبيق بالخادم. لكل رسالة زر إغلاق في واجهة التطبيق بعد إضافة سكربت الربط.</small>
      </article>
    </div>
    <article class="card">
      <div class="toolbar"><h2>الرسائل النشطة</h2><div class="actions"><button id="refresh" class="quiet">تحديث</button><button id="logout" class="quiet">خروج آمن</button></div></div>
      <div id="notices"><div class="empty">لا توجد رسائل.</div></div>
    </article>
  </section>
</main>
<script>
(function(){
  const $=function(id){return document.getElementById(id);};
  const login=$("login"),panel=$("panel"),tokenInput=$("token"),messageBox=$("noticeMsg");
  const STORAGE_KEY="cinema_plus_admin_token";
  function showMessage(text,isError){messageBox.textContent=text;messageBox.className="msg show "+(isError?"error":"ok");setTimeout(function(){messageBox.className="msg";},5500);}
  function authToken(){return sessionStorage.getItem(STORAGE_KEY)||"";}
  function headers(json){const h={"Authorization":"Bearer "+authToken()};if(json)h["Content-Type"]="application/json";return h;}
  async function api(path,method,data){const options={method:method||"GET",headers:headers(data!==undefined)};if(data!==undefined)options.body=JSON.stringify(data);const response=await fetch(path,options);let result={};try{result=await response.json();}catch(_e){}if(!response.ok){const error=new Error(result.error||("HTTP "+response.status));error.status=response.status;throw error;}return result;}
  function signedIn(value){login.classList.toggle("hidden",value);panel.classList.toggle("hidden",!value);}
  function render(state){
    const status=$("status");status.textContent=state.maintenance?"الصيانة مفعّلة":"الخدمة تعمل";status.className="status "+(state.maintenance?"on":"off");
    $("maintenanceMessage").value=state.maintenanceMessage||"";
    const list=$("notices");list.textContent="";
    if(!state.notices||state.notices.length===0){const empty=document.createElement("div");empty.className="empty";empty.textContent="لا توجد رسائل نشطة حالياً.";list.appendChild(empty);return;}
    state.notices.forEach(function(item){
      const card=document.createElement("article");card.className="notice";
      const title=document.createElement("h3");title.textContent=item.title||"رسالة";
      const body=document.createElement("p");body.textContent=item.message||"";
      const meta=document.createElement("small");meta.textContent="تاريخ النشر: "+(item.createdAt||"—")+" | تنتهي: "+(item.expiresAt||"—");
      const remove=document.createElement("button");remove.type="button";remove.className="danger";remove.textContent="حذف الرسالة";
      remove.addEventListener("click",async function(){try{await api("/api/admin/announcements/"+encodeURIComponent(item.id),"DELETE");showMessage("تم حذف الرسالة.",false);await refresh();}catch(e){showMessage("تعذر حذف الرسالة: "+e.message,true);}});
      card.appendChild(title);card.appendChild(body);card.appendChild(meta);card.appendChild(remove);list.appendChild(card);
    });
  }
  async function refresh(){try{const result=await api("/api/admin/state","GET");render(result.state);signedIn(true);}catch(e){if(e.status===401){sessionStorage.removeItem(STORAGE_KEY);signedIn(false);showMessage("رمز الإدارة غير صحيح أو غير مضبوط.",true);}else{showMessage("تعذر تحميل الحالة: "+e.message,true);}}}
  $("loginBtn").addEventListener("click",async function(){const token=tokenInput.value.trim();if(!token){showMessage("أدخل رمز الإدارة أولاً.",true);return;}sessionStorage.setItem(STORAGE_KEY,token);await refresh();});
  tokenInput.addEventListener("keydown",function(e){if(e.key==="Enter")$("loginBtn").click();});
  $("logout").addEventListener("click",function(){sessionStorage.removeItem(STORAGE_KEY);tokenInput.value="";signedIn(false);showMessage("تم تسجيل الخروج من هذه الجلسة.",false);});
  $("refresh").addEventListener("click",refresh);
  $("enableMaintenance").addEventListener("click",async function(){try{await api("/api/admin/maintenance","POST",{enabled:true,message:$("maintenanceMessage").value.trim()});showMessage("تم تفعيل وضع الصيانة.",false);await refresh();}catch(e){showMessage("تعذر تفعيل الصيانة: "+e.message,true);}});
  $("disableMaintenance").addEventListener("click",async function(){try{await api("/api/admin/maintenance","POST",{enabled:false,message:$("maintenanceMessage").value.trim()});showMessage("تم إلغاء وضع الصيانة.",false);await refresh();}catch(e){showMessage("تعذر إلغاء الصيانة: "+e.message,true);}});
  $("publish").addEventListener("click",async function(){const title=$("title").value.trim(),message=$("message").value.trim(),expiresHours=Number($("expiresHours").value||168);if(!title||!message){showMessage("اكتب عنوان الرسالة ونصها.",true);return;}try{await api("/api/admin/announcements","POST",{title:title,message:message,expiresHours:expiresHours});$("title").value="";$("message").value="";showMessage("تمت إذاعة الرسالة.",false);await refresh();}catch(e){showMessage("تعذر إذاعة الرسالة: "+e.message,true);}});
  if(authToken()){signedIn(true);refresh();}
})();
</script>
</body>
</html>`;

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function baseHeaders(contentType) {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
  });
  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

function publicCorsHeaders(request, env) {
  const headers = baseHeaders("application/json; charset=utf-8");
  const origin = request.headers.get("Origin");
  const allowedOrigin = env.ALLOWED_ORIGIN || DEFAULT_ORIGIN;
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  if (origin && origin === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function jsonResponse(data, status = 200, request = null, env = null, isPublic = false) {
  const headers = isPublic && request && env
    ? publicCorsHeaders(request, env)
    : baseHeaders("application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

function htmlResponse(html) {
  const headers = baseHeaders("text/html; charset=utf-8");
  headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  return new Response(html, { status: 200, headers });
}

function requireStorage(env) {
  if (!env.CONTROL_KV || typeof env.CONTROL_KV.get !== "function" || typeof env.CONTROL_KV.put !== "function") {
    throw new HttpError(503, "kv_binding_missing");
  }
}

function defaultState() {
  return {
    maintenance: false,
    maintenanceMessage: DEFAULT_MAINTENANCE_MESSAGE,
    notices: [],
    updatedAt: new Date().toISOString()
  };
}

async function readState(env) {
  requireStorage(env);
  const raw = await env.CONTROL_KV.get(STATE_KEY);
  if (!raw) return defaultState();
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (_error) {
    stored = {};
  }
  const now = Date.now();
  const notices = Array.isArray(stored.notices)
    ? stored.notices.filter((item) => item && typeof item.id === "string" && (!item.expiresAt || Date.parse(item.expiresAt) > now)).slice(0, MAX_NOTICES)
    : [];
  return {
    maintenance: stored.maintenance === true,
    maintenanceMessage: typeof stored.maintenanceMessage === "string" ? stored.maintenanceMessage.slice(0, 1000) : DEFAULT_MAINTENANCE_MESSAGE,
    notices,
    updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : new Date().toISOString()
  };
}

async function saveState(env, state) {
  requireStorage(env);
  state.updatedAt = new Date().toISOString();
  await env.CONTROL_KV.put(STATE_KEY, JSON.stringify(state));
}

function safeEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN;
  if (typeof expected !== "string" || expected.length < 32) return false;
  const header = request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return Boolean(match && safeEqual(match[1], expected));
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > MAX_BODY_CHARS) throw new HttpError(413, "body_too_large");
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) throw new HttpError(413, "body_too_large");
  let data;
  try {
    data = JSON.parse(text);
  } catch (_error) {
    throw new HttpError(400, "invalid_json");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new HttpError(400, "json_object_required");
  return data;
}

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function publicState(state) {
  return {
    service: "cinema-plus",
    maintenance: state.maintenance,
    maintenanceMessage: state.maintenanceMessage,
    notices: state.notices.map((notice) => ({
      id: notice.id,
      title: notice.title,
      message: notice.message,
      createdAt: notice.createdAt,
      expiresAt: notice.expiresAt,
      dismissible: true,
      closeButtonLabel: "إغلاق"
    })),
    updatedAt: state.updatedAt
  };
}

async function handleAdminApi(request, env, url) {
  if (typeof env.ADMIN_TOKEN !== "string" || env.ADMIN_TOKEN.length < 32) {
    return jsonResponse({ error: "admin_secret_not_configured" }, 503);
  }
  if (!authorized(request, env)) return jsonResponse({ error: "unauthorized" }, 401);
  requireStorage(env);

  if (url.pathname === "/api/admin/state" && request.method === "GET") {
    const state = await readState(env);
    return jsonResponse({ ok: true, state });
  }

  if (url.pathname === "/api/admin/maintenance" && request.method === "POST") {
    const body = await readJson(request);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled_must_be_boolean");
    const state = await readState(env);
    state.maintenance = body.enabled;
    if (typeof body.message === "string") {
      const message = cleanText(body.message, 1000);
      state.maintenanceMessage = message || DEFAULT_MAINTENANCE_MESSAGE;
    }
    await saveState(env, state);
    return jsonResponse({ ok: true, state });
  }

  if (url.pathname === "/api/admin/announcements" && request.method === "POST") {
    const body = await readJson(request);
    const title = cleanText(body.title, 120);
    const message = cleanText(body.message, 1000);
    if (!title || !message) throw new HttpError(400, "title_and_message_required");
    const expiresHours = body.expiresHours === undefined ? 168 : Number(body.expiresHours);
    if (!Number.isFinite(expiresHours) || expiresHours < 1 || expiresHours > 720) {
      throw new HttpError(400, "expires_hours_must_be_1_to_720");
    }
    const state = await readState(env);
    const now = new Date();
    const notice = {
      id: crypto.randomUUID(),
      title,
      message,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresHours * 60 * 60 * 1000).toISOString()
    };
    state.notices = [notice, ...state.notices].slice(0, MAX_NOTICES);
    await saveState(env, state);
    return jsonResponse({ ok: true, notice });
  }

  const deleteMatch = url.pathname.match(/^\/api\/admin\/announcements\/([A-Za-z0-9-]{1,80})$/);
  if (deleteMatch && request.method === "DELETE") {
    const id = deleteMatch[1];
    const state = await readState(env);
    const next = state.notices.filter((notice) => notice.id !== id);
    if (next.length === state.notices.length) throw new HttpError(404, "announcement_not_found");
    state.notices = next;
    await saveState(env, state);
    return jsonResponse({ ok: true, state });
  }

  return jsonResponse({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if ((url.pathname === "/" || url.pathname === "/admin") && request.method === "GET") {
        return htmlResponse(ADMIN_HTML);
      }

      if (url.pathname === "/health" && request.method === "GET") {
        return jsonResponse({ ok: true, service: "cinema-plus-control", storageConfigured: Boolean(env.CONTROL_KV), time: new Date().toISOString() });
      }

      if (url.pathname === "/api/public/config") {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: publicCorsHeaders(request, env) });
        }
        if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, request, env, true);
        const state = await readState(env);
        return jsonResponse(publicState(state), 200, request, env, true);
      }

      if (url.pathname.startsWith("/api/admin/")) {
        return await handleAdminApi(request, env, url);
      }

      return jsonResponse({ error: "not_found" }, 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "internal_error";
      const isPublic = url.pathname === "/api/public/config";
      return jsonResponse({ error: code }, status,
        isPublic ? request : null, isPublic ? env : null, isPublic);
    }
  }
};
