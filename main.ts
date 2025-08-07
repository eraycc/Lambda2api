// main.ts - Deno Deploy Lambda.chat proxy for OpenAI-compatible endpoints

// ============ Config ============
const BASE_URL = "https://lambda.chat";
const CONVERSATION_URL = `${BASE_URL}/conversation`;
const DEFAULT_MODEL = "deepseek-r1";

const CANONICAL_MODELS = Array.from(
  new Set([
    "deepseek-llama3.3-70b",
    "deepseek-r1",
    "deepseek-r1-0528",
    "apriel-5b-instruct",
    "hermes-3-llama-3.1-405b-fp8",
    "hermes3-405b-fp8-128k",
    "llama3.1-nemotron-70b-instruct",
    "lfm-40b",
    "llama3.3-70b-instruct-fp8",
    "qwen25-coder-32b-instruct",
    "deepseek-v3-0324",
    "llama-4-maverick-17b-128e-instruct-fp8",
    "llama-4-scout-17b-16e-instruct",
    "qwen3-32b-fp8",
  ]),
);

const MODEL_ALIASES: Record<string, string | string[]> = {
  "hermes-3": "hermes3-405b-fp8-128k",
  "hermes-3-405b": ["hermes3-405b-fp8-128k", "hermes-3-llama-3.1-405b-fp8"],
  "nemotron-70b": "llama3.1-nemotron-70b-instruct",
  "llama-3.3-70b": "llama3.3-70b-instruct-fp8",
  "qwen-2.5-coder-32b": "qwen25-coder-32b-instruct",
  "llama-4-maverick": "llama-4-maverick-17b-128e-instruct-fp8",
  "llama-4-scout": "llama-4-scout-17b-16e-instruct",
  "qwen-3-32b": "qwen3-32b-fp8",
};

// ============ Utilities ============
function jsonResponse(obj: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

function errorResponse(message: string, type = "invalid_request_error", status = 400) {
  return jsonResponse({ error: { message, type } }, status);
}

function toEpochSec(d = Date.now()) {
  return Math.floor(d / 1000);
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function resolveModel(userModel?: string): { userModel: string; internalModel: string } {
  const requested = userModel || DEFAULT_MODEL;

  if (CANONICAL_MODELS.includes(requested)) {
    return { userModel: requested, internalModel: requested };
  }
  const alias = MODEL_ALIASES[requested];
  if (alias) {
    if (Array.isArray(alias)) {
      const selected = randomChoice(alias);
      return { userModel: requested, internalModel: selected };
    }
    return { userModel: requested, internalModel: alias };
  }
  throw new Error(`Model '${requested}' not found`);
}

type CookieJar = Map<string, string>;

function cookieJarToHeader(jar: CookieJar): string {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function baseHeaders(jar: CookieJar): HeadersInit {
  const h: HeadersInit = {
    "Origin": BASE_URL,
    "Referer": BASE_URL,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  };
  if (jar.size > 0) {
    h["Cookie"] = cookieJarToHeader(jar);
  }
  return h;
}

function getLastUserContent(messages: Array<{ role: string; content: unknown }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") {
      const c = m.content as unknown;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        // 如果是 array-of-content-parts，拼接为字符串
        return (c as Array<any>).map((p) => (typeof p?.text === "string" ? p.text : p?.content || "")).join("");
      }
      // 兜底
      try {
        return JSON.stringify(c);
      } catch {
        return String(c ?? "");
      }
    }
  }
  return "";
}

// 提取文本中的第一个 UUID（兜底）
function extractFirstUUID(text: string): string | null {
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

// 解析 SvelteKit __data.json 风格文本，寻找 system 消息的 id
function findMessageIdFromDataText(text: string): string | null {
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const data = JSON.parse(s);
      if (data?.type === "data" && Array.isArray(data.nodes)) {
        for (const node of data.nodes) {
          if (node?.type === "data" && Array.isArray(node.data)) {
            for (const item of node.data) {
              if (item && typeof item === "object" && item.id && item.from === "system") {
                return item.id as string;
              }
            }
          }
        }
      }
    } catch {
      // 忽略当前行
    }
  }
  // 兜底：从整体文本里找任意 UUID
  return extractFirstUUID(text);
}

// 从 buffer 中提取连续的 JSON 对象（支持跨 chunk 拼接）
function extractJsonObjects(buffer: string): { objects: any[]; rest: string } {
  const objects: any[] = [];
  let depth = 0;
  let inStr = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];

    if (inStr) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    } else {
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && start !== -1) {
          const jsonStr = buffer.slice(start, i + 1);
          try {
            objects.push(JSON.parse(jsonStr));
          } catch {
            // 丢弃解析失败的对象
          }
          start = -1;
        }
      }
    }
  }

  const rest = depth > 0 && start !== -1 ? buffer.slice(start) : "";
  return { objects, rest };
}

