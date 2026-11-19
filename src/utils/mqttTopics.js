'use strict';

/**
 * MQTT topic helpers driven by configuration instead of hard-coded regular
 * expressions. A configured topic may use the standard MQTT wildcards:
 *   +  matches exactly one level
 *   #  matches the rest of the topic (must be the final level)
 *
 * Every wildcard is exposed as a named capture group (`p0`, `p1`, ...).
 * For CampusX topics the first wildcard is the device code.
 */

const cache = new Map();

function escapeLiteralSegment(segment) {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeSegment(value) {
  if (typeof value !== 'string') return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compileTopic(template) {
  const key = String(template || '');
  if (cache.has(key)) return cache.get(key);

  const params = [];
  const pattern = key.split('/').map((segment) => {
    if (segment === '+') {
      const name = `p${params.length}`;
      params.push(name);
      return `(?<${name}>[^/]+)`;
    }
    if (segment === '#') {
      const name = `p${params.length}`;
      params.push(name);
      return `(?<${name}>.*)`;
    }
    return escapeLiteralSegment(segment);
  }).join('/');

  const compiled = Object.freeze({
    template: key,
    pattern: `^${pattern}$`,
    regex: new RegExp(`^${pattern}$`),
    params: Object.freeze(params),
  });
  cache.set(key, compiled);
  return compiled;
}

function matchTopic(template, topic) {
  const compiled = compileTopic(template);
  const match = compiled.regex.exec(String(topic || ''));
  if (!match) return null;

  const params = {};
  for (const name of compiled.params) {
    params[name] = decodeSegment(match.groups?.[name]);
  }

  return {
    template: compiled.template,
    params,
    first: compiled.params.length ? params[compiled.params[0]] : null,
    groups: match.groups || {},
  };
}

function isTopicMatch(template, topic) {
  return matchTopic(template, topic) !== null;
}

function deviceCodeFromTopic(topic, template) {
  return matchTopic(template, topic)?.first ?? null;
}

function buildDeviceTopic(prefix, deviceCode, suffix) {
  const cleanPrefix = String(prefix || '').replace(/\/+$/, '');
  const cleanSuffix = String(suffix || '').replace(/^\/+/, '');
  const code = encodeURIComponent(String(deviceCode || '').trim());
  if (!code) throw new Error('deviceCode is required to build an MQTT topic');
  return cleanSuffix ? `${cleanPrefix}/${code}/${cleanSuffix}` : `${cleanPrefix}/${code}`;
}

module.exports = {
  compileTopic,
  matchTopic,
  isTopicMatch,
  deviceCodeFromTopic,
  buildDeviceTopic,
};
