// jsdom 20 probes for optional node-canvas using require.resolve, then requires
// it outside its try/catch. pnpm's existing onlyBuiltDependencies deliberately
// leaves canvas's native binding unbuilt. Use jsdom's normal canvas-less DOM
// when that binding is unavailable. Real browsers and Worker FFmpeg tests still
// exercise media; this does not provide a fake canvas or intercept app imports.
const Module = require('node:module');
let available = false;
try {
  available = typeof require('canvas').createCanvas === 'function';
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' && error.code !== 'ERR_DLOPEN_FAILED') throw error;
}
if (!available) {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, ...args) {
    if (request === 'canvas' && /[/\\]jsdom[/\\]lib[/\\]jsdom[/\\]utils\.js$/.test(parent?.filename || '')) {
      const error = new Error('Optional native canvas unavailable; jsdom uses its canvas-less DOM.');
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return originalResolve.call(this, request, parent, ...args);
  };
}
