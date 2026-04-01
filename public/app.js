/* ============================================================
   GPT Chatbot - Main Application Logic (Server Mode)
   ============================================================
   ลอจิกหลักของแอปพลิเคชันแชทบอท AI
   เชื่อมต่อผ่าน Backend Server Proxy เพื่อความปลอดภัย
   ไม่มี API Key ในฝั่ง client
   ============================================================ */

// --- ค่าคงที่สำหรับการตั้งค่า (Configuration Constants) ---
const API_ENDPOINT = "/api/chat"; // เรียก API ผ่าน server proxy
const SITE_TITLE = "GPT Chatbot";
const LOCAL_STORAGE_KEY = "gpt_chatbot_conversations";
const MAX_TEXTAREA_HEIGHT = 200;

// --- อ้างอิง DOM Elements ---
const dom_elements = {
    sidebar: document.getElementById("sidebar"),
    btn_toggle_sidebar: document.getElementById("btn-toggle-sidebar"),
    btn_new_chat: document.getElementById("btn-new-chat"),
    btn_clear_all: document.getElementById("btn-clear-all"),
    conversation_list: document.getElementById("conversation-list"),
    chat_area: document.getElementById("chat-area"),
    welcome_screen: document.getElementById("welcome-screen"),
    messages_container: document.getElementById("messages-container"),
    message_input: document.getElementById("message-input"),
    btn_send: document.getElementById("btn-send"),
    btn_stop: document.getElementById("btn-stop"),
};

// --- State Management (จัดการสถานะแอป) ---
let app_state = {
    conversations: [],            // รายการบทสนทนาทั้งหมด
    active_conversation_id: null, // ID บทสนทนาที่กำลังใช้งาน
    is_streaming: false,          // สถานะกำลัง streaming อยู่หรือไม่
    abort_controller: null,       // ตัวควบคุมการยกเลิก fetch request
};

// ============================================================
// Utility Functions (ฟังก์ชันเครื่องมือ)
// ============================================================

/**
 * สร้าง UUID v4 สำหรับระบุ ID ที่ไม่ซ้ำกัน
 * @returns {string} UUID ที่สร้างขึ้น
 */
function GenerateUuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (char) {
        const random_val = (Math.random() * 16) | 0;
        const result_val = char === "x" ? random_val : (random_val & 0x3) | 0x8;
        return result_val.toString(16);
    });
}

/**
 * แปลง Markdown พื้นฐานเป็น HTML สำหรับแสดงผลข้อความ
 * @param {string} text - ข้อความ Markdown
 * @returns {string} ข้อความ HTML
 */
function ParseMarkdownToHtml(text) {
    if (!text) return "";

    let html = text;

    // ป้องกัน XSS โดย escape HTML entities ก่อน
    html = html.replace(/&/g, "&amp;")
               .replace(/</g, "&lt;")
               .replace(/>/g, "&gt;");

    // จัดการ code blocks พร้อมภาษา (```language ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_match, language, code) {
        const lang_label = language || "code";
        return `<div class="code-block-wrapper">
            <div class="code-header">
                <span>${lang_label}</span>
                <button class="btn-copy-code" onclick="HandleCopyCode(this)">คัดลอก</button>
            </div>
            <pre><code>${code.trim()}</code></pre>
        </div>`;
    });

    // จัดการ inline code (`...`)
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // จัดการ headings (### ... )
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

    // จัดการ bold (**...**) และ italic (*...*)
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // จัดการ blockquote (> ...)
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");

    // จัดการ horizontal rule (---)
    html = html.replace(/^---$/gm, "<hr>");

    // จัดการ unordered lists (- ...) - แปลงเป็น <ul><li>
    html = html.replace(/^(\s*)[-*] (.+)$/gm, "$1<li>$2</li>");
    html = html.replace(/((?:<li>.*<\/li>\s*)+)/g, "<ul>$1</ul>");

    // จัดการ ordered lists (1. ...) - แปลงเป็น <ol><li>
    html = html.replace(/^(\s*)\d+\. (.+)$/gm, "$1<li>$2</li>");

    // จัดการ links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // แปลงบรรทัดว่างเป็น paragraph breaks
    html = html.replace(/\n\n/g, "</p><p>");
    html = html.replace(/\n/g, "<br>");

    // ครอบด้วย <p> tags
    if (!html.startsWith("<h") && !html.startsWith("<div") && !html.startsWith("<ul") && !html.startsWith("<ol")) {
        html = "<p>" + html + "</p>";
    }

    return html;
}

