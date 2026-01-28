/**
 * LLM-based query router that classifies questions into:
 * STRUCTURED | SEMANTIC | HYBRID using Groq/OpenRouter.
 * 
 * Responsibilities:
 * - Groq: Query routing (temp=0, minimal context)
 * - OpenRouter (Nemotron): Semantic queries, aggregation, hybrid explanations
 * - Ollama (fallback): Local fallback if OpenRouter unavailable
 */

'use strict';

const fetch = require('node-fetch');
const AbortController = require('abort-controller');
const logger = require('../logger');
const prompts = require('./prompts');

// Timeout configuration (in milliseconds)
const OPENROUTER_TIMEOUT = parseInt(process.env.OPENROUTER_TIMEOUT || '180000', 10); // 3 minutes default
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT || '180000', 10); // 3 minutes default (fallback)

// Feature flags
const USE_GROQ_FOR_ROUTING = process.env.USE_GROQ_FOR_ROUTING !== 'false'; // Default: true (use Groq)
const USE_GROQ_FOR_AGGREGATION = process.env.USE_GROQ_FOR_AGGREGATION !== 'false'; // Default: true (use Groq)

// Groq configuration
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_ROUTING_MODEL = 'llama-3.1-8b-instant'; // Fast model for routing + aggregation generation
const GROQ_MAX_CONTEXT = 30000; // 32KB hard limit, use 30KB safety margin

// OpenRouter configuration (NVIDIA Nemotron via OpenRouter)
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-nano-30b-a3b:free';
const OPENROUTER_MAX_CONTEXT = 256000; // 256K context window for Nemotron

// Ollama configuration (fallback only)
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const OLLAMA_HYBRID_MODEL = process.env.OLLAMA_HYBRID_MODEL || 'llama3.2';

var QueryType = {
  STRUCTURED: 'STRUCTURED',
  SEMANTIC: 'SEMANTIC',
  HYBRID: 'HYBRID'
};

