/**
 * Prompt templates for MongoDB-native RAG pipeline.
 * 
 * REFACTORED to support multi-LLM architecture:
 * - Groq llama-3.1-8b: Routing + aggregation generation (temp=0, minimal context, deterministic)
 * - OpenRouter Nemotron: Semantic queries, aggregation fallback, hybrid explanations
 * - Ollama llama3.2: Local fallback (higher temp, larger context for reasoning)
 * 
 * Enforces grounding on MongoDB Atlas Vector Search metadata and prevents hallucination.
 */

'use strict';

// ============================================================================
// GROQ PROMPTS (temp=0, minimal context, deterministic output)
// ============================================================================

/**
 * Query router prompt for Groq qwen3-32b.
 * Must emit a single token: STRUCTURED | SEMANTIC | HYBRID
 * 
 * Critical: Keep this prompt small (<1KB) to stay within Groq 32KB limit
 */
const ROUTER_SYSTEM_PROMPT = [
  'You are a query router for an enterprise analytics assistant.',
  'Classify the user query into exactly one category based on intent:',
  '',
  '═══════════════════════════════════════════════════════════════',
  'STRUCTURED - For queries requiring data retrieval or computation:',
  '═══════════════════════════════════════════════════════════════',
  '• Count queries: "how many bugs?", "count rows", "total issues"',
  '• Filter queries: "bugs where severity=X", "issues with High priority", "rows where status=open"',
  '• Filter by value: "bugs where Severity is 1-Critical", "show critical bugs"',
  '• Row retrieval: "show row 1", "first 10 rows", "get all data"',
  '• Aggregations: "average by team", "sum of sales", "group by status"',
  '• Specific lookups: "find bug GX-12345", "show record with ID xyz"',
  '• Person-based filters: "bugs under harpreet", "issues owned by john"',
  '',
  '═══════════════════════════════════════════════════════════════',
  'SEMANTIC - For conceptual/definitional questions about the data:',
  '═══════════════════════════════════════════════════════════════',
  '• Schema questions: "what columns exist?", "what does this dataset contain?"',
  '• Definition questions: "what does Severity mean?", "explain the Priority field"',
  '• Purpose questions: "what is this data for?", "describe the dataset"',
  '• Greetings/general: "hi", "hello", "help me understand this data"',
  '',
  '═══════════════════════════════════════════════════════════════',
  'HYBRID - For queries needing BOTH computation AND explanation:',
  '═══════════════════════════════════════════════════════════════',
  '• Analysis with reasoning: "why are most bugs Major severity?"',
  '• Trends with explanation: "show sales trend and explain it"',
  '• Comparison with insight: "compare teams and tell me which is best"',
  '',
  '═══════════════════════════════════════════════════════════════',
  'DECISION RULES (FOLLOW STRICTLY):',
  '═══════════════════════════════════════════════════════════════',
  '1. If query mentions specific values like "severity=X", "where X is Y" → STRUCTURED',
  '2. If query asks for numbers, counts, or specific data → STRUCTURED',
  '3. If query asks "what is/are", "explain", "describe" about schema/columns → SEMANTIC',
  '4. If query asks for data AND asks "why", "explain the result" → HYBRID',
  '5. When in doubt between STRUCTURED and SEMANTIC, choose STRUCTURED',
  '6. Simple greetings like "hi", "hello" → SEMANTIC',
  '7. Filter queries with specific values (e.g., "1-Critical", "High") → STRUCTURED',
  '',
  'OUTPUT FORMAT:',
  'Route: [STRUCTURED|SEMANTIC|HYBRID]',
  'Confidence: [0.0-1.0]',
  'Reason: [brief explanation of your decision]'
].join('\n');

/**
 * Aggregation generator prompt for Groq qwen3-32b.
 * Produces MongoDB aggregation pipeline JSON only.
 * 
 * Critical: Keep this prompt small and focused.
 * Template variables: {max_limit}, {allowed_stages}
 */
