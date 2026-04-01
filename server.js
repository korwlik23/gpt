/* ============================================================
   GPT Chatbot - Express Server (Backend Proxy)
   ============================================================
   เซิร์ฟเวอร์ Express ที่ทำหน้าที่เป็นตัวกลาง (Proxy)
   ระหว่าง Frontend กับ OpenRouter API
   เก็บ API Key ไว้ที่ฝั่ง server เพื่อความปลอดภัย
   ============================================================ */

const express = require("express");
const path = require("path");

// --- ค่าคงที่สำหรับการตั้งค่า (Configuration Constants) ---
const PORT = process.env.PORT || 3000;
const API_BASE_URL = "https://openrouter.ai/api/v1";
const API_KEY = process.env.OPENROUTER_API_KEY || "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";
const MODEL_NAME = "openai/gpt-5.2";
const SITE_TITLE = "GPT Chatbot";

// --- สร้าง Express Application ---
const app = express();

// --- Middleware ---
// แปลง JSON body จาก request
app.use(express.json({ limit: "10mb" }));

// ให้บริการไฟล์ static (HTML, CSS, JS) จากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, "public")));

// --- Rate Limiting แบบง่าย (ป้องกันการใช้งานเกินควร) ---
const rate_limit_map = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 นาที
const MAX_REQUESTS_PER_WINDOW = 20;      // สูงสุด 20 request ต่อนาที

/**
 * ตรวจสอบ Rate Limit ของ IP
 * @param {string} client_ip - IP address ของ client
 * @returns {boolean} true ถ้าเกิน limit
 */
function IsRateLimited(client_ip) {
    const current_time = Date.now();
    const client_data = rate_limit_map.get(client_ip);

    // ถ้าไม่มีข้อมูลก่อนหน้า ให้สร้างใหม่
    if (!client_data) {
        rate_limit_map.set(client_ip, {
            count: 1,
            window_start: current_time,
        });
        return false;
    }

    // ถ้าหมดช่วงเวลาแล้ว ให้รีเซ็ต
    if (current_time - client_data.window_start > RATE_LIMIT_WINDOW_MS) {
        rate_limit_map.set(client_ip, {
            count: 1,
            window_start: current_time,
        });
        return false;
    }

    // เพิ่มจำนวน request และตรวจสอบ
    client_data.count += 1;
    return client_data.count > MAX_REQUESTS_PER_WINDOW;
}

// ทำความสะอาด rate limit map ทุก 5 นาที เพื่อป้องกัน memory leak
setInterval(() => {
    const current_time = Date.now();
    for (const [ip, data] of rate_limit_map.entries()) {
        if (current_time - data.window_start > RATE_LIMIT_WINDOW_MS * 2) {
            rate_limit_map.delete(ip);
        }
    }
}, 5 * 60 * 1000);

// ============================================================
// API Endpoints
// ============================================================

/**
 * POST /api/chat
 * รับข้อความจาก client และส่งต่อไปยัง OpenRouter API
 * รองรับ Streaming (SSE) เพื่อส่งคำตอบกลับทีละ chunk
 */