/**
 * Call Groq API for deterministic, small-context tasks.
 * Used for: query routing, aggregation pipeline generation.
 * Constraints: 32KB context limit, temperature=0, JSON-only output.
 * 
 * @param {Array<{role:string, content:string}>} messages
 * @param {number} temperature - Should be 0 for routing/aggregation
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
async function groqChat(messages, temperature, maxTokens) {
  if (!GROQ_API_KEY) {
    logger.warn('GROQ_API_KEY not set, falling back to OpenRouter');
    return openRouterChat(messages, temperature, maxTokens);
  }

  // Validate context size (32KB = ~8K tokens, 1 token ≈ 4 chars)
  var totalChars = messages.reduce(function(sum, m) {
    return sum + (m.content || '').length;
  }, 0);
  
  if (totalChars > GROQ_MAX_CONTEXT) {
    throw new Error('Groq context limit exceeded: ' + totalChars + ' chars > ' + GROQ_MAX_CONTEXT);
  }

  var response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_ROUTING_MODEL,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens || 16,
      top_p: 1.0,
      stream: false
    }),
    timeout: 30000
  });

  if (!response.ok) {
    var errorText = await response.text();
    logger.error('Groq API error: ' + response.status + ' ' + errorText);
    throw new Error('Groq API error: ' + response.status);
  }

  var data = await response.json();
  var content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;

  if (!content) {
    throw new Error('Empty response from Groq');
  }
  return content.trim();
}

/**
 * Call OpenRouter API with NVIDIA Nemotron model.
 * Used for: semantic explanations, hybrid answers, aggregation fallback.
 * OpenRouter uses OpenAI-compatible API format.
 * 
 * Note: Some models (like Nemotron) may use reasoning tokens. The response
 * may include reasoning_details in addition to or instead of content.
 * 
 * @param {Array<{role:string, content:string}>} messages
 * @param {number} temperature
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
async function openRouterChat(messages, temperature, maxTokens) {
  if (!OPENROUTER_API_KEY) {
    logger.warn('OPENROUTER_API_KEY not set, falling back to Ollama');
    return ollamaChatWithModel(messages, temperature, maxTokens, OLLAMA_MODEL);
  }

  // Create AbortController for proper timeout handling
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, OPENROUTER_TIMEOUT);

  // Ensure minimum token count - some models need more tokens for reasoning
  var effectiveMaxTokens = Math.max(maxTokens || 512, 256);

  try {
    logger.info('[OpenRouter] Sending request to model: ' + OPENROUTER_MODEL);
    logger.info('[OpenRouter] Timeout set to: ' + OPENROUTER_TIMEOUT + 'ms');
    logger.info('[OpenRouter] Max tokens: ' + effectiveMaxTokens);
    
    var response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENROUTER_API_KEY,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://datagroom.app', // Optional: identifies your app
        'X-Title': 'Datagroom RAG' // Optional: shows in OpenRouter dashboard
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: messages,
        temperature: typeof temperature === 'number' ? temperature : 0,
        max_tokens: effectiveMaxTokens,
        stream: false
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      var errorText = await response.text();
      logger.error('[OpenRouter] API error: ' + response.status + ' ' + errorText);
      
      // Fallback to Ollama on error
      logger.warn('[OpenRouter] Falling back to Ollama due to API error');
      return ollamaChatWithModel(messages, temperature, maxTokens, OLLAMA_MODEL);
    }

    var data = await response.json();
    
    // Log the response structure for debugging
    var messageObj = data && data.choices && data.choices[0] ? data.choices[0].message : null;
    logger.info('[OpenRouter] Response structure: ' + JSON.stringify({
      hasChoices: !!data.choices,
      choicesLength: data.choices ? data.choices.length : 0,
      hasMessage: !!messageObj,
      hasContent: messageObj ? !!messageObj.content : false,
      contentLength: messageObj && messageObj.content ? messageObj.content.length : 0,
      contentPreview: messageObj && messageObj.content ? messageObj.content.substring(0, 100) : '',
      hasReasoningDetails: messageObj ? !!messageObj.reasoning_details : false,
      reasoningDetailsLength: messageObj && messageObj.reasoning_details ? messageObj.reasoning_details.length : 0
    }));

    // Extract content - ALWAYS prefer the content field over reasoning_details
    // reasoning_details contains internal thinking, content contains the actual answer
    var content = null;
    
    if (data && data.choices && data.choices[0] && data.choices[0].message) {
      var message = data.choices[0].message;
      
      // Primary: standard content field (ALWAYS use this if available)
      if (message.content && message.content.trim()) {
        content = message.content;
        logger.info('[OpenRouter] Using standard content field');
      }
      // Fallback: If content is empty but we have reasoning_details, try to extract JSON from it
      else if (message.reasoning_details && Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0) {
        // Concatenate reasoning details
        var reasoningText = message.reasoning_details.map(function(r) {
          return typeof r === 'string' ? r : (r.content || r.text || JSON.stringify(r));
        }).join('\n');
        
        // Try to extract JSON array from reasoning (model often includes the answer at the end)
        var jsonMatch = reasoningText.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
        if (jsonMatch) {
          content = jsonMatch[1];
          logger.info('[OpenRouter] Extracted JSON from reasoning_details markdown block');
        } else {
          // Try to find a raw JSON array in the text (look for MongoDB operators)
          var arrayMatch = reasoningText.match(/(\[\s*\{[^[\]]*"\$\w+"[^[\]]*\}\s*\])/);
          if (arrayMatch) {
            content = arrayMatch[1];
            logger.info('[OpenRouter] Extracted MongoDB JSON array from reasoning_details');
          } else {
            // Try simpler JSON array pattern
            var simpleArrayMatch = reasoningText.match(/(\[\s*\{[\s\S]*?\}\s*\])\s*$/);
            if (simpleArrayMatch) {
              content = simpleArrayMatch[1];
              logger.info('[OpenRouter] Extracted JSON array from end of reasoning_details');
            } else {
              // No JSON found - fall back to Ollama instead of using reasoning text
              logger.warn('[OpenRouter] No JSON found in reasoning_details, falling back to Ollama');
              logger.info('[OpenRouter] Reasoning text preview: ' + reasoningText.substring(0, 200));
              return ollamaChatWithModel(messages, temperature, maxTokens, OLLAMA_MODEL);
            }
          }
        }
      }
      // Fallback: check for reasoning field
      else if (message.reasoning && message.reasoning.trim()) {
        content = message.reasoning;
        logger.info('[OpenRouter] Used reasoning field as content');
      }
    }

    if (!content || !content.trim()) {
      logger.error('[OpenRouter] Empty response received. Full response: ' + JSON.stringify(data).substring(0, 500));
      // Fallback to Ollama on empty response instead of throwing
      logger.warn('[OpenRouter] Falling back to Ollama due to empty response');
      return ollamaChatWithModel(messages, temperature, maxTokens, OLLAMA_MODEL);
    }
    
    logger.info('[OpenRouter] Response received successfully, content length: ' + content.length);
    return content.trim();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      logger.error('[OpenRouter] Request timed out after ' + OPENROUTER_TIMEOUT + 'ms');
      // Fallback to Ollama on timeout
      logger.warn('[OpenRouter] Falling back to Ollama due to timeout');
      return ollamaChatWithModel(messages, temperature, maxTokens, OLLAMA_MODEL);
    }
    // Fallback to Ollama on any other error
    logger.error('[OpenRouter] Error: ' + error.message);
    logger.warn('[OpenRouter] Falling back to Ollama due to error');
    return ollamaChatWithModel(messages, temperature, maxTokens, OLLAMA_MODEL);
  }
}

/**
 * Call OpenRouter (Nemotron) for semantic explanations and hybrid answers.
 * Replaces Ollama as the primary LLM for semantic/hybrid queries.
 * Falls back to Ollama if OpenRouter is unavailable.
 * 
 * @param {Array<{role:string, content:string}>} messages
 * @param {number} temperature
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
async function ollamaChat(messages, temperature, maxTokens) {
  // Use OpenRouter (Nemotron) as primary, Ollama as fallback
  return openRouterChat(messages, temperature, maxTokens);
}

/**
 * Call OpenRouter (Nemotron) for hybrid explanations specifically.
 * Replaces Ollama hybrid model with OpenRouter Nemotron.
 * Falls back to Ollama if OpenRouter is unavailable.
 * 
 * @param {Array<{role:string, content:string}>} messages
 * @param {number} temperature
 * @param {number} maxTokens
 * @returns {Promise<string>}
 */
