export function sanitizeMcpOutput(text: string): string {
    if (typeof text !== 'string') return text;
    return text.replace(/<\/?(?:anti_pattern|desired_pattern|system|user_input|instruction)[^>]*>/gi, '');
}