// ============ Lambda.chat client core ============
async function* lambdaChatStream({
  internalModel,
  userMessage,
}: {
  internalModel: string;
  userMessage: string;
}): AsyncGenerator<string, void, unknown> {
  // 简单 CookieJar，只保留 hf-chat
  const jar: CookieJar = new Map([["hf-chat", crypto.randomUUID()]]);

  // 1) 创建会话
  const createResp = await fetch(CONVERSATION_URL, {
    method: "POST",
    headers: {
      ...baseHeaders(jar),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: internalModel }),
  });
  if (!createResp.ok) {
    throw new Error(`LambdaChat: failed to create conversation (${createResp.status})`);
  }
  const createJson = await createResp.json();
  const conversationId = createJson?.conversationId;
  if (!conversationId) throw new Error("LambdaChat: no conversationId");

  // 2) 拉取会话数据，解析 message_id
  const dataResp = await fetch(
    `${CONVERSATION_URL}/${conversationId}/__data.json?x-sveltekit-invalidated=11`,
    { headers: baseHeaders(jar) },
  );
  if (!dataResp.ok) throw new Error(`LambdaChat: fetch __data.json failed (${dataResp.status})`);
  const dataText = await dataResp.text();
  const messageId = findMessageIdFromDataText(dataText);
  if (!messageId) throw new Error("LambdaChat: cannot find message id");

  // 3) 发送用户消息（multipart/form-data，字段名 data，application/json）
  const payload = {
    inputs: userMessage,
    id: messageId,
    is_retry: false,
    is_continue: false,
    web_search: false,
    tools: [] as unknown[],
  };
  const fd = new FormData();
  fd.append("data", new Blob([JSON.stringify(payload)], { type: "application/json" }));

  const sendResp = await fetch(`${CONVERSATION_URL}/${conversationId}`, {
    method: "POST",
    headers: baseHeaders(jar),
    body: fd,
  });
  if (!sendResp.ok) {
    const t = await sendResp.text().catch(() => "");
    throw new Error(`LambdaChat: send message failed (${sendResp.status}): ${t}`);
  }
  if (!sendResp.body) throw new Error("LambdaChat: empty response body");

  const reader = sendResp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 从 buffer 中提取完整 JSON 对象
      const { objects, rest } = extractJsonObjects(buffer);
      buffer = rest;

      for (const obj of objects) {
        if (!obj || typeof obj !== "object") continue;

        const t = obj.type;
        if (t === "stream" && typeof obj.token === "string") {
          const token = obj.token.replace(/\u0000/g, "");
          if (token) yield token;
        } else if (t === "finalAnswer") {
          // 结束
          return;
        } else if (t === "status" && obj.status === "keepAlive") {
          // 心跳，忽略
          continue;
        }
        // 其他类型: title/reasoning 等，OpenAI ChatCompletions 不用直接透出
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

// ============ OpenAI-compatible endpoints ============

// GET /v1/models
function handleModelsRequest(): Response {
  // 返回真实模型 + 别名（便于客户端在 /v1/models 里看到可用别名）
  const allModelIds = Array.from(
    new Set<string>([...CANONICAL_MODELS, ...Object.keys(MODEL_ALIASES)]),
  );

  const now = toEpochSec();
  const data = allModelIds.map((id) => ({
    id,
    object: "model",
    created: now,
    owned_by: "lambda.chat",
  }));

  return jsonResponse({ object: "list", data });
}

// POST /v1/chat/completions
async function handleChatCompletions(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse("Method not allowed", "invalid_request_error", 405);
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON body");
  }

  const messages = body?.messages ?? [];
  const stream: boolean = Boolean(body?.stream);
  const requestedModel: string | undefined = body?.model;

  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse("Messages must be a non-empty array");
  }

  let modelResolved: { userModel: string; internalModel: string };
  try {
    modelResolved = resolveModel(requestedModel);
  } catch (e: any) {
    return errorResponse(String(e?.message ?? "Model not found"));
  }

  const userText = getLastUserContent(messages);
  if (!userText) {
    return errorResponse("No user message found in 'messages'");
  }

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = toEpochSec();

  if (stream) {
    // SSE 流式返回
    const upstream = lambdaChatStream({
      internalModel: modelResolved.internalModel,
      userMessage: userText,
    });

    const readable = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();

        // 先发一个带 role 的空 delta（更贴近 OpenAI 的流式格式）
        const roleChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model: modelResolved.userModel,
          choices: [
            {
              index: 0,
              delta: { role: "assistant" },
              finish_reason: null,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));

        try {
          for await (const token of upstream) {
            const data = {
              id,
              object: "chat.completion.chunk",
              created,
              model: modelResolved.userModel,
              choices: [
                {
                  index: 0,
                  delta: { content: token },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          }

          // 结束块
          const doneData = {
            id,
            object: "chat.completion.chunk",
            created,
            model: modelResolved.userModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneData)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Transfer-Encoding": "chunked",
      },
    });
  } else {
    // 非流式：合并文本
    let fullText = "";
    try {
      for await (
        const token of lambdaChatStream({
          internalModel: modelResolved.internalModel,
          userMessage: userText,
        })
      ) {
        fullText += token;
      }
    } catch (e) {
      console.error("Non-stream upstream error:", e);
      return errorResponse("Upstream error", "server_error", 502);
    }

    const resp = {
      id,
      object: "chat.completion",
      created,
      model: modelResolved.userModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: fullText,
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    return jsonResponse(resp, 200);
  }
}

// ============ Router / CORS ============
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    let resp: Response;

    if (url.pathname === "/v1/models" && request.method === "GET") {
      resp = handleModelsRequest();
    } else if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      resp = await handleChatCompletions(request);
    } else if (url.pathname === "/" && request.method === "GET") {
      resp = jsonResponse({
        status: "ok",
        message: "Lambda.chat OpenAI-compatible proxy is running",
        endpoints: ["/v1/models", "/v1/chat/completions"],
      });
    } else {
      resp = errorResponse(`Path ${url.pathname} not found`, "invalid_request_error", 404);
    }

    // 加上 CORS 头
    const h = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) h.set(k, v);
    return new Response(resp.body, { status: resp.status, headers: h });
  } catch (e) {
    console.error("Handler error:", e);
    return jsonResponse({ error: { message: "Internal server error", type: "server_error" } }, 500, CORS_HEADERS);
  }
}

console.log("Server starting...");
Deno.serve(handler);