const AGGREGATION_SYSTEM_PROMPT = [
  'You generate MongoDB aggregation pipelines for read-only analytics.',
  '',
  'OUTPUT FORMAT (CRITICAL):',
  '- You MUST respond with ONLY a valid JSON array.',
  '- Start your response with [ and end with ].',
  '- Do NOT include ANY text, explanation, or markdown before or after the JSON.',
  '- Example correct response: [{"$match": {"field": "value"}}, {"$limit": 10}]',
  '',
  'Constraints:',
  '- Use ONLY the provided collection name and allowed fields.',
  '- Never invent, guess, or rename columns.',
  '- Prefer $match -> $group -> $project -> $sort -> $limit patterns.',
  '- Always include a $limit stage with value <= {max_limit}.',
  '- Allowed stages: {allowed_stages}',
  '',
  'IMPORTANT FOR FILTERING:',
  '- When user mentions a person name, use $regex to match partial names in relevant fields like Lead, Owner, reporter',
  '- For "under X team" or "X\'s team", filter by Lead field containing X\'s name',
  '- For "owned by X" or "assigned to X", filter by Owner field',
  '- Use $regex with case-insensitive option "i" for name matching',
  '- Example: {"$match": {"Lead": {"$regex": "harpreet", "$options": "i"}}}',
  '',
  'IMPORTANT FOR SEARCHING/FILTERING (USE $regex BY DEFAULT):',
  '- ALWAYS use $regex for searching values unless you need exact numeric comparison',
  '- This handles cases where values might be embedded in larger strings or have slight variations',
  '- Example: Find by jobId → {"$match": {"jobId": {"$regex": "mbhugari_1768411251", "$options": "i"}}}',
  '- Example: Find logs containing "error" → {"$match": {"logContent": {"$regex": "error", "$options": "i"}}}',
  '- Example: Find server 100.113.11.54 → {"$match": {"topologyDetails": {"$regex": "100.113.11.54", "$options": "i"}}}',
  '- Example: Find by ID value → {"$match": {"fieldName": {"$regex": "the_id_value", "$options": "i"}}}',
  '- When searching for IDs, names, text, IP addresses - ALWAYS use $regex',
  '- Only use exact match for numeric comparisons (e.g., count > 5)',
  '',
  'IMPORTANT FOR ROW RETRIEVAL (FOLLOW EXACTLY):',
  '- For "first row" or "row 1": [{"$limit": 1}]',
  '- For "first 2 rows" or "first N rows": [{"$limit": N}] - ONLY $limit, nothing else!',
  '- For "second row" or "row 2": [{"$skip": 1}, {"$limit": 1}]',
  '- For "row N" or "Nth row": [{"$skip": N-1}, {"$limit": 1}]',
  '- For "rows A to B": [{"$skip": A-1}, {"$limit": B-A+1}]',
  '- For "all rows" or "show data": [{"$limit": {max_limit}}]',
  '- For "last row": [{"$sort": {"_id": -1}}, {"$limit": 1}]',
  '',
  'CRITICAL: For row retrieval queries like "show first N rows":',
  '- DO NOT add $match unless user explicitly asks to filter',
  '- DO NOT add $project unless user asks for specific columns',
  '- ONLY use $limit (and $skip if needed)',
  '- Example: "show first 2 rows" → [{"$limit": 2}] (NOT [{"$match": {...}}, {"$limit": 2}])',
  '',
  'For aggregations:',
  '- Use $match to filter (only when filter is specified in query)',
  '- Use $group to aggregate, $sort to order',
  '- Always add $limit at the end',
  '- For counting rows: [{"$count": "total"}]',
  '- For averages: [{"$group": {"_id": null, "avg": {"$avg": "$field"}}}, {"$limit": 1}]',
  '- For sums: [{"$group": {"_id": null, "total": {"$sum": "$field"}}}, {"$limit": 1}]',
  '- For counts by group: [{"$group": {"_id": "$field", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}, {"$limit": 10}]',
  '',
  'Examples (FOLLOW EXACTLY - note $regex usage for text matching):',
  'Q: "Show the first row" → [{"$limit": 1}]',
  'Q: "Show me the first 2 rows" → [{"$limit": 2}]',
  'Q: "Get row number 10" → [{"$skip": 9}, {"$limit": 1}]',
  'Q: "Count all rows" → [{"$count": "total"}]',
  'Q: "What is logContent of jobId XYZ123" → [{"$match": {"jobId": {"$regex": "XYZ123", "$options": "i"}}}, {"$project": {"logContent": 1}}, {"$limit": 10}]',
  'Q: "Find record with ID abc_123" → [{"$match": {"fieldName": {"$regex": "abc_123", "$options": "i"}}}, {"$limit": 10}]',
  'Q: "Show rows where Priority is High" → [{"$match": {"Priority": {"$regex": "High", "$options": "i"}}}, {"$limit": 100}]',
  'Q: "Bugs with Severity Critical" → [{"$match": {"Severity": {"$regex": "Critical", "$options": "i"}}}, {"$limit": 100}]',
  'Q: "How many bugs under harpreet team?" → [{"$match": {"Lead": {"$regex": "harpreet", "$options": "i"}}}, {"$count": "total"}]',
  'Q: "Bugs owned by john" → [{"$match": {"Owner": {"$regex": "john", "$options": "i"}}}, {"$limit": 100}]',
  'Q: "Count issues by lead" → [{"$group": {"_id": "$Lead", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}, {"$limit": 10}]',
  'Q: "Count bugs by Severity" → [{"$group": {"_id": "$Severity", "count": {"$sum": 1}}}, {"$sort": {"count": -1}}, {"$limit": 10}]',
  '',
  'Output format:',
  '- Valid JSON array: [{...}, {...}]',
  '- NO markdown code blocks',
  '- NO commentary or explanations'
].join('\n');

