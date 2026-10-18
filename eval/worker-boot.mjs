// Worker-thread entry: register the tsx loader inside the worker (the parent's
// loader hooks do not resolve extensionless TypeScript imports there), then
// load the real worker module.
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