async function ollamaChatHybrid(messages, temperature, maxTokens) {
  // Use OpenRouter (Nemotron) as primary, Ollama as fallback
  return openRouterChat(messages, temperature, maxTokens);
}

/**
 * Core Ollama API call with specified model.
 * 
 * @param {Array<{role:string, content:string}>} messages
 * @param {number} temperature
 * @param {number} maxTokens
 * @param {string} model
 * @returns {Promise<string>}
 */
async function ollamaChatWithModel(messages, temperature, maxTokens, model) {
  // Convert messages array to a single prompt for Ollama
  var prompt = messages.map(function(m) {
    return m.role + ': ' + m.content;
  }).join('\n\n');

  // Create AbortController for proper timeout handling
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, OLLAMA_TIMEOUT);

  try {
    logger.info('[Ollama] Sending request to model: ' + model);
    logger.info('[Ollama] Timeout set to: ' + OLLAMA_TIMEOUT + 'ms');
    logger.info('[Ollama] Prompt length: ' + prompt.length + ' characters');
    logger.info('[Ollama] Max tokens: ' + (maxTokens || 512));
    
    var response = await fetch(OLLAMA_API_URL + '/api/generate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        options: {
          temperature: typeof temperature === 'number' ? temperature : 0,
          num_predict: maxTokens || 512
        }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      var errorText = await response.text();
      logger.error('Ollama error: ' + response.status + ' ' + errorText);
      throw new Error('Ollama error: ' + response.status + ' - ' + errorText);
    }

    var data = await response.json();
    var content = data && data.response;

    if (!content) {
      throw new Error('Empty response from Ollama');
    }
    
    logger.info('[Ollama] Response received successfully');
    return content.trim();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      logger.error('[Ollama] Request timed out after ' + OLLAMA_TIMEOUT + 'ms');
      throw new Error('network timeout at: ' + OLLAMA_API_URL + '/api/generate');
    }
    throw error;
  }
}