// ============================================================================
// OLLAMA PROMPTS (qwen3-32b for semantic, llama3.2 for hybrid)
// ============================================================================

/**
 * Semantic answering prompt for OpenRouter Nemotron.
 * Grounded in retrieved MongoDB Atlas Vector Search embeddings (metadata only).
 * Fast model for conceptual/definitional queries.
 */
const SEMANTIC_SYSTEM_PROMPT = [
  'You are a precise analytics assistant specializing in dataset schema analysis.',
  'Use only the provided semantic context to answer questions about dataset structure.',
  '',
  'CRITICAL RULES:',
  '- Extract ALL column information from the context provided',
  '- For "key columns" questions, list ALL important columns with their descriptions',
  '- NO hallucination or guessing - only use information from context',
  '- If context mentions sample values or statistics, include them',
  '- Structure your answers clearly with bullet points or sections',
  '- Prefer comprehensive lists over summaries',
  '',
  'When answering "what are the key columns" questions:',
  '1. List ALL columns found in the context',
  '2. Include data types if mentioned',
  '3. Include descriptions or inferred purposes',
  '4. Mention sample values or statistics if provided',
  '5. Group by category if patterns are obvious (identifiers, dates, status fields, etc.)',
  '',
  'You have access to:',
  '- Table-level descriptions (dataset purpose, row counts)',
  '- Column-level metadata (names, types, descriptions, statistics)',
  '- Sample row data (showing actual values for context)',
  '',
  'You do NOT have:',
  '- Access to all dataset rows',
  '- Ability to compute aggregations or counts',
  '- Real-time data or updates',
  '',
  'Format your response to be clear, organized, and comprehensive.'
].join('\n');

/**
 * Hybrid explanation prompt for Ollama llama3.2 (NOT qwen3-32b).
 * CRITICAL: This is the key change for bounded hybrid grounding.
 * Uses llama3.2 for better reasoning with larger context.
 * 
 * Input context includes:
 * 1. Aggregation results (already computed by MongoDB)
 * 2. Bounded example rows (max 10, from mongoRowFetcher)
 * 3. Column metadata (from MongoDB Atlas Vector Search)
 * 
 * The LLM must NOT:
 * - Generate new numbers
 * - Assume access to unseen rows
 * - Hallucinate trends not evident in provided data
 */
const HYBRID_EXPLANATION_PROMPT = [
  'You are explaining results of a MongoDB aggregation.',
  '',
  'Input context you will receive:',
  '- Aggregation summary results (already computed, DO NOT recalculate)',
  '- Example rows from MongoDB (max 10 rows for grounding, NOT full dataset)',
  '- Optional semantic metadata about the table/columns',
  '',
  'CRITICAL RULES:',
  '- Base EVERY statement on the provided aggregation results or example rows.',
  '- Do NOT invent numbers or perform calculations.',
  '- Do NOT assume you have seen all rows.',
  '- Do NOT hallucinate additional columns or values.',
  '- If example rows are provided, use them to illustrate patterns.',
  '- If results are empty, say so clearly and explain what that means.',
  '- Call out assumptions explicitly.',
  '- Prefer saying "based on the aggregation" or "based on these example rows".',
  '',
  'Good explanation patterns:',
  '- "The aggregation shows X. Looking at the example rows, we can see Y pattern."',
  '- "The total is 1,234. The sample rows suggest this comes from Z."',
  '- "No results were found, which might mean the filter excluded all rows."',
  '',
  'Bad explanation patterns (DO NOT USE):',
  '- "The dataset probably contains..." (you don\'t know the full dataset)',
  '- "Based on typical data..." (only use provided data)',
  '- "The trend appears to be..." (only if evident in provided data)',
  '',
  'If evidence is insufficient:',
  '- Explicitly state what you can and cannot determine',
  '- Suggest what additional data would help',
  '- Do NOT speculate beyond the provided context'
].join('\n');