/**
 * สร้างชื่อบทสนทนาจากข้อความแรก (ตัดให้สั้น)
 * @param {string} text - ข้อความต้นฉบับ
 * @returns {string} ชื่อที่ตัดแล้ว
 */
function GenerateConversationTitle(text) {
    const MAX_TITLE_LENGTH = 30;
    const trimmed_text = text.trim();
    if (trimmed_text.length <= MAX_TITLE_LENGTH) return trimmed_text;
    return trimmed_text.substring(0, MAX_TITLE_LENGTH) + "...";
}

// ============================================================
// Local Storage (จัดเก็บข้อมูลในเบราว์เซอร์)
// ============================================================

/**
 * บันทึกข้อมูลบทสนทนาทั้งหมดลง localStorage
 */
function SaveConversationsToStorage() {
    try {
        const data_to_save = JSON.stringify(app_state.conversations);
        localStorage.setItem(LOCAL_STORAGE_KEY, data_to_save);
    } catch (error) {
        console.error("ไม่สามารถบันทึกข้อมูลลง localStorage:", error);
    }
}

/**
 * โหลดข้อมูลบทสนทนาจาก localStorage
 */
function LoadConversationsFromStorage() {
    try {
        const stored_data = localStorage.getItem(LOCAL_STORAGE_KEY);
        if (stored_data) {
            app_state.conversations = JSON.parse(stored_data);
        }
    } catch (error) {
        console.error("ไม่สามารถโหลดข้อมูลจาก localStorage:", error);
        app_state.conversations = [];
    }
}

// ============================================================
// Conversation Management (จัดการบทสนทนา)
// ============================================================

/**
 * สร้างบทสนทนาใหม่
 * @returns {object} ออบเจกต์บทสนทนาที่สร้างขึ้น
 */
function CreateNewConversation() {
    const new_conversation = {
        id: GenerateUuid(),
        title: "แชทใหม่",
        messages: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    };
    app_state.conversations.unshift(new_conversation);
    app_state.active_conversation_id = new_conversation.id;
    SaveConversationsToStorage();
    RenderConversationList();
    RenderMessages();
    ShowWelcomeScreen();
    return new_conversation;
}

/**
 * ค้นหาบทสนทนาจาก ID
 * @param {string} conversation_id - ID ของบทสนทนา
 * @returns {object|undefined} ออบเจกต์บทสนทนา
 */
function FindConversationById(conversation_id) {
    return app_state.conversations.find(
        (conv) => conv.id === conversation_id
    );
}

/**
 * ดึงบทสนทนาที่กำลังใช้งานอยู่
 * @returns {object|undefined} ออบเจกต์บทสนทนาปัจจุบัน
 */
function GetActiveConversation() {
    if (!app_state.active_conversation_id) return undefined;
    return FindConversationById(app_state.active_conversation_id);
}

/**
 * เปลี่ยนไปยังบทสนทนาที่ระบุ
 * @param {string} conversation_id - ID ของบทสนทนาเป้าหมาย
 */
function SwitchToConversation(conversation_id) {
    app_state.active_conversation_id = conversation_id;
    RenderConversationList();
    RenderMessages();

    const active_conv = GetActiveConversation();
    if (active_conv && active_conv.messages.length > 0) {
        HideWelcomeScreen();
    } else {
        ShowWelcomeScreen();
    }

    // ปิด sidebar บนมือถือ
    if (window.innerWidth <= 768) {
        ToggleSidebar(false);
    }
}

/**
 * ลบบทสนทนาที่ระบุ
 * @param {string} conversation_id - ID ของบทสนทนาที่จะลบ
 */
function DeleteConversation(conversation_id) {
    app_state.conversations = app_state.conversations.filter(
        (conv) => conv.id !== conversation_id
    );

    // ถ้าลบบทสนทนาที่กำลังใช้งาน ให้สลับไปบทสนทนาอื่น
    if (app_state.active_conversation_id === conversation_id) {
        if (app_state.conversations.length > 0) {
            SwitchToConversation(app_state.conversations[0].id);
        } else {
            app_state.active_conversation_id = null;
            RenderMessages();
            ShowWelcomeScreen();
        }
    }

    SaveConversationsToStorage();
    RenderConversationList();
}

/**
 * ลบบทสนทนาทั้งหมด
 */