app.post("/api/chat", async (req, res) => {
    try {
        // ตรวจสอบ Rate Limit
        const client_ip = req.ip || req.connection?.remoteAddress || "unknown";
        if (IsRateLimited(client_ip)) {
            return res.status(429).json({
                error: {
                    message: "คุณส่งข้อความเร็วเกินไป กรุณารอสักครู่แล้วลองใหม่",
                    code: "RATE_LIMIT_EXCEEDED",
                },
            });
        }

        // ตรวจสอบว่ามี messages ส่งมาหรือไม่
        const { messages } = req.body;
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                error: {
                    message: "กรุณาส่งข้อความอย่างน้อย 1 ข้อความ",
                    code: "INVALID_REQUEST",
                },
            });
        }

        // ตรวจสอบความถูกต้องของแต่ละข้อความ
        const is_valid = messages.every(
            (msg) =>
                msg &&
                typeof msg.role === "string" &&
                typeof msg.content === "string" &&
                ["user", "assistant", "system"].includes(msg.role)
        );

        if (!is_valid) {
            return res.status(400).json({
                error: {
                    message: "รูปแบบข้อความไม่ถูกต้อง",
                    code: "INVALID_MESSAGE_FORMAT",
                },
            });
        }

        // ป้องกันข้อความยาวเกินไป (จำกัด 50 ข้อความ)
        const MAX_MESSAGES = 50;
        const trimmed_messages = messages.slice(-MAX_MESSAGES);

        // ตั้งค่า headers สำหรับ SSE Streaming
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // ป้องกัน Nginx buffering

        // ส่ง request ไปยัง OpenRouter API
        const api_response = await fetch(`${API_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${API_KEY}`,
                "HTTP-Referer": SITE_TITLE,
                "X-OpenRouter-Title": SITE_TITLE,
            },
            body: JSON.stringify({
                model: MODEL_NAME,
                messages: trimmed_messages,
                max_tokens: 2048,  // จำกัดจำนวน tokens สูงสุดเพื่อควบคุมเครดิต
                stream: true,
            }),
        });

        // ตรวจสอบ response จาก API
        if (!api_response.ok) {
            const error_body = await api_response.text();
            let error_message = `OpenRouter API Error: ${api_response.status}`;

            try {
                const error_json = JSON.parse(error_body);
                error_message = error_json?.error?.message || error_message;
            } catch (_) {
                // ใช้ข้อความเริ่มต้นถ้า parse ไม่ได้
            }

            // ส่ง error กลับทาง SSE
            res.write(`data: ${JSON.stringify({ error: error_message })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
            return;
        }

        // อ่าน streaming response จาก OpenRouter แล้วส่งต่อให้ client
        const reader = api_response.body.getReader();
        const decoder = new TextDecoder();

        // จัดการเมื่อ client ตัดการเชื่อมต่อ
        let is_client_disconnected = false;
        req.on("close", () => {
            is_client_disconnected = true;
        });

        // อ่านและส่งต่อข้อมูลทีละ chunk
        while (true) {
            const { done, value } = await reader.read();
            if (done || is_client_disconnected) break;

            const chunk_text = decoder.decode(value, { stream: true });
            res.write(chunk_text);
        }

        // สิ้นสุดการ streaming
        res.end();

    } catch (error) {
        console.error("[Server Error] /api/chat:", error.message);

        // ถ้ายังไม่ได้ส่ง headers ให้ส่ง JSON error
        if (!res.headersSent) {
            return res.status(500).json({
                error: {
                    message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง",
                    code: "INTERNAL_SERVER_ERROR",
                },
            });
        }

        // ถ้าส่ง headers ไปแล้ว ให้ส่ง error ผ่าน SSE
        try {
            res.write(`data: ${JSON.stringify({ error: "เกิดข้อผิดพลาดระหว่างการประมวลผล" })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
        } catch (_) {
            // ไม่สามารถส่งข้อมูลเพิ่มได้
        }
    }
});

/**
 * GET /api/health
 * ตรวจสอบสถานะของ server
 */
app.get("/api/health", (_req, res) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        model: MODEL_NAME,
    });
});

/**
 * Fallback: ส่ง index.html สำหรับทุก route ที่ไม่ตรงกับ API
 * รองรับ SPA (Single Page Application) routing
 */
app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================================================
// เริ่มต้น Server
// ============================================================

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════╗
║           GPT Chatbot Server Started!              ║
╠════════════════════════════════════════════════════╣
║  URL:   http://localhost:${PORT}                     ║
║  Model: ${MODEL_NAME}                        ║
║  Status: ✅ Ready                                  ║
╚════════════════════════════════════════════════════╝
    `);
});