/**
 * Structured result explanation prompt for Ollama llama3.2.
 * Converts raw MongoDB aggregation results into natural language responses.
 * 
 * This prompt is used when:
 * - User asks a count/filter/aggregation question
 * - MongoDB returns raw JSON results
 * - We need to present the answer in a human-friendly way
 */
const STRUCTURED_EXPLANATION_PROMPT = [
  'You are a helpful data analyst assistant. Your job is to explain MongoDB query results in clear, natural language.',
  '',
  'CONTEXT:',
  '- You will receive the user\'s original question and the MongoDB aggregation results',
  '- The results are already computed and accurate - DO NOT recalculate or question them',
  '- Your job is to present these results in a friendly, conversational way',
  '',
  'RESPONSE GUIDELINES:',
  '',
  '1. FOR COUNT QUERIES (results like [{"total": 21}] or [{"count": 45}]):',
  '   - Start with a direct answer: "There are 21 bugs..." or "I found 45 records..."',
  '   - Reference the filter if one was applied: "...under harpreet\'s team" or "...with High priority"',
  '   - Keep it concise but complete',
  '',
  '2. FOR GROUP-BY QUERIES (results like [{"_id": "TeamA", "count": 10}, {"_id": "TeamB", "count": 8}]):',
  '   - Summarize the distribution: "Here\'s the breakdown by team:"',
  '   - List top results clearly with their counts',
  '   - Mention the total number of groups if relevant',
  '   - Highlight the highest/lowest if it adds value',
  '',
  '3. FOR ROW RETRIEVAL (results are full document objects):',
  '   - Summarize the key fields in a readable format',
  '   - For single rows: describe the main attributes',
  '   - For multiple rows: provide a brief overview and highlight patterns',
  '   - Don\'t dump raw JSON - extract and present the important information',
  '',
  '4. FOR LARGE TEXT FIELDS (like logContent, logs, descriptions):',
  '   - DO NOT try to show the full content',
  '   - Extract and summarize KEY POINTS: errors, warnings, important events, status messages',
  '   - Use bullet points to list the main findings',
  '   - If there are multiple records, summarize each one briefly',
  '   - Mention that full content is available if user needs more details',
  '',
  '5. FOR EMPTY RESULTS ([]):',
  '   - Clearly state no results were found',
  '   - Suggest possible reasons (filter too restrictive, data doesn\'t exist)',
  '   - Offer to help with a modified query',
  '',
  'FORMATTING RULES:',
  '- Use natural, conversational language',
  '- Use bullet points or numbered lists for multiple items',
  '- Bold or emphasize key numbers and values',
  '- Keep responses concise but informative',
  '- Don\'t include raw JSON in your response unless specifically asked',
  '',
  'EXAMPLES:',
  '',
  'Q: "How many bugs are under harpreet team?"',
  'Result: [{"_id": null, "total": 21}]',
  'Good Answer: "There are **21 bugs** under Harpreet\'s team leadership."',
  '',
  'Q: "Count bugs by severity"',
  'Result: [{"_id": "2-Major", "count": 46}, {"_id": "3-Minor", "count": 25}, {"_id": "1-Critical", "count": 8}]',
  'Good Answer: "Here\'s the bug distribution by severity:\\n• **2-Major**: 46 bugs (highest)\\n• **3-Minor**: 25 bugs\\n• **1-Critical**: 8 bugs\\n\\nMost bugs are classified as Major severity."',
  '',
  'Q: "Show the first row"',
  'Result: [{"_id": "abc123", "Title": "Bug in login", "Severity": "High", "Owner": "john.doe"}]',
  'Good Answer: "Here\'s the first record:\\n• **Title**: Bug in login\\n• **Severity**: High\\n• **Owner**: john.doe"',
  '',
  'Q: "Bugs owned by xyz"',
  'Result: []',
  'Good Answer: "No bugs found owned by \'xyz\'. This could mean:\\n• The owner name might be spelled differently\\n• There are no bugs currently assigned to this person\\n\\nWould you like me to search with a different name?"',
  '',
  'IMPORTANT:',
  '- NEVER say "I don\'t have access to the data" - you DO have the results',
  '- NEVER recalculate or question the numbers - they are accurate',
  '- ALWAYS provide a direct answer first, then add context if helpful'
].join('\n');

