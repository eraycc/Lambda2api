// deno-deploy-lambda-chat-proxy.ts

import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

const LAMBDA_CHAT_URL = "https://lambda.chat";
const CONVERSATION_URL = `${LAMBDA_CHAT_URL}/conversation`;

// 模型列表和别名
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

const MODEL_ALIASES: Record<string, string | string[]> = {
  "hermes-3": "hermes3-405b-fp8-128k",
  "hermes-3-405b": ["hermes3-405b-fp8-128k", "hermes-3-llama-3.1-405b-fp8"],
  "nemotron-70b": "llama3.1-nemotron-70b-instruct",
  "llama-3.3-70b": "llama3.3-70b-instruct-fp8",
  "qwen-2.5-coder-32b": "qwen25-coder-32b-instruct",
  "llama-4-maverick": "llama-4-maverick-17b-128e-instruct-fp8",
  "llama-4-scout": "llama-4-scout-17b-16e-instruct",
  "qwen-3-32b": "qwen3-32b-fp8"
};

const DEFAULT_MODEL = "deepseek-r1";

// 获取实际使用的模型名称
function getModel(model: string): string {
  if (!model) return DEFAULT_MODEL;
  
  if (MODELS.includes(model)) return model;
  
  if (model in MODEL_ALIASES) {
    const alias = MODEL_ALIASES[model];
    if (Array.isArray(alias)) {
      return alias[Math.floor(Math.random() * alias.length)];
    }
    return alias;
  }
  
  throw new Error(`Model ${model} not found`);
}

// 生成 UUID
function generateUUID(): string {
  return crypto.randomUUID();
}

// 获取最后一条用户消息
function getLastUserMessage(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return messages[i].content;
    }
  }
  return "";
}

// 创建 OpenAI 格式的流式响应
function createStreamResponse(content: string, finish = false): string {
  const data = {
    id: `chatcmpl-${generateUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: DEFAULT_MODEL,
    choices: [{
      index: 0,
      delta: finish ? {} : { content },
      finish_reason: finish ? "stop" : null
    }]
  };
  return `data: ${JSON.stringify(data)}\n\n`;
}

// 创建 OpenAI 格式的非流式响应
function createCompletionResponse(content: string, model: string): any {
  return {
    id: `chatcmpl-${generateUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content
      },
      finish_reason: "stop"
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0
    }
  };
}

