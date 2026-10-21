import { runSetupCommand } from '../../src/utils/omlxSetup.ts';
await runSetupCommand(process.execPath, ['-e', "process.stdout.write('CHILD '+process.pid+'\\n'); setInterval(() => {}, 1000)"], {
    timeoutMs: 20000,
    onSpawn: async pid => { process.stdout.write('GROUP '+pid+'\n'); },
    log: text => process.stdout.write(text),
});