/**
 * Route a user query to the appropriate pipeline using Groq or Ollama.
 * 
 * NEW: Returns structured output with confidence score and reasoning
 * 
 * @param {string} userQuery - The user's natural language query
 * @returns {Promise<Object>} - {route: string, confidence: number, reason: string}
 */
async function routeQuery(userQuery) {
  logger.info('[RAG] Routing query: ' + userQuery);

  // Use Groq for routing if enabled, otherwise Ollama
  var chatFunction = (USE_GROQ_FOR_ROUTING && GROQ_API_KEY) ? groqChat : ollamaChat;
  
  // Enhanced prompt for structured output
  var enhancedPrompt = userQuery + '\n\nProvide your classification in this format:\nRoute: [STRUCTURED|SEMANTIC|HYBRID]\nConfidence: [0.0-1.0]\nReason: [brief explanation]';
  
  var result = await chatFunction(
    [
      { role: 'system', content: prompts.ROUTER_SYSTEM_PROMPT },
      { role: 'user', content: enhancedPrompt }
    ],
    0.0, // Temperature must be 0 for deterministic routing
    50   // Allow more tokens for structured output
  );

  // Parse structured output
  var route = null;
  var confidence = 0.5; // Default confidence
  var reason = 'No reasoning provided';

  // Extract route
  var cleaned = result.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  var routeMatch = cleaned.match(/Route:\s*(STRUCTURED|SEMANTIC|HYBRID)/i);
  if (routeMatch) {
    route = routeMatch[1].toUpperCase();
  } else {
    // Fallback: try to find route keyword anywhere
    var keywordMatch = cleaned.toUpperCase().match(/\b(STRUCTURED|SEMANTIC|HYBRID)\b/);
    if (keywordMatch) {
      route = keywordMatch[1];
    }
  }

  // Extract confidence
  var confidenceMatch = cleaned.match(/Confidence:\s*(0?\.\d+|1\.0|[01])/i);
  if (confidenceMatch) {
    confidence = parseFloat(confidenceMatch[1]);
    confidence = Math.max(0, Math.min(1, confidence)); // Clamp to [0, 1]
  }

  // Extract reason
  var reasonMatch = cleaned.match(/Reason:\s*(.+?)(?:\n|$)/i);
  if (reasonMatch) {
    reason = reasonMatch[1].trim();
  }

  // Validate route
  if (!route || !QueryType[route]) {
    logger.warn('[RAG] Router produced invalid route, defaulting to HYBRID with low confidence');
    route = QueryType.HYBRID;
    confidence = 0.3; // Low confidence for fallback
    reason = 'Fallback due to unclear routing decision';
  }

  // Confidence-based fallback
  var CONFIDENCE_THRESHOLD = 0.6;
  if (confidence < CONFIDENCE_THRESHOLD) {
    logger.warn('[RAG] Low routing confidence (' + confidence.toFixed(2) + '), forcing HYBRID mode');
    route = QueryType.HYBRID;
    reason = 'Low confidence routing, using HYBRID for safety: ' + reason;
  }

  logger.info('[RAG] Router decision: ' + route + ' (confidence: ' + confidence.toFixed(2) + ', reason: ' + reason + ')');

  return {
    route: route,
    confidence: confidence,
    reason: reason
  };
}

module.exports = {
  QueryType,
  routeQuery,
  groqChat,
  openRouterChat,
  ollamaChat,
  ollamaChatHybrid,
  OPENROUTER_MODEL,
  OLLAMA_HYBRID_MODEL
};

