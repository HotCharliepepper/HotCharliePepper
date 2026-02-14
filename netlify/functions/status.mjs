import { getStore } from "@netlify/blobs";

export const config = { path: "/api/status" };

const STORE_NAME = "wknd-bokjori-event";
const store = getStore({ name: STORE_NAME, consistency: "strong" }); // strong 권장 :contentReference[oaicite:4]{index=4}

function kstISO(d) {
  // 보기 좋은 KST 문자열
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const kst = new Date(utc + 9 * 3600000);
  return kst.toISOString().replace("T", " ").slice(0, 16) + " KST";
}

function getWindow() {
  // Netlify.env.get 사용 가능 :contentReference[oaicite:5]{index=5}
  const startRaw = (globalThis.Netlify?.env?.get("WKND_EVENT_START") || "").trim();
  const endRaw   = (globalThis.Netlify?.env?.get("WKND_EVENT_END") || "").trim();

  // 예시 기본값: 일요일 하루 (원하는 날짜로 ENV에서 바꾸면 됨)
  const start = startRaw ? new Date(startRaw) : new Date("2026-02-22T00:00:00+09:00");
  const end   = endRaw   ? new Date(endRaw)   : new Date("2026-02-22T23:59:59+09:00");
  return { start, end };
}

async function ensureInventory() {
  const inv = await store.get("inventory", { type: "json" }); // get(type:'json') :contentReference[oaicite:6]{index=6}
  if (inv) return inv;

  // 최초 1회 자동 시드(원하면 수정)
  const seeded = { p1: 1, p2: 3, p3: 10 };
  await store.setJSON("inventory", seeded);
  return seeded;
}

export default async () => {
  const { start, end } = getWindow();
  const now = new Date();

  const inv = await ensureInventory();
  const remaining = {
    p1: inv.p1,
    p2: inv.p2,
    p3: inv.p3,
    total: (inv.p1 + inv.p2 + inv.p3)
  };

  const isOpen = now >= start && now <= end;

  return new Response(JSON.stringify({
    isOpen,
    remaining,
    window: {
      startKST: kstISO(start),
      endKST: kstISO(end),
    }
  }), {
    headers: { "content-type": "application/json; charset=utf-8" }
  });
};
