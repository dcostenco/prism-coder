/**
 * QuickJS Sandbox Executor
 *
 * This module runs user-provided JavaScript code in a secure, isolated
 * environment using QuickJS (a lightweight JavaScript engine compiled to WASM).
 *
 * Why a sandbox?
 *   The "code mode" tools let the AI write JavaScript to extract specific
 *   fields from large API responses. Running untrusted code directly in
 *   Node.js would be a security risk. QuickJS provides:
 *     - Memory isolation (50MB limit, separate heap)
 *     - Execution timeout (10 seconds default)
 *     - No access to Node.js APIs, filesystem, or network
 *
 * How it works:
 *   1. The raw data (e.g., Brave Search API response) is injected as a
 *      global variable called "DATA" (a JSON string)
 *   2. The user's code reads DATA, parses it, extracts what it needs
 *   3. The code calls console.log() to output the result
 *   4. We capture the console.log output and return it
 *
 * Example user code:
 *   const r = JSON.parse(DATA);
 *   console.log(r.web.results.map(x => x.title).join('\\n'));
 *
 * Returns:
 *   { stdout: "captured output", error?: "if something went wrong", executionTimeMs: 42 }
 */

import { getQuickJS } from "quickjs-emscripten";

export interface SandboxResult {
    stdout: string;
    error?: string;
    executionTimeMs: number;
}

/**
 * Runs the given javascript `code` in a sandboxed QuickJS environment.
 * Injects a global variable `DATA` which contains the stringified payload.
 */
export async function runInSandbox(dataStr: string, code: string, timeoutMs: number = 10000): Promise<SandboxResult> {
    const QuickJS = await getQuickJS();

    // Set memory limit to 50MB (arbitrary safe limit for extraction)
    const vm = QuickJS.newContext();
    vm.runtime.setMemoryLimit(50 * 1024 * 1024);

    const startTime = Date.now();
    let stdout = "";

    try {
        // Inject console.log to capture stdout
        const logHandle = vm.newFunction("log", (...args) => {
            const parts = args.map((arg) => vm.getString(arg));
            stdout += parts.join(" ") + "\n";
        });

        const consoleHandle = vm.newObject();
        vm.setProp(consoleHandle, "log", logHandle);
        vm.setProp(vm.global, "console", consoleHandle);
        consoleHandle.dispose();
        logHandle.dispose();

        // Inject the raw API response string as "DATA"
        const dataHandle = vm.newString(dataStr);
        vm.setProp(vm.global, "DATA", dataHandle);
        dataHandle.dispose();

        // Set execution timeout via interrupt handler periodically
        vm.runtime.setInterruptHandler(() => {
            if (Date.now() - startTime > timeoutMs) {
                return true; // interrupt execution
            }
            return false;
        });

        const result = vm.evalCode(code);

        if (result.error) {
            const errorMsg = vm.dump(result.error);
            result.error.dispose();
            return {
                stdout,
                error: `Script Error: ${errorMsg}`,
                executionTimeMs: Date.now() - startTime
            };
        } else {
            result.value.dispose();
        }

        return {
            stdout,
            executionTimeMs: Date.now() - startTime
        };
    } catch (err: any) {
        return {
            stdout,
            error: `Runtime Exception: ${err.message}`,
            executionTimeMs: Date.now() - startTime
        };
    } finally {
        vm.dispose();
    }
}