function ClearAllConversations() {
    if (!confirm("คุณต้องการลบบทสนทนาทั้งหมดหรือไม่?")) return;

    app_state.conversations = [];
    app_state.active_conversation_id = null;
    SaveConversationsToStorage();
    RenderConversationList();
    RenderMessages();
    ShowWelcomeScreen();
}

// ============================================================
// UI Rendering (การแสดงผล UI)
// ============================================================

/**
 * แสดงหน้าจอต้อนรับ
 */
function ShowWelcomeScreen() {
    dom_elements.welcome_screen.classList.remove("hidden");
    dom_elements.messages_container.innerHTML = "";
}

/**
 * ซ่อนหน้าจอต้อนรับ
 */
function HideWelcomeScreen() {
    dom_elements.welcome_screen.classList.add("hidden");
}

/**
 * เปิด/ปิด Sidebar
 * @param {boolean} [should_show] - กำหนดค่าการแสดงผล (ถ้าไม่ระบุจะสลับ)
 */
function ToggleSidebar(should_show) {
    const sidebar = dom_elements.sidebar;
    let overlay = document.querySelector(".sidebar-overlay");

    if (typeof should_show === "boolean") {
        sidebar.classList.toggle("collapsed", !should_show);
    } else {
        sidebar.classList.toggle("collapsed");
    }

    // จัดการ overlay สำหรับหน้าจอมือถือ
    const is_visible = !sidebar.classList.contains("collapsed");
    if (window.innerWidth <= 768) {
        if (is_visible) {
            if (!overlay) {
                overlay = document.createElement("div");
                overlay.className = "sidebar-overlay active";
                overlay.addEventListener("click", () => ToggleSidebar(false));
                document.body.appendChild(overlay);
            } else {
                overlay.classList.add("active");
            }
        } else if (overlay) {
            overlay.classList.remove("active");
        }
    }
}

/**
 * แสดงรายการบทสนทนาใน Sidebar
 */
function RenderConversationList() {
    const list_container = dom_elements.conversation_list;
    list_container.innerHTML = "";

    if (app_state.conversations.length === 0) {
        list_container.innerHTML = `
            <p style="padding: 1rem; color: var(--color-text-tertiary); font-size: var(--font-size-xs); text-align: center;">
                ยังไม่มีบทสนทนา
            </p>`;
        return;
    }

    app_state.conversations.forEach((conv) => {
        const is_active = conv.id === app_state.active_conversation_id;
        const item_element = document.createElement("div");
        item_element.className = `conversation-item ${is_active ? "active" : ""}`;
        item_element.innerHTML = `
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="conv-title">${EscapeHtml(conv.title)}</span>
            <button class="btn-delete-conv" aria-label="ลบบทสนทนา" data-conv-id="${conv.id}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
            </button>`;

        // คลิกเพื่อเปลี่ยนบทสนทนา
        item_element.addEventListener("click", (event) => {
            if (event.target.closest(".btn-delete-conv")) return;
            SwitchToConversation(conv.id);
        });

        // คลิกปุ่มลบ
        const delete_btn = item_element.querySelector(".btn-delete-conv");
        delete_btn.addEventListener("click", (event) => {
            event.stopPropagation();
            DeleteConversation(conv.id);
        });

        list_container.appendChild(item_element);
    });
}

/**
 * Escape HTML entities เพื่อป้องกัน XSS
 * @param {string} text - ข้อความต้นฉบับ
 * @returns {string} ข้อความที่ escape แล้ว
 */
function EscapeHtml(text) {
    const div_element = document.createElement("div");
    div_element.textContent = text;
    return div_element.innerHTML;
}

/**
 * แสดงข้อความทั้งหมดในบทสนทนาปัจจุบัน
 */
function RenderMessages() {
    const container = dom_elements.messages_container;
    container.innerHTML = "";

    const active_conv = GetActiveConversation();
    if (!active_conv || active_conv.messages.length === 0) return;

    active_conv.messages.forEach((msg) => {
        const message_element = CreateMessageElement(msg.role, msg.content);
        container.appendChild(message_element);
    });

    ScrollToBottom();
}

/**
 * สร้าง DOM element สำหรับข้อความ
 * @param {string} role - บทบาท ('user' หรือ 'assistant')
 * @param {string} content - เนื้อหาข้อความ
 * @returns {HTMLElement} DOM element ของข้อความ
 */
