export function sanitizeMcpOutput(text: string): string {
    if (typeof text !== 'string') return text;
    return text
        .replace(/[＜＞]/g, '')
        .replace(/<\/?(?:anti_pattern|desired_pattern|system|user_input|instruction|assistant|tool_call|tool_result|prism_memory|context|function|admin|override|result)[^>]*>/gi, '')
        .replace(/<\s+\/?(?:system|instruction|assistant|tool_call|admin|override)[^>]*>/gi, '')
        .replace(/```(?:system|instruction|assistant)[^`]*```/gi, '');
}
