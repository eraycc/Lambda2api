// lambdachat.ts - Lambda Chat edge proxy client for Deno Deploy

export type ChatMessage = { role: string; content: string };

const BASE_URL = "https://lambda.chat";
const CONVERSATION_URL = `${BASE_URL}/conversation`;

const AVAILABLE_MODELS = [
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
  "llama3.3-70b-instruct-fp8",
  "qwen3-32b-fp8",
] as const;

export const DEFAULT_MODEL = "deepseek-r1";

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

export function resolveModel(input?: string): string {
  const model = (input || DEFAULT_MODEL).trim();
  if (AVAILABLE_MODELS.includes(model as any)) return model;

  if (MODEL_ALIASES[model]) {
    const alias = MODEL_ALIASES[model];
    if (Array.isArray(alias)) {
      const pick = alias[Math.floor(Math.random() * alias.length)];
      return pick;
    }
    return alias;
  }

  // If input provided but not found, throw; otherwise return default
  if (input && input !== "") {
    throw new Error(`Model '${input}' not found`);
  }
  return DEFAULT_MODEL;
}

function buildCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function defaultHeaders(cookieJar: Record<string, string>): HeadersInit {
  return {
    "Origin": BASE_URL,
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": BASE_URL,
    "Pragma": "no-cache",
    "Cache-Control": "no-cache",
    "Cookie": buildCookieHeader(cookieJar),
  };
}

function extractLastUserMessage(messages: ChatMessage[]): string {
  const last = messages.filter((m) => m.role === "user").pop();
  return last?.content ?? "";
}

// Robust extraction of JSON objects from a stream buffer
function extractJsonObjects(buffer: string): { objects: string[]; rest: string } {
  const objects: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        objects.push(buffer.slice(start, i + 1));
        start = -1;
      }
    }
  }

  const rest = depth > 0 && start !== -1 ? buffer.slice(start) : "";
  const prefix = start > 0 ? buffer.slice(0, start) : "";
  // Drop any prefix before first '{' to avoid infinite growth
  return { objects, rest };
}

// Try to parse messageId from the SvelteKit __data.json response
function extractMessageIdFromDataPage(text: string): string | undefined {
  // First try line-by-line JSON parse
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    try {
      const parsed = JSON.parse(l);
      if (parsed?.type === "data" && Array.isArray(parsed.nodes)) {
        for (const node of parsed.nodes) {
          if (node?.type === "data" && Array.isArray(node.data)) {
            for (const item of node.data) {
              if (
                item &&
                typeof item === "object" &&
                "id" in item &&
                item.from === "system"
              ) {
                return item.id as string;
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Fallback: grep any UUID
  const uuidPattern =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = text.match(uuidPattern);
  if (match) return match[0];

  return undefined;
}

export class LambdaChat {
  private cookieJar: Record<string, string>;

  constructor() {
    this.cookieJar = {
      "hf-chat": crypto.randomUUID(),
    };
  }

  async createConversation(model: string): Promise<string> {
    const headers = {
      ...defaultHeaders(this.cookieJar),
      "Content-Type": "application/json",
    };
    const res = await fetch(CONVERSATION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Create conversation failed: ${res.status} ${t}`);
    }
    const json = await res.json();
    const id = json?.conversationId;
    if (!id) {
      throw new Error("conversationId not found");
    }
    return id;
  }

  async fetchMessageId(conversationId: string): Promise<string> {
    const headers = {
      ...defaultHeaders(this.cookieJar),
    };

    const url = `${CONVERSATION_URL}/${conversationId}/__data.json?x-sveltekit-invalidated=11`;
    const res = await fetch(url, { method: "GET", headers });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Fetch conversation data failed: ${res.status} ${t}`);
    }
    const text = await res.text();
    const messageId = extractMessageIdFromDataPage(text);
    if (!messageId) {
      throw new Error("Could not extract message id");
    }
    return messageId;
  }

  // Stream tokens from Lambda Chat; yields plain text tokens
  async *chatCompletion(params: {
    model: string;
    messages: ChatMessage[];
  }): AsyncGenerator<string, void, unknown> {
    const model = resolveModel(params.model);
    const userMessage = extractLastUserMessage(params.messages);

    if (!userMessage) {
      throw new Error("No user message provided");
    }

    // Step 1: create conversation
    const conversationId = await this.createConversation(model);

    // Step 2: fetch starting message id
    const messageId = await this.fetchMessageId(conversationId);

    // Step 3: send user message
    const payload = {
      inputs: userMessage,
      id: messageId,
      is_retry: false,
      is_continue: false,
      web_search: false,
      tools: [] as unknown[],
    };

    const form = new FormData();
    // Ensure the field has application/json content-type
    form.append("data", new Blob([JSON.stringify(payload)], { type: "application/json" }));

    const headers = {
      ...defaultHeaders(this.cookieJar),
      // Note: DO NOT set Content-Type manually; fetch will set multipart boundary for FormData
      "Accept": "*/*",
    };

    const res = await fetch(`${CONVERSATION_URL}/${conversationId}`, {
      method: "POST",
      headers,
      body: form,
    });

    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      throw new Error(`Chat request failed: ${res.status} ${t}`);
    }

    // Lambda Chat returns a chunked stream of JSON objects, not SSE.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Try robust JSON framing
      const { objects, rest } = extractJsonObjects(buffer);
      buffer = rest;

      for (const objStr of objects) {
        let data: any;
        try {
          data = JSON.parse(objStr);
        } catch {
          continue;
        }

        const type = data?.type;

        if (type === "stream" && typeof data.token === "string") {
          const token = data.token.replace(/\u0000/g, "");
          if (token) {
            yield token;
          }
        } else if (type === "title") {
          // optional: ignore or handle
          continue;
        } else if (type === "reasoning") {
          // reasoning stream/status can be ignored for OpenAI compatibility
          continue;
        } else if (type === "status" && data.status === "keepAlive") {
          // just ignore keepalive
          continue;
        } else if (type === "finalAnswer") {
          // stop signal
          return;
        }
      }
    }
  }
}
