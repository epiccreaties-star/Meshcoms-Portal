import * as baseUtil from "https://cdn.jsdelivr.net/npm/util@0.12.5/+esm";

function formatWithOptions(options, ...args) {
    return baseUtil.format(...args);
}

export default { ...baseUtil, formatWithOptions };

export const config = baseUtil.config;
export const debuglog = baseUtil.debuglog;
export const deprecate = baseUtil.deprecate;
export const format = baseUtil.format;
export const inherits = baseUtil.inherits;
export const inspect = baseUtil.inspect;
export const isArray = baseUtil.isArray;
export const isBoolean = baseUtil.isBoolean;
export const isBuffer = baseUtil.isBuffer;
export const isDate = baseUtil.isDate;
export const isError = baseUtil.isError;
export const isFunction = baseUtil.isFunction;
export const isNull = baseUtil.isNull;
export const isNullOrUndefined = baseUtil.isNullOrUndefined;
export const isNumber = baseUtil.isNumber;
export const isObject = baseUtil.isObject;
export const isPrimitive = baseUtil.isPrimitive;
export const isRegExp = baseUtil.isRegExp;
export const isString = baseUtil.isString;
export const isSymbol = baseUtil.isSymbol;
export const isUndefined = baseUtil.isUndefined;
export const log = baseUtil.log;
export const promisify = baseUtil.promisify;
export const types = baseUtil.types;
export const TextDecoder = baseUtil.TextDecoder || window.TextDecoder;
export const TextEncoder = baseUtil.TextEncoder || window.TextEncoder;
export { formatWithOptions };
