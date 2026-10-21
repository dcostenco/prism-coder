/** Isolated setup supervisor. The parent persists its process group before
 * sending the command; disconnect also stops the entire owned group. */
export const OMLX_SETUP_WORKER_SOURCE = String.raw`
const {spawn} = require('node:child_process');
let started = false, stopping = false;
function stop() {
    if (stopping) return;
    stopping = true;
    if (process.platform === 'win32') process.exit(1);
    process.kill(-process.pid, 'SIGTERM');
    setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 1800);
}
['SIGINT','SIGTERM','SIGHUP'].forEach(signal => process.on(signal, stop));
process.on('disconnect', stop);
const waiting = setTimeout(stop, 30000);
process.once('message', message => {
    if (started || stopping) return;
    started = true; clearTimeout(waiting);
    const child = spawn(message.program, message.args, {stdio:['ignore','inherit','inherit'], shell:false});
    child.once('error', () => { if (!stopping) process.exit(1); });
    child.once('close', code => { if (!stopping) process.exit(code === 0 ? 0 : 1); });
});
`;