function CreateMessageElement(role, content) {
    const message_div = document.createElement("div");
    message_div.className = `message ${role}`;

    const avatar_label = role === "user" ? "คุณ" : "AI";
    const role_label = role === "user" ? "คุณ" : "GPT Chatbot";

    // แปลง Markdown เป็น HTML สำหรับข้อความ AI
    const rendered_content = role === "assistant"
        ? ParseMarkdownToHtml(content)
        : `<p>${EscapeHtml(content)}</p>`;

    message_div.innerHTML = `
        <div class="message-avatar">${avatar_label}</div>
        <div class="message-content">
            <div class="message-role">${role_label}</div>
            <div class="message-text">${rendered_content}</div>
        </div>`;

    return message_div;
}

/**
 * สร้าง element แสดงสถานะกำลังพิมพ์ (Typing Indicator) + AI streaming
 * @returns {HTMLElement} DOM element
 */
function CreateTypingIndicatorElement() {
    const message_div = document.createElement("div");
    message_div.className = "message assistant";
    message_div.id = "typing-indicator";

    message_div.innerHTML = `
        <div class="message-avatar">AI</div>
        <div class="message-content">
            <div class="message-role">GPT Chatbot</div>
            <div class="message-text">
                <div class="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                </div>
            </div>
        </div>`;

    return message_div;
}

/**
 * เลื่อนหน้าจอไปด้านล่างสุด
 */
function ScrollToBottom() {
    const chat_area = dom_elements.chat_area;
    requestAnimationFrame(() => {
        chat_area.scrollTop = chat_area.scrollHeight;
    });
}

// ============================================================
// API Communication (การสื่อสารกับ Server API)
// ============================================================

/**
 * ส่งข้อความไปยัง Backend Server (Proxy) แบบ Streaming
 * API Key ถูกเก็บไว้ที่ฝั่ง server เพื่อความปลอดภัย
 * @param {Array} messages - อาร์เรย์ข้อความสำหรับส่งไป API
 */
async function SendMessageToApiAsync(messages) {
    // สร้าง AbortController สำหรับยกเลิก request
    app_state.abort_controller = new AbortController();
    app_state.is_streaming = true;
    UpdateSendButtonState();

    // แสดง Typing Indicator
    const typing_element = CreateTypingIndicatorElement();
    dom_elements.messages_container.appendChild(typing_element);
    ScrollToBottom();

    let full_response = "";

    try {
        // ส่ง request ไปยัง Backend Server (ไม่ต้องส่ง API Key จาก client)
        const response = await fetch(API_ENDPOINT, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                messages: messages,
            }),
            signal: app_state.abort_controller.signal,
        });

        // ตรวจสอบสถานะ response
        if (!response.ok) {
            const error_data = await response.json().catch(() => ({}));
            const error_message = error_data?.error?.message || `HTTP Error: ${response.status}`;
            throw new Error(error_message);
        }

        // อ่านข้อมูล streaming ทีละ chunk
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // เอา typing indicator ออก แล้วเริ่มแสดงเนื้อหา
        const text_container = typing_element.querySelector(".message-text");
        text_container.innerHTML = '<span class="streaming-cursor"></span>';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // ถอดรหัส chunk ที่ได้รับ
            buffer += decoder.decode(value, { stream: true });

            // แยก SSE events ออกจาก buffer
            const lines = buffer.split("\n");
            buffer = lines.pop() || ""; // เก็บบรรทัดที่ยังไม่สมบูรณ์

            for (const line of lines) {
                const trimmed_line = line.trim();
                if (!trimmed_line || !trimmed_line.startsWith("data: ")) continue;

                const data_str = trimmed_line.slice(6);
                if (data_str === "[DONE]") continue;

                try {
                    const parsed_data = JSON.parse(data_str);

                    // ตรวจสอบ error จาก server
                    if (parsed_data?.error) {
                        throw new Error(parsed_data.error);
                    }

                    const delta_content = parsed_data?.choices?.[0]?.delta?.content;
                    if (delta_content) {
                        full_response += delta_content;
                        // อัปเดต UI ด้วยเนื้อหาใหม่
                        text_container.innerHTML =
                            ParseMarkdownToHtml(full_response) +
                            '<span class="streaming-cursor"></span>';
                        ScrollToBottom();
                    }
                } catch (parse_error) {
                    // ถ้าเป็น error ที่เรา throw เอง ให้ throw ต่อ
                    if (parse_error.message && !parse_error.message.includes("JSON")) {
                        throw parse_error;
                    }
                    // ข้ามข้อมูลที่ parse ไม่ได้
                }
            }
        }

        // เสร็จสิ้นแล้ว ลบ cursor ออก
        text_container.innerHTML = ParseMarkdownToHtml(full_response);

    } catch (error) {
        // ลบ typing indicator
        const existing_indicator = document.getElementById("typing-indicator");
        if (existing_indicator) existing_indicator.remove();

        // จัดการกรณียกเลิก (Abort)
        if (error.name === "AbortError") {
            if (full_response) {
                // ถ้ามีเนื้อหาแล้ว ให้เก็บไว้
                const partial_element = CreateMessageElement("assistant", full_response);
                dom_elements.messages_container.appendChild(partial_element);
            }
        } else {
            // แสดงข้อผิดพลาด
            const error_element = document.createElement("div");
            error_element.className = "message assistant";
            error_element.innerHTML = `
                <div class="message-avatar">AI</div>
                <div class="message-content">
                    <div class="message-role">GPT Chatbot</div>
                    <div class="message-text">
                        <div class="error-message">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <line x1="15" y1="9" x2="9" y2="15"></line>
                                <line x1="9" y1="9" x2="15" y2="15"></line>
                            </svg>
                            <span>เกิดข้อผิดพลาด: ${EscapeHtml(error.message)}</span>
                        </div>
                    </div>
                </div>`;
            dom_elements.messages_container.appendChild(error_element);
        }
        ScrollToBottom();
    } finally {
        app_state.is_streaming = false;
        app_state.abort_controller = null;
        UpdateSendButtonState();
    }

    return full_response;
}