// 处理聊天完成请求
async function handleChatCompletion(request: Request): Promise<Response> {
  try {
    const body = await request.json();
    const { messages, stream = false, model: userModel } = body;
    
    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "Messages are required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    const model = getModel(userModel || DEFAULT_MODEL);
    const userMessage = getLastUserMessage(messages);
    
    if (!userMessage) {
      return new Response(JSON.stringify({ error: "No user message found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }
    
    // Headers for LambdaChat
    const headers = {
      "Origin": LAMBDA_CHAT_URL,
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      "Accept": "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": LAMBDA_CHAT_URL,
      "Content-Type": "application/json",
      "Cookie": `hf-chat=${generateUUID()}`
    };
    
    // Step 1: Create conversation
    const createResponse = await fetch(CONVERSATION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ model })
    });
    
    if (!createResponse.ok) {
      throw new Error(`Failed to create conversation: ${createResponse.status}`);
    }
    
    const conversationData = await createResponse.json();
    const conversationId = conversationData.conversationId;
    
    // Step 2: Get conversation data to extract message ID
    const dataResponse = await fetch(
      `${CONVERSATION_URL}/${conversationId}/__data.json?x-sveltekit-invalidated=11`,
      { headers }
    );
    
    if (!dataResponse.ok) {
      throw new Error(`Failed to get conversation data: ${dataResponse.status}`);
    }
    
    const dataText = await dataResponse.text();
    let messageId: string | null = null;
    
    // Parse response to find message ID
    const lines = dataText.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const data = JSON.parse(line);
        if (data.type === "data" && data.nodes) {
          for (const node of data.nodes) {
            if (node.type === "data" && node.data) {
              for (const item of node.data) {
                if (item?.id && item?.from === "system") {
                  messageId = item.id;
                  break;
                }
              }
            }
          }
        }
      } catch {
        // Continue to next line
      }
      
      if (messageId) break;
    }
    
    // Fallback: find any UUID in response
    if (!messageId) {
      const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
      const match = dataText.match(uuidPattern);
      if (match) {
        messageId = match[0];
      }
    }
    
    if (!messageId) {
      throw new Error("Could not find message ID");
    }
    
    // Step 3: Send user message
    const formData = new FormData();
    formData.append("data", JSON.stringify({
      inputs: userMessage,
      id: messageId,
      is_retry: false,
      is_continue: false,
      web_search: false,
      tools: []
    }));
    
    const chatResponse = await fetch(`${CONVERSATION_URL}/${conversationId}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": undefined // Let fetch set the boundary for multipart/form-data
      },
      body: formData
    });
    
    if (!chatResponse.ok) {
      throw new Error(`Failed to send message: ${chatResponse.status}`);
    }
    
    // Handle streaming response
    if (stream) {
      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        async start(controller) {
          const reader = chatResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split('\n');
              buffer = lines.pop() || "";
              
              for (const line of lines) {
                if (!line.trim()) continue;
                
                try {
                  const data = JSON.parse(line);
                  
                  if (data.type === "stream" && data.token) {
                    const token = data.token.replace(/\u0000/g, "");
                    if (token) {
                      controller.enqueue(encoder.encode(createStreamResponse(token)));
                    }
                  } else if (data.type === "finalAnswer") {
                    controller.enqueue(encoder.encode(createStreamResponse("", true)));
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                    break;
                  }
                } catch {
                  // Ignore parse errors
                }
              }
            }
          } finally {
            controller.close();
          }
        }
      });
      
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    } else {
      // Handle non-streaming response
      const reader = chatResponse.body!.getReader();
      const decoder = new TextDecoder();
      let fullContent = "";
      let buffer = "";
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";
        
        for (const line of lines) {
          if (!line.trim()) continue;
          
          try {
            const data = JSON.parse(line);
            
            if (data.type === "stream" && data.token) {
              const token = data.token.replace(/\u0000/g, "");
              if (token) {
                fullContent += token;
              }
            } else if (data.type === "finalAnswer") {
              break;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
      
      return new Response(JSON.stringify(createCompletionResponse(fullContent, model)), {
        headers: { "Content-Type": "application/json" }
      });
    }
  } catch (error) {
    console.error("Error in handleChatCompletion:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

// 处理模型列表请求
function handleModels(): Response {
  const modelList = {
    object: "list",
    data: MODELS.map(id => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "lambda-chat"
    }))
  };
  
  return new Response(JSON.stringify(modelList), {
    headers: { "Content-Type": "application/json" }
  });
}

// 主请求处理器
async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  
  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
  
  // Handle preflight requests
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  
  try {
    if (url.pathname === "/" && request.method === "GET") {
      resp = jsonResponse({
        status: "ok",
        message: "Lambda.chat OpenAI-compatible proxy is running",
        endpoints: ["/v1/models", "/v1/chat/completions"],
      });
    } else if (path === "/v1/models" && request.method === "GET") {
      const response = handleModels();
      return new Response(response.body, {
        ...response,
        headers: { ...response.headers, ...corsHeaders }
      });
    } else if (path === "/v1/chat/completions" && request.method === "POST") {
      const response = await handleChatCompletion(request);
      return new Response(response.body, {
        ...response,
        headers: { ...response.headers, ...corsHeaders }
      });
    } else {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  } catch (error) {
    console.error("Handler error:", error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : "Internal server error" 
    }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}

console.log("Server starting...");
Deno.serve(handler);
