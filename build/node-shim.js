// Stub for Node built-ins referenced inside Emscripten's runtime detection.
// Those branches only execute when ENVIRONMENT_IS_NODE is true, which never
// happens in the browser — but esbuild resolves the require() calls
// statically, so they need to point at something.
export default {};
export const dirname = () => '';
export const readFileSync = () => { throw new Error('not available in the browser'); };
export const normalize = (p) => p;
export const join = (...p) => p.join('/');