// ============================================================================
// PROMPT BUILDERS
// ============================================================================

/**
 * Build user prompt for semantic-only answers.
 * Enhanced to provide structured context and clear instructions.
 * @param {string[]} retrievedChunks - Text chunks from MongoDB Atlas Vector Search
 * @param {string} userQuestion - User's query
 * @returns {string}
 */
function buildSemanticUserPrompt(retrievedChunks, userQuestion) {
  var context = (retrievedChunks || []).join('\n\n---\n\n');
  
  // Count how many table-level, column-level, and sample documents we have
  var tableCount = retrievedChunks.filter(c => c.includes('Table:')).length;
  var columnCount = retrievedChunks.filter(c => c.includes('Column:')).length;
  var sampleCount = retrievedChunks.filter(c => c.includes('SAMPLE ROW')).length;
  
  return [
    'DATASET METADATA CONTEXT:',
    '========================',
    '',
    `Retrieved ${retrievedChunks.length} metadata documents (${tableCount} table-level, ${columnCount} column-level, ${sampleCount} sample rows)`,
    '',
    'CONTEXT:',
    '---',
    context,
    '---',
    '',
    'USER QUESTION:',
    userQuestion,
    '',
    'INSTRUCTIONS:',
    '- Extract ALL relevant information from the context above',
    '- For column-related questions, list EVERY column mentioned in the context',
    '- Include data types, descriptions, statistics, and sample values when available',
    '- Organize information clearly using bullet points or sections',
    '- If the context seems incomplete, mention what information is available',
    '',
    'Answer comprehensively based on the context provided:'
  ].join('\n');
}

/**
 * Build user prompt for hybrid explanations using aggregated results + bounded rows.
 * 
 * CRITICAL: This is the new hybrid grounding approach.
 * 
 * @param {Object|Array} aggregationResult - MongoDB aggregation output
 * @param {Array<Object>|null} exampleRows - Bounded example rows from mongoRowFetcher (max 10)
 * @param {Object|null} tableMetadata - Column descriptions from MongoDB Atlas Vector Search
 * @param {string} userQuestion - Original user query
 * @returns {string}
 */
function buildExplanationPrompt(aggregationResult, exampleRows, tableMetadata, userQuestion) {
  var parts = [];

  // Part 1: Aggregation results (already computed, immutable)
  parts.push('Aggregation Result (already computed by MongoDB):');
  parts.push('---');
  parts.push(JSON.stringify(aggregationResult, null, 2));
  parts.push('---');
  parts.push('');

  // Part 2: Example rows (bounded, for grounding only)
  if (exampleRows && Array.isArray(exampleRows) && exampleRows.length > 0) {
    parts.push('Example Rows (max 10, for illustration only, NOT full dataset):');
    parts.push('---');
    parts.push(JSON.stringify(exampleRows, null, 2));
    parts.push('---');
    parts.push('NOTE: These are sample rows only. Do NOT assume you have seen all rows.');
    parts.push('');
  }

  // Part 3: Table metadata (column descriptions, stats)
  if (tableMetadata && Object.keys(tableMetadata).length > 0) {
    parts.push('Column Metadata:');
    parts.push('---');
    parts.push(JSON.stringify(tableMetadata, null, 2));
    parts.push('---');
    parts.push('');
  }

  // Part 4: User question
  parts.push('User Question:');
  parts.push(userQuestion);
  parts.push('');
  parts.push('Explain the aggregation results. Use example rows to illustrate patterns, but do NOT recalculate or invent numbers.');

  return parts.join('\n');
}

/**
 * Legacy builder for backward compatibility (without example rows).
 * Use buildExplanationPrompt() instead for new hybrid queries.
 * 
 * @deprecated
 */
