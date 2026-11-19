import { getStore } from "@netlify/blobs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const COOKIE = "poizy_admin_session";
const SESSION_SECONDS = 8 * 60 * 60;
const MAX_BODY = 64 * 1024;
const store = () => getStore({ name: "poizy-warranties", consistency: "strong" });

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
function secret() {
  const value = process.env.ADMIN_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("ADMIN_SESSION_SECRET belum diatur (minimal 32 karakter).");
  return value;
}
function sign(value) {
  return createHmac("sha256", secret()).update(value).digest("hex");
}
function cookieValue(request) {
  const raw = request.headers.get("cookie") || "";
  const item = raw.split(";").map(v => v.trim()).find(v => v.startsWith(COOKIE + "="));
  return item ? decodeURIComponent(item.slice(COOKIE.length + 1)) : "";
}
function validSession(request) {
  try {
    const token = cookieValue(request);
    const [expires, nonce, signature] = token.split(".");
    if (!expires || !nonce || !signature || Number(expires) < Math.floor(Date.now() / 1000)) return false;
    const expected = sign(expires + "." + nonce);
    const a = Buffer.from(signature, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new Error("Ukuran data terlalu besar.");
  try { return JSON.parse(text || "{}"); }
  catch { throw new Error("Format JSON tidak valid."); }
}
function cleanString(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function recordKey(value) {
  return cleanString(value, 80).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}
function isAdmin(request) { return validSession(request); }

export default async (request) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  try {

    if (method === "GET" && path === "/api/health") {
      return json({
        ok: true,
        assistant: "PAPOI",
        aiConfigured: Boolean(process.env.OPENAI_API_KEY),
        model: (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim()
      });
    }

    if (method === "POST" && path === "/api/ai-chat") {
      const body = await readBody(request);
      const message = cleanString(body.message, 1200);
      if (!message) return json({ error: "Tulis pertanyaan terlebih dahulu." }, 400);
      if (!process.env.OPENAI_API_KEY) {
        return json({ error: "PAPOI belum dikonfigurasi. Pastikan OPENAI_API_KEY tersedia pada Environment Variables Netlify untuk Functions, lalu deploy ulang." }, 503);
      }
      const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: (process.env.OPENAI_MODEL || "gpt-4.1-mini").trim(),
          temperature: 0.3,
          max_tokens: 500,
          messages: [
            {
              role: "system",
              content: "Identitas Anda adalah PAPOI, asisten AI resmi PoijutStore untuk layanan servis HP di Yogyakarta. Jika ditanya nama, jawab PAPOI. Selalu gunakan Bahasa Indonesia yang jelas, ringkas, ramah, dan profesional. Bantu pengguna memahami layanan servis iPhone dan Android, gejala kerusakan, perawatan perangkat, serta informasi PoijutStore. Jangan mengarang harga, stok, garansi, alamat, atau jadwal yang tidak tersedia dalam konteks. Untuk kerusakan perangkat, berikan kemungkinan penyebab sebagai indikasi awal dan jelaskan bahwa diagnosis pasti memerlukan pemeriksaan teknisi. Jangan meminta kata sandi, OTP, atau data pembayaran."
            },
            { role: "user", content: message }
          ]
        })
      });
      const result = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        console.error("OpenAI API error:", upstream.status, result?.error?.message || "Unknown error");
        return json({ error: "Layanan AI sedang bermasalah. Silakan coba beberapa saat lagi." }, 502);
      }
      const reply = result?.choices?.[0]?.message?.content;
      if (typeof reply !== "string" || !reply.trim()) return json({ error: "AI belum menghasilkan jawaban. Coba ulangi." }, 502);
      return json({ reply: reply.trim() });
    }

    if (method === "POST" && path === "/api/admin/login") {
      const body = await readBody(request);
      const username = process.env.ADMIN_USERNAME;
      const password = process.env.ADMIN_PASSWORD;
      if (!username || !password) return json({ error: "ADMIN_USERNAME dan ADMIN_PASSWORD belum diatur di Netlify." }, 503);
      const suppliedUser = cleanString(body.username, 100);
      const suppliedPass = typeof body.password === "string" ? body.password : "";
      if (suppliedUser !== username || suppliedPass !== password) {
        return json({ error: "Username atau password salah." }, 401);
      }
      const expires = String(Math.floor(Date.now() / 1000) + SESSION_SECONDS);
      const nonce = randomBytes(24).toString("hex");
      const token = `${expires}.${nonce}.${sign(expires + "." + nonce)}`;
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, SESSION_SECONDS) });
    }

    if (method === "POST" && path === "/api/admin/logout") {
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
    }

    if (method === "GET" && path === "/api/admin/session") {
      return isAdmin(request) ? json({ ok: true }) : json({ error: "Sesi admin tidak valid." }, 401);
    }

    if (method === "POST" && path === "/api/admin/warranties") {
      if (!isAdmin(request)) return json({ error: "Silakan login sebagai admin." }, 401);
      const body = await readBody(request);
      const key = recordKey(body.invNo);
      if (!key) return json({ error: "Nomor invoice/resi wajib diisi." }, 400);
      const record = {
        invNo: key,
        name: cleanString(body.name, 160),
        phone: cleanString(body.phone, 30),
        device: cleanString(body.device, 160),
        warranty: cleanString(body.warranty, 120),
        payMethod: cleanString(body.payMethod, 80),
        items: Array.isArray(body.items) ? body.items.slice(0, 30).map(item => ({
          desc: cleanString(item?.desc, 300),
          price: Math.max(0, Number(item?.price) || 0),
          qty: Math.max(1, Math.min(99, Math.trunc(Number(item?.qty) || 1)))
        })) : [],
        subtotal: Math.max(0, Number(body.subtotal) || 0),
        dp: Math.max(0, Number(body.dp) || 0),
        remaining: Math.max(0, Number(body.remaining) || 0),
        statusText: cleanString(body.statusText, 100),
        notes: cleanString(body.notes, 2000),
        dateStr: cleanString(body.dateStr, 80),
        dateISO: cleanString(body.dateISO, 40),
        garansiBulan: Math.max(0, Math.min(120, Math.trunc(Number(body.garansiBulan) || 0))),
        kerusakan: cleanString(body.kerusakan, 1000),
        updatedAt: new Date().toISOString()
      };
      await (await store()).setJSON(key, record);
      return json({ ok: true, record });
    }

    const match = path.match(/^\/api\/warranties\/([^/]+)$/);
    if (method === "GET" && match) {
      const key = recordKey(decodeURIComponent(match[1]));
      if (!key) return json({ error: "Nomor resi tidak valid." }, 400);
      const record = await (await store()).get(key, { type: "json" });
      if (!record) return json({ error: "Data garansi tidak ditemukan." }, 404);
      return json({ record: {
        invNo: record.invNo,
        name: record.name,
        device: record.device,
        subtotal: record.subtotal,
        dateISO: record.dateISO,
        garansiBulan: record.garansiBulan
      } });
    }

    return json({ error: "Endpoint tidak ditemukan." }, 404);
  } catch (error) {
    console.error("PoizyStore API error:", error);
    return json({ error: error.message || "Terjadi kesalahan server." }, 500);
  }
};

export const config = { path: "/api/*" };