// ============================================================
// Message Handling (จัดการการส่งข้อความ)
// ============================================================

/**
 * จัดการเมื่อผู้ใช้ส่งข้อความ
 */
async function HandleSendMessage() {
    const input_element = dom_elements.message_input;
    const user_text = input_element.value.trim();

    // ตรวจสอบว่ามีข้อความและไม่ได้กำลัง streaming
    if (!user_text || app_state.is_streaming) return;

    // สร้างบทสนทนาใหม่ถ้ายังไม่มี
    if (!app_state.active_conversation_id) {
        CreateNewConversation();
    }

    const active_conv = GetActiveConversation();
    if (!active_conv) return;

    // ซ่อนหน้าจอต้อนรับ
    HideWelcomeScreen();

    // เพิ่มข้อความผู้ใช้ลงในบทสนทนา
    active_conv.messages.push({
        role: "user",
        content: user_text,
    });

    // อัปเดตชื่อบทสนทนาจากข้อความแรก
    if (active_conv.messages.length === 1) {
        active_conv.title = GenerateConversationTitle(user_text);
        RenderConversationList();
    }

    // แสดงข้อความผู้ใช้บน UI
    const user_message_element = CreateMessageElement("user", user_text);
    dom_elements.messages_container.appendChild(user_message_element);
    ScrollToBottom();

    // เคลียร์ช่องพิมพ์
    input_element.value = "";
    AutoResizeTextarea();
    UpdateSendButtonState();

    // เตรียมข้อความสำหรับส่งไป API (ส่งเฉพาะ role และ content)
    const api_messages = active_conv.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
    }));

    // ส่งข้อความไป Server API และรับคำตอบ
    const ai_response = await SendMessageToApiAsync(api_messages);

    // บันทึกคำตอบ AI ลงในบทสนทนา (ถ้ามี)
    if (ai_response) {
        active_conv.messages.push({
            role: "assistant",
            content: ai_response,
        });
        active_conv.updated_at = new Date().toISOString();
        SaveConversationsToStorage();
    }
}

/**
 * หยุดการ streaming ที่กำลังดำเนินอยู่
 */
function HandleStopStreaming() {
    if (app_state.abort_controller) {
        app_state.abort_controller.abort();
    }
}

/**
 * จัดการเมื่อคลิกปุ่มคัดลอกโค้ด
 * @param {HTMLButtonElement} button_element - ปุ่มที่ถูกคลิก
 */
function HandleCopyCode(button_element) {
    const code_wrapper = button_element.closest(".code-block-wrapper");
    const code_element = code_wrapper?.querySelector("code");
    if (!code_element) return;

    const code_text = code_element.textContent;
    navigator.clipboard.writeText(code_text).then(() => {
        const original_text = button_element.textContent;
        button_element.textContent = "คัดลอกแล้ว ✓";
        setTimeout(() => {
            button_element.textContent = original_text;
        }, 2000);
    }).catch((error) => {
        console.error("ไม่สามารถคัดลอก:", error);
    });
}

