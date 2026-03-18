/**
 * Google Gemini AI Client
 *
 * This module integrates with Google's Gemini AI models for research
 * paper analysis. It uses the @google/generative-ai SDK (Google AI Studio).
 *
 * Current model: gemini-2.0-flash (fast, high-quality, good for long documents)
 *
 * The main function (analyzePaperWithGemini) takes a paper's full text and
 * generates a detailed analysis based on the requested type:
 *   - "summary"           → research question, methodology, findings, conclusions
 *   - "critique"          → methodology assessment, validity, limitations
 *   - "literature review" → how it fits in the broader research landscape
 *   - "key findings"      → most significant results and implications
 *   - "comprehensive"     → all of the above combined (default)
 *
 * Requires: GOOGLE_API_KEY environment variable
 *
 * Note: This module also exports an MCP client factory (createMcpClient)
 * which can be used for testing or inter-server communication.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { Readable } from "stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const googleGenAi = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);

export function bufferToStream(buffer: Buffer): Readable {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null); // Signal the end of the stream
  return stream;
}

/**
 * Creates an MCP client connected to the Brave Search server
 */
export async function createMcpClient() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["index.js"], // Server entry point
  });

  const client = new Client(
    { name: "gemini-mcp-client", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  await client.connect(transport);
  return { client, transport };
}

/**
 * Analyzes research paper content using Google's Gemini-2.0-flash model
 * @param paperContent - The text content of the research paper
 * @param analysisType - The type of analysis to perform (summary, critique, etc.)
 * @param additionalContext - Any additional context or specific questions
 * @returns Detailed analysis of the research paper
 */
export async function analyzePaperWithGemini(
  paperContent: string,
  analysisType: string,
  additionalContext?: string
): Promise<string> {
  try {
    // Initialize the Gemini Pro model
    const model = googleGenAi.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Create the prompt based on analysis type
    let prompt = `I need you to perform a detailed ${analysisType} analysis of the following research paper.\n\n`;
    
    if (additionalContext) {
      prompt += `Additional context: ${additionalContext}\n\n`;
    }
    
    prompt += `Research paper content:\n${paperContent}\n\n`;
    
    switch (analysisType.toLowerCase()) {
      case "summary":
        prompt += "Provide a comprehensive summary including the research question, methodology, key findings, and conclusions.";
        break;
      case "critique":
        prompt += "Provide a critical evaluation of the research methodology, validity of findings, limitations, and suggestions for improvement.";
        break;
      case "literature review":
        prompt += "Analyze how this paper fits into the broader research landscape, identifying key related works and research gaps.";
        break;
      case "key findings":
        prompt += "Extract and explain the most significant findings and their implications.";
        break;
      default:
        prompt += "Perform a comprehensive analysis including summary, methodology assessment, key findings, limitations, and significance.";
    }

    // Generate content using Gemini
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    
    return text;
  } catch (error) {
    console.error("Error analyzing paper with Gemini:", error);
    throw new Error(`Failed to analyze paper: ${error instanceof Error ? error.message : String(error)}`);
  }
}
