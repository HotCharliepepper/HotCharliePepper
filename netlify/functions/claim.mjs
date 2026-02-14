import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

export const config = { path: "/api/claim" };

const STORE_NAME = "wknd-bokjori-event";
const store = getStore({ name: STORE_NAME, consistency: "strong" }); // strong 권장 :contentReference[oaicite:7]{index=7}

function getWindow() {
  const startRaw = (globalThis.Netlify?.env?.get("WKND_EVENT_START") || "").trim();
  const endRaw   = (globalThis.Netlify?.env?.get("WKND_EVENT_END") || "").trim();
  const start = startRaw ? new Date(startRaw) : new Date("2026-02-22T00:00:00+09:00");
  const end   = endRaw   ? new Date(endRaw)   : new Date("2026-02-22T23:59:59+09:00");
  return { start, end };
}

function getClientIP(req) {
  // Netlify는 X-Nf-Client-Connection-Ip만 장기 보장한다고 안내 :contentReference[oaicite:8]{index=8}
  return req.headers.get("x-nf-client-connection-ip") || "0.0.0.0";
}

function fingerprint(ip, ua, salt) {
  return crypto.createHash("sha256").update(`${ip}|${ua}|${salt}`).digest("hex");
}

function newClaimCode() {
  return crypto.randomBytes(6).toString("hex").toUpperCase();
}

// ---- Best-effort lock (Blobs는 트랜잭션이 아니라 마지막 쓰기 승리) :contentReference[oaicite:9]{index=9}
// 작은 이벤트 트래픽에서 “중복 당첨” 확률을 크게 낮추는 용도
async function acquireLock(token, maxTry = 25) {
  for (let i = 0; i < maxTry; i++) {
    const lock = await store.get("lock", { type: "json" });
    const now = Date.now();

    if (!lock || lock.expiresAt < now) {
      await store.setJSON("lock", { token, expiresAt: now + 4000 }); // 4초 락
      const confirm = await store.get("lock", { type: "json" });
      if (confirm?.token === token) return true;
    }

    // 짧은 랜덤 대기
    await new Promise(r => setTimeout(r, 60 + Math.floor(Math.random() * 90)));
  }
  return false;
}

async function releaseLock(token) {
  const lock = await store.get("lock", { type: "json" });
  if (lock?.token === token) {
    await store.delete("lock");
  }
}

async function ensureInventory() {
  const inv = await store.get("inventory", { type: "json" });
  if (inv) return inv;
  const seeded = { p1: 1, p2: 3, p3: 10 };
  await store.setJSON("inventory", seeded);
  return seeded;
}

function pickPrize(inv) {
  if (inv.p1 > 0) return { key: "p1", label: "🥇 1복(초레어) — 10만원권/할인", type: "P1" };
  if (inv.p2 > 0) return { key: "p2", label: "🥈 2복(레어) — 3만원권/30% 할인", type: "P2" };
  if (inv.p3 > 0) return { key: "p3", label: "🥉 3복(기본) — 1만원권/10% 할인", type: "P3" };
  return { key: null, label: "🎁 참가상 — 인상 정돈 체크리스트(PDF) + 다음 이벤트 우선 알림", type: "NONE" };
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ message: "POST only" }), { status: 405 });
  }

  const { start, end } = getWindow();
  const now = new Date();
  if (now < start || now > end) {
    return new Response(JSON.stringify({ message: "아직 오픈 전이거나 마감되었습니다." }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const body = await req.json().catch(() => ({}));
  const nickname = (body.nickname || "").toString().trim().slice(0, 20);
  if (!nickname) {
    return new Response(JSON.stringify({ message: "닉네임을 입력해 주세요." }), { status: 400 });
  }

  const ip = getClientIP(req);
  const ua = req.headers.get("user-agent") || "";
  const salt = (globalThis.Netlify?.env?.get("WKND_SALT") || "wknd-default-salt");
  const fp = fingerprint(ip, ua, salt);

  // 이미 참여(클레임)했으면 같은 결과 반환
  const existing = await store.get(`claims/${fp}`, { type: "json" });
  if (existing) {
    return new Response(JSON.stringify(existing), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const lockToken = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const locked = await acquireLock(lockToken);

  if (!locked) {
    return new Response(JSON.stringify({ message: "접속이 몰려서 잠시 지연 중입니다. 새로고침 후 다시 시도해 주세요." }), {
      status: 429,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  try {
    const inv = await ensureInventory();
    const prize = pickPrize(inv);

    if (prize.key) inv[prize.key] = Math.max(0, inv[prize.key] - 1);
    await store.setJSON("inventory", inv);

    const claimCode = newClaimCode();
    const payload = {
      ok: true,
      nickname,
      prize: { type: prize.type, label: prize.label },
      claimCode,
      at: new Date().toISOString()
    };

    await store.setJSON(`claims/${fp}`, payload);
    await store.setJSON(`claims_by_time/${payload.at}_${claimCode}`, payload);

    return new Response(JSON.stringify(payload), {
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  } finally {
    await releaseLock(lockToken);
  }
};
