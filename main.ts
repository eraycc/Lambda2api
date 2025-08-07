// main.ts - Deno Deploy entry for OpenAI-compatible proxy to Lambda Chat
import { LambdaChat, DEFAULT_MODEL, resolveModel } from "./lambdachat.ts";

type ChatMessage = { role: string; content: string; name?: string };

// Internal models (exposed by /v1/models)
const MODELS = [
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
];

const modelsMap: Record<string, any> = Object.fromEntries(
  MODELS.map((id) => [
    id,
    {
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "lambda.chat",
    },
  ]),
);

// CORS
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function okJSON(obj: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function errJSON(status: number, message: string, type = "invalid_request_error"): Response {
  return new Response(
    JSON.stringify({ error: { message, type } }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

function handleModelsRequest(): Response {
  return okJSON(
    {
      object: "list",
      data: Object.values(modelsMap),
    },
  );
}

async function handleChatRequest(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return errJSON(405, "Method not allowed");
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return errJSON(400, "Invalid JSON body");
  }

  const stream: boolean = !!body.stream;
  const modelInput: string | undefined = body.model;
  const messages: ChatMessage[] = Array.isArray(body.messages) ? body.messages : [];

  // Resolve model (allow alias; throw if invalid alias)
  let model: string;
  try {
    model = resolveModel(modelInput || DEFAULT_MODEL);
  } catch (e: any) {
    return errJSON(400, e?.message || "Invalid model");
  }

  // Validate messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return errJSON(400, "Messages must be a non-empty array");
  }

  // Start upstream streaming
  const client = new LambdaChat();
  const upstream = client.chatCompletion({ model, messages });

  if (stream) {
    // SSE
    const readable = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();

        // A helper to send one SSE data event
        const send = (payload: any) => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };

        try {
          for await (const chunk of upstream) {
            const data = {
              id: `chatcmpl-${crypto.randomUUID()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  delta: { content: chunk },
                  finish_reason: null,
                },
              ],
            };
            send(data);
          }

          // Final chunk with finish_reason=stop
          send({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          });

          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });

    const response = new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
    Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  } else {
    // Non-streaming: accumulate all tokens into one content
    let full = "";
    try {
      for await (const chunk of upstream) {
        full += chunk;
      }
    } catch (e: any) {
      return errJSON(502, `Upstream error: ${e?.message || e}`);
    }

    return okJSON({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: full },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    });
  }
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // OPTIONS for CORS
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    let response: Response;

    if (url.pathname === "/v1/models" && request.method === "GET") {
      response = handleModelsRequest();
    } else if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
      response = await handleChatRequest(request);
    } else if (url.pathname === "/" && request.method === "GET") {
      response = okJSON({
        status: "ok",
        message: "Lambda Chat OpenAI-compatible proxy is running",
        endpoints: ["/v1/models", "/v1/chat/completions"],
      });
    } else {
      response = errJSON(404, `Path ${url.pathname} not found`);
    }

    Object.entries(corsHeaders).forEach(([k, v]) => response.headers.set(k, v));
    return response;
  } catch (e) {
    console.error("Handler error:", e);
    return new Response(
      JSON.stringify({
        error: { message: "Internal server error", type: "server_error" },
      }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } },
    );
  }
}

console.log("Server starting...");
Deno.serve(handler);