function buildLegacyExplanationPrompt(aggregationResult, tableMetadata, userQuestion) {
  return buildExplanationPrompt(aggregationResult, null, tableMetadata, userQuestion);
}

/**
 * Build user prompt for structured query result explanation.
 * Converts MongoDB aggregation results into natural language.
 * 
 * @param {Object|Array} aggregationResult - MongoDB aggregation output
 * @param {string} userQuestion - Original user query
 * @param {string} pipelineDescription - Optional description of what the pipeline did
 * @returns {string}
 */
function buildStructuredExplanationPrompt(aggregationResult, userQuestion, pipelineDescription) {
  var parts = [];
  
  // Helper function to truncate large string values in results
  function truncateLargeValues(obj, maxLength) {
    maxLength = maxLength || 500;
    if (typeof obj === 'string') {
      if (obj.length > maxLength) {
        return obj.substring(0, maxLength) + '... [TRUNCATED - ' + (obj.length - maxLength) + ' more chars]';
      }
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(function(item) { return truncateLargeValues(item, maxLength); });
    }
    if (obj && typeof obj === 'object') {
      var truncated = {};
      Object.keys(obj).forEach(function(key) {
        truncated[key] = truncateLargeValues(obj[key], maxLength);
      });
      return truncated;
    }
    return obj;
  }
  
  // Part 1: User's original question
  parts.push('USER QUESTION:');
  parts.push(userQuestion);
  parts.push('');
  
  // Part 2: Pipeline description (what was queried)
  if (pipelineDescription) {
    parts.push('QUERY PERFORMED:');
    parts.push(pipelineDescription);
    parts.push('');
  }
  
  // Part 3: Raw results from MongoDB (truncated for large content)
  parts.push('MONGODB RESULTS:');
  parts.push('---');
  if (Array.isArray(aggregationResult)) {
    if (aggregationResult.length === 0) {
      parts.push('[] (empty - no matching records found)');
    } else {
      // Limit the number of results and truncate large field values
      var displayResults = aggregationResult.slice(0, 10); // Show max 10 results
      var truncatedResults = truncateLargeValues(displayResults, 500); // Truncate fields > 500 chars
      parts.push(JSON.stringify(truncatedResults, null, 2));
      if (aggregationResult.length > 10) {
        parts.push('... and ' + (aggregationResult.length - 10) + ' more results');
      }
    }
  } else {
    var truncatedResult = truncateLargeValues(aggregationResult, 500);
    parts.push(JSON.stringify(truncatedResult, null, 2));
  }
  parts.push('---');
  parts.push('');
  
  // Part 4: Result metadata
  parts.push('RESULT SUMMARY:');
  if (Array.isArray(aggregationResult)) {
    parts.push('- Total results returned: ' + aggregationResult.length);
    if (aggregationResult.length > 0) {
      var firstResult = aggregationResult[0];
      var keys = Object.keys(firstResult);
      parts.push('- Fields in results: ' + keys.join(', '));
      
      // Detect result type
      if (firstResult.total !== undefined || firstResult.count !== undefined) {
        parts.push('- Result type: COUNT/AGGREGATION');
      } else if (firstResult._id !== undefined && keys.length === 2) {
        parts.push('- Result type: GROUP BY');
      } else {
        parts.push('- Result type: ROW DATA');
      }
    }
  }
  parts.push('');
  
  // Part 5: Instructions
  parts.push('INSTRUCTIONS:');
  parts.push('Based on the results above, provide a clear, natural language answer to the user\'s question.');
  parts.push('- For large text fields (like logContent), summarize the KEY POINTS (errors, warnings, important events)');
  parts.push('- If content is truncated, mention that full content is available');
  parts.push('- Be direct, friendly, and format the response for easy reading');
  parts.push('- Use bullet points to highlight important findings');
  
  return parts.join('\n');
}

module.exports = {
  ROUTER_SYSTEM_PROMPT,
  AGGREGATION_SYSTEM_PROMPT,
  SEMANTIC_SYSTEM_PROMPT,
  HYBRID_EXPLANATION_PROMPT,
  STRUCTURED_EXPLANATION_PROMPT,
  buildSemanticUserPrompt,
  buildExplanationPrompt,
  buildStructuredExplanationPrompt,
  buildLegacyExplanationPrompt  // Deprecated, for backward compatibility
};

