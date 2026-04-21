// Hyper-Aggressive Node.js Polyfills with Proxy Protection
const fallbackProcess = {
    version: 'v16.0.0',
    env: { NODE_ENV: 'production' },
    platform: 'browser',
    nextTick: (cb) => setTimeout(cb, 0),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    cwd: () => '/',
    type: 'renderer',
    browser: true
};

const internalTypes = {
    isNativeError: (val) => val instanceof Error,
    isPromise: (val) => val instanceof Promise,
    isRegExp: (val) => val instanceof RegExp,
    isDate: (val) => val instanceof Date
};

// Use a Proxy to prevent unenv from overwriting our working types
const protectedTypes = new Proxy(internalTypes, {
    get(target, prop) {
        return target[prop];
    },
    set() {
        // Silently ignore attempts to overwrite our polyfills
        return true; 
    },
    defineProperty() {
        return true;
    }
});

const fallbackUtil = {
    types: protectedTypes,
    inspect: (val) => {
        try { return JSON.stringify(val, null, 2); } catch(e) { return String(val); }
    },
    format: (...args) => args.join(' '),
    promisify: (fn) => (...args) => new Promise((resolve, reject) => fn(...args, (err, val) => err ? reject(err) : resolve(val)))
};

const fallbackBuffer = {
    from: (data) => {
        if (typeof data === 'string') return new TextEncoder().encode(data);
        return new Uint8Array(data);
    },
    isBuffer: (val) => val instanceof Uint8Array,
    prototype: Uint8Array.prototype
};

// Global Attach
function applyPolyfills() {
    if (!window.process) window.process = fallbackProcess;
    if (!window.Buffer) window.Buffer = fallbackBuffer;
    
    // Protect window.util
    if (!window.util || !window.util.types || !window.util.types.isNativeError) {
        window.util = fallbackUtil;
    }
}

applyPolyfills();

export const process = window.process;
export const util = window.util;
export const Buffer = window.Buffer;

export default { process, util, Buffer };
