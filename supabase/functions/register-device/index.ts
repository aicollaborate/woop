// Flowix 桌面端"启动设备登记 / last_seen 刷新" Edge Function。
//
// 客户端 (Rust / Tauri) 在启动 10s 后 POST 最小化的安装登记信息:
//   { deviceId, os, arch, appVersion, installedAt }
// deviceId 是应用首次安装时随机生成的 UUID，不读取稳定机器标识。
//
// 服务端用 service_role 写 `device_registrations` 表, upsert by device_id:
//   - 新设备: insert, 返回 firstSeen=true
//   - 已登记设备: refresh last_seen_at / app_version / os / arch
//                 (installed_at 保留原始时间), firstSeen=false
//
// 网络层语义与现有 `product-update-notices` 完全一致, anon key 通过 header
// 传, 真正写入用 service_role 绕 RLS。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

interface IncomingPayload {
  deviceId?: unknown;
  os?: unknown;
  arch?: unknown;
  appVersion?: unknown;
  installedAt?: unknown;
}

function asString(v: unknown, max = 256): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

function asUuid(v: unknown): string | null {
  const s = asString(v, 64);
  if (!s) return null;
  // 最简 uuid 校验, 详细规则由 PG unique constraint 兜底。
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return null;
  }
  return s.toLowerCase();
}

function asIsoTime(v: unknown): string | null {
  const s = asString(v, 64);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({ error: "missing_supabase_env" }, 500);
  }

  let body: IncomingPayload;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_json", detail: String(err) }, 400);
  }

  const deviceId = asUuid(body.deviceId);
  const os = asString(body.os, 32);
  const arch = asString(body.arch, 32);
  const appVersion = asString(body.appVersion, 32);
  const installedAt = asIsoTime(body.installedAt);

  if (!deviceId) return jsonResponse({ error: "invalid_deviceId" }, 400);
  if (!os) return jsonResponse({ error: "invalid_os" }, 400);
  if (!arch) return jsonResponse({ error: "invalid_arch" }, 400);
  if (!appVersion) return jsonResponse({ error: "invalid_appVersion" }, 400);
  if (!installedAt) return jsonResponse({ error: "invalid_installedAt" }, 400);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // 先查这行是否存在, 决定 firstSeen ── 比 `returning` 的 raw 数据多读一次,
  // 但语义最清晰。
  const { data: existing } = await supabase
    .from("device_registrations")
    .select("id")
    .eq("device_id", deviceId)
    .maybeSingle();

  const updatePayload = {
    os,
    arch,
    app_version: appVersion,
    last_seen_at: new Date().toISOString(),
  };
  const mutation = existing
    ? supabase
        .from("device_registrations")
        .update(updatePayload)
        .eq("device_id", deviceId)
    : supabase
        .from("device_registrations")
        .insert({
          device_id: deviceId,
          ...updatePayload,
          installed_at: installedAt,
        });
  const { data, error } = await mutation.select("id").single();

  if (error || !data) {
    return jsonResponse(
      { error: "db_error", detail: error?.message ?? "unknown" },
      500
    );
  }

  return jsonResponse({
    rowId: data.id,
    firstSeen: !existing,
  });
});
