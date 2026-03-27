import { chain } from 'stream-chain';
import { parser } from 'stream-json';
import StreamArray from 'stream-json/streamers/stream-array.js';

console.log('Imports successful!');
console.log('chain:', typeof chain);
console.log('parser:', typeof parser);
console.log('StreamArray:', typeof StreamArray);
