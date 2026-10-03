'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const logPath = process.env.THREADS_CI_EGRESS_LOG;
const originalFetch = globalThis.fetch;
const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function asUrl(input, protocol) {
  try {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input);
    if (input && typeof input.url === 'string') return new URL(input.url);
    const options = input && typeof input === 'object' ? input : {};
    const host = options.hostname || options.host;
    if (!host) return null;
    const hostname = String(host).replace(/^\[|\]$/g, '');
    const port = options.port ? ':' + options.port : '';
    return new URL((options.protocol || protocol || 'http:') + '//' + hostname + port + (options.path || '/'));
  } catch {
    return null;
  }
}

function appendRecord(record) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({
    ...record,
    timestamp: new Date().toISOString(),
  }) + '\n', { mode: 0o600 });
}

function isLocal(url) {
  return Boolean(url && localHosts.has(url.hostname.replace(/^\[|\]$/g, '')));
}

function isQuotaRead(url) {
  return url.hostname === 'graph.threads.net' &&
    /\/v1\.0\/[^/]+\/threads_publishing_limit$/.test(url.pathname);
}

if (typeof originalFetch === 'function') {
  globalThis.fetch = async function threadsCiGuardedFetch(input, init) {
    const url = asUrl(input, 'https:');
    if (!url || isLocal(url)) {
      return originalFetch.call(this, input, init);
    }

    if (isQuotaRead(url)) {
      appendRecord({
        kind: 'provider_stub',
        host: url.hostname,
        path: url.pathname,
        method: (init && init.method) || 'GET',
      });
      return new Response(JSON.stringify({
        data: [{
          quota_usage: 0,
          config: {
            quota_total: 250,
            quota_duration: 86400,
            reply_quota_total: 1000,
            reply_quota_duration: 86400,
          },
          reply_quota_usage: 0,
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    appendRecord({
      kind: 'blocked_node_egress',
      host: url.hostname,
      path: url.pathname,
      method: (init && init.method) || 'GET',
    });
    throw new Error('Threads CI blocked outbound fetch to ' + url.hostname + url.pathname);
  };
}

function guardHttpModule(module, protocol) {
  for (const methodName of ['request', 'get']) {
    const original = module[methodName];
    if (typeof original !== 'function') continue;
    module[methodName] = function guardedHttpRequest(...args) {
      const url = asUrl(args[0], protocol) || asUrl(args[1], protocol);
      if (!url || isLocal(url)) {
        return original.apply(this, args);
      }
      appendRecord({
        kind: 'blocked_node_egress',
        host: url.hostname,
        path: url.pathname,
        method: methodName === 'get' ? 'GET' : 'REQUEST',
      });
      throw new Error('Threads CI blocked outbound ' + protocol + ' request to ' + url.hostname + url.pathname);
    };
  }
}

guardHttpModule(http, 'http:');
guardHttpModule(https, 'https:');