// ============================================================
// Input Handling (จัดการ Input)
// ============================================================

/**
 * ปรับขนาด Textarea อัตโนมัติตามเนื้อหา
 */
function AutoResizeTextarea() {
    const textarea = dom_elements.message_input;
    textarea.style.height = "auto";
    const new_height = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = new_height + "px";
}

/**
 * อัปเดตสถานะปุ่มส่ง/หยุด
 */
function UpdateSendButtonState() {
    const has_text = dom_elements.message_input.value.trim().length > 0;
    const is_streaming = app_state.is_streaming;

    dom_elements.btn_send.disabled = !has_text || is_streaming;

    // สลับแสดงปุ่มส่ง/หยุด
    if (is_streaming) {
        dom_elements.btn_send.classList.add("hidden");
        dom_elements.btn_stop.classList.remove("hidden");
    } else {
        dom_elements.btn_send.classList.remove("hidden");
        dom_elements.btn_stop.classList.add("hidden");
    }
}

// ============================================================
// Event Listeners (ตัวรับเหตุการณ์)
// ============================================================

/**
 * ผูก Event Listeners ทั้งหมด
 */
function InitializeEventListeners() {
    // ปุ่มส่งข้อความ
    dom_elements.btn_send.addEventListener("click", HandleSendMessage);

    // ปุ่มหยุด streaming
    dom_elements.btn_stop.addEventListener("click", HandleStopStreaming);

    // กล่องพิมพ์ข้อความ - Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่
    dom_elements.message_input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            HandleSendMessage();
        }
    });

    // ปรับขนาด Textarea อัตโนมัติ
    dom_elements.message_input.addEventListener("input", () => {
        AutoResizeTextarea();
        UpdateSendButtonState();
    });

    // ปุ่มเปิด/ปิด Sidebar
    dom_elements.btn_toggle_sidebar.addEventListener("click", () => {
        ToggleSidebar();
    });

    // ปุ่มสร้างแชทใหม่
    dom_elements.btn_new_chat.addEventListener("click", () => {
        // หยุด streaming ก่อนถ้ากำลังทำงาน
        if (app_state.is_streaming) {
            HandleStopStreaming();
        }
        CreateNewConversation();
        dom_elements.message_input.focus();

        // ปิด sidebar บนมือถือ
        if (window.innerWidth <= 768) {
            ToggleSidebar(false);
        }
    });

    // ปุ่มลบบทสนทนาทั้งหมด
    dom_elements.btn_clear_all.addEventListener("click", ClearAllConversations);

    // ปุ่มแนะนำ (Suggestion Cards) บนหน้าจอต้อนรับ
    document.querySelectorAll(".suggestion-card").forEach((card) => {
        card.addEventListener("click", () => {
            const prompt_text = card.getAttribute("data-prompt");
            if (prompt_text) {
                dom_elements.message_input.value = prompt_text;
                AutoResizeTextarea();
                UpdateSendButtonState();
                HandleSendMessage();
            }
        });
    });

    // Responsive: จัดการเมื่อเปลี่ยนขนาดหน้าจอ
    window.addEventListener("resize", () => {
        if (window.innerWidth > 768) {
            const overlay = document.querySelector(".sidebar-overlay");
            if (overlay) overlay.classList.remove("active");
        }
    });
}

// ============================================================
// Application Initialization (เริ่มต้นแอปพลิเคชัน)
// ============================================================

/**
 * เริ่มต้นแอปพลิเคชัน
 */
function InitializeApp() {
    // โหลดข้อมูลบทสนทนาจาก localStorage
    LoadConversationsFromStorage();

    // แสดงรายการบทสนทนา
    RenderConversationList();

    // ถ้ามีบทสนทนาล่าสุด ให้แสดงขึ้นมา
    if (app_state.conversations.length > 0) {
        SwitchToConversation(app_state.conversations[0].id);
    } else {
        ShowWelcomeScreen();
    }

    // ผูก Event Listeners ทั้งหมด
    InitializeEventListeners();

    // โฟกัสที่ช่องพิมพ์ข้อความ
    dom_elements.message_input.focus();
}

// เริ่มต้นแอปเมื่อ DOM โหลดเสร็จ
document.addEventListener("DOMContentLoaded", InitializeApp);
