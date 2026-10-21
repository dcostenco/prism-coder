import { runSetupCommand } from '../../src/utils/omlxSetup.ts';
try {
    await runSetupCommand(process.execPath, ['-e', "process.stdout.write(String(process.pid)+'\\n'); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], {
        timeoutMs: 10000, log: text => process.stdout.write(text),
    });
} catch { /* Signal must still terminate the parent after the owned child stops. */ }
